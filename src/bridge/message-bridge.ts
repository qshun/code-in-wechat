/**
 * Message Bridge Service — the core message pipeline orchestrator.
 *
 * Connects: WeChat polling → command routing → tool adapter → stream handler → WeChat sending.
 *
 * Key responsibilities:
 * - Initialize and coordinate all bridge components
 * - Route incoming messages: slash commands vs tool messages vs media
 * - Deduplicate messages to avoid double-processing
 * - Handle errors gracefully with user-friendly WeChat messages
 * - Manage async message queue for concurrent processing
 */

import type { iLinkClient } from "@/wechat/ilink-client";
import type { ToolAdapter } from "@/tools/adapter";
import type { StreamHandler } from "@/bridge/stream-handler";
import type { MediaHandler } from "@/bridge/media-handler";
import type { AuthFlow } from "@/bridge/auth-flow";
import type { WeChatMessage, iLinkSendMessageRequest, WeChatTextItem } from "@/wechat/types";
import { WeChatItemType, MESSAGE_TYPE_BOT, MESSAGE_STATE_FINISH, extractTextFromItem } from "@/wechat/types";
import type { ToolMessagePart } from "@/types/tool";
import { parseCommand, executeCommand } from "@/bridge/slash-commands";
import type { SlashCommand, CommandResult } from "@/bridge/slash-commands";
import { SessionManager } from "@/bridge/session-manager";
import { createWebServer } from "@/web/server";
import type { StatusProvider } from "@/web/server";
import type { ServerConfig } from "@/types/config";
import type { Hono } from "hono";
import { createLogger, mask } from "@/log";

/**
 * Callback type for starting the HTTP server.
 * The bridge creates the Hono app; the caller provides the server startup logic.
 */
export type ServerStarter = (app: Hono, port: number, host: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageBridgeConfig {
  /** Path to persist session/cursor data */
  sessionDbPath: string;
  /** Web server config */
  server: ServerConfig;
  /** Deduplication cache TTL in ms (default: 60000 = 1 minute) */
  dedupTtlMs?: number;
  /** Maximum concurrent message processing slots (default: 1 = sequential) */
  maxConcurrency?: number;
  /** Optional server starter callback. If not provided, web server is not started. */
  serverStarter?: ServerStarter;
}

const logger = createLogger("bridge");

interface DedupEntry {
  timestamp: number;
}

// ---------------------------------------------------------------------------
// MessageBridge
// ---------------------------------------------------------------------------

export class MessageBridge implements StatusProvider {
  private readonly client: iLinkClient;
  private readonly toolAdapter: ToolAdapter;
  private readonly streamHandler: StreamHandler;
  private readonly mediaHandler: MediaHandler;
  private readonly authFlow: AuthFlow;
  private readonly config: Required<Pick<MessageBridgeConfig, "sessionDbPath" | "dedupTtlMs" | "maxConcurrency">> & {
    server: ServerConfig;
    serverStarter?: ServerStarter;
  };

  private sessionManager!: SessionManager;
  private webServerApp!: Hono;

  private readonly dedupCache: Map<string, DedupEntry>;
  private readonly messageQueue: WeChatMessage[];
  private processing = false;
  private started = false;
  private startTime = 0;
  private lastMessageAt: number | undefined;

  constructor(
    client: iLinkClient,
    toolAdapter: ToolAdapter,
    streamHandler: StreamHandler,
    mediaHandler: MediaHandler,
    authFlow: AuthFlow,
    config: MessageBridgeConfig,
  ) {
    this.client = client;
    this.toolAdapter = toolAdapter;
    this.streamHandler = streamHandler;
    this.mediaHandler = mediaHandler;
    this.authFlow = authFlow;
    this.config = {
      sessionDbPath: config.sessionDbPath,
      dedupTtlMs: config.dedupTtlMs ?? 60_000,
      maxConcurrency: config.maxConcurrency ?? 1,
      server: config.server,
      serverStarter: config.serverStarter,
    };
    this.dedupCache = new Map();
    this.messageQueue = [];
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialize all components, start polling, and optionally start web server.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startTime = Date.now();
    logger.info("MessageBridge started");

    // Initialize tool adapter
    await this.toolAdapter.initialize();

    // Create session manager and wire up event handlers
    this.sessionManager = new SessionManager(this.client, {
      sessionDbPath: this.config.sessionDbPath,
    });

    this.sessionManager.on("command", (cmd: SlashCommand, msg: WeChatMessage) => {
      this.lastMessageAt = Date.now();
      this.sessionManager.incrementMessageCount(msg.from_user_id);
      this.handleSlashCommand(cmd, msg).catch((err) => {
        logger.error("Error handling slash command", { error: err });
      });
    });

    this.sessionManager.on("message", (msg: WeChatMessage) => {
      this.enqueueMessage(msg);
    });

    this.sessionManager.on("session-expired", () => {
      this.handleSessionExpired().catch((err) => {
        logger.error("Error handling session expiry", { error: err });
      });
    });

    // Create web server app (status dashboard)
    this.webServerApp = createWebServer(this.config.server, this);

    // Start web server if a serverStarter callback is provided
    if (this.config.serverStarter) {
      await this.config.serverStarter(
        this.webServerApp,
        this.config.server.port,
        this.config.server.host,
      );
    }

    // Start polling
    this.sessionManager.startPolling().catch((err) => {
      logger.error("Polling error", { error: err });
    });
  }

  /**
   * Gracefully shut down all components.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Stop polling
    this.sessionManager?.stopPolling();

    // Dispose tool adapter
    await this.toolAdapter.dispose();
  }

  // -----------------------------------------------------------------------
  // Message handling pipeline
  // -----------------------------------------------------------------------

  /**
   * Enqueue a message for processing.
   * Messages are processed sequentially from the queue.
   */
  private enqueueMessage(msg: WeChatMessage): void {
    this.messageQueue.push(msg);
    logger.info("Message enqueued", { from: msg.from_user_id, queueSize: this.messageQueue.length });
    this.drainQueue().catch((err) => {
      logger.error("Error draining message queue", { error: err });
    });
  }

  /**
   * Drain the message queue, processing messages sequentially.
   */
  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.messageQueue.length > 0) {
        const msg = this.messageQueue.shift()!;
        await this.handleIncomingMessage(msg);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Main message handler — the core pipeline.
   *
   * 1. Check deduplication
   * 2. Cache context_token
   * 3. Check for slash command → handle directly
   * 4. Check for media → decrypt → convert to ToolMessagePart
   * 5. Get or create session
   * 6. Send to tool adapter (streaming)
   * 7. Stream handler processes response → chunk → send via iLinkClient
   * 8. Update context_token
   */
  async handleIncomingMessage(msg: WeChatMessage): Promise<void> {
    // Step 1: Deduplication check
    const msgId = msg.msg_id ?? `${msg.from_user_id}:${msg.timestamp}:${JSON.stringify(msg.item_list)}`;
    logger.info("Handling incoming message", { from: msg.from_user_id, msgId, items: msg.item_list.length });
    logger.debug("Raw message item_list", { item_list: msg.item_list });
    if (this.isDuplicate(msgId)) {
      logger.debug("Duplicate message skipped", { msgId });
      return;
    }
    this.markProcessed(msgId);
    this.lastMessageAt = Date.now();
    this.sessionManager.incrementMessageCount(msg.from_user_id);

    try {
      // Step 2: Cache context_token
      if (msg.context_token) {
        this.sessionManager.cacheContextToken(msg.from_user_id, msg.context_token);
      }

      // Step 3: Check for slash command
      for (const item of msg.item_list) {
        if (item.type === WeChatItemType.Text) {
          const text = extractTextFromItem(item as WeChatTextItem);
          if (text) {
            const cmd = parseCommand(text);
            if (cmd) {
              await this.handleSlashCommand(cmd, msg);
              return;
            }
          }
        }
      }

      // Step 4: Extract text and media parts
      const parts: ToolMessagePart[] = [];
      let textContent = "";

      for (const item of msg.item_list) {
        if (item.type === WeChatItemType.Text) {
          const text = extractTextFromItem(item as WeChatTextItem);
          textContent += text;
        } else if (item.type === WeChatItemType.Image && "image_url" in item) {
          const img = item as { type: number; image_url: string; aes_key: string; image_size: number };
          const part = await this.handleMediaMessage(img.image_url, img.aes_key, "image", `image_${Date.now()}.jpg`, "image/jpeg");
          parts.push(part);
        } else if (item.type === WeChatItemType.File && "file_url" in item) {
          const file = item as { type: number; file_url: string; aes_key: string; file_size: number; file_name: string };
          const part = await this.handleMediaMessage(file.file_url, file.aes_key, "file", file.file_name, "application/octet-stream");
          parts.push(part);
        } else if (item.type === WeChatItemType.Voice && "voice_url" in item) {
          const voice = item as { type: number; voice_url: string; aes_key: string; voice_size: number };
          const part = await this.handleMediaMessage(voice.voice_url, voice.aes_key, "file", `voice_${Date.now()}.mp3`, "audio/mpeg");
          parts.push(part);
        } else if (item.type === WeChatItemType.Video && "video_url" in item) {
          const video = item as { type: number; video_url: string; aes_key: string; video_size: number };
          const part = await this.handleMediaMessage(video.video_url, video.aes_key, "file", `video_${Date.now()}.mp4`, "video/mp4");
          parts.push(part);
        }
      }

      logger.debug("Extracted message content", { textLength: textContent.length, mediaParts: parts.length });

      // Step 5: Get or create session
      const sessionId = await this.getOrCreateSession(msg.from_user_id);

      // Step 6: Get context_token for sending
      const contextToken = this.sessionManager.getContextToken(msg.from_user_id) ?? msg.context_token;
      if (!contextToken) {
        logger.warn("No context_token available for message", { from: msg.from_user_id, msgId });
      }

      // Step 7: Start typing indicator
      await this.streamHandler.startTyping(msg.from_user_id, contextToken);

      try {
        // Step 8: Send message to OpenCode and stream response in real-time
        // (subscribe to events first, then send prompt, then collect streaming chunks)
        logger.info("Sending message to OpenCode", { from: msg.from_user_id, sessionId, textLength: textContent.length });
        const chunks: string[] = [];
        let streamError: string | null = null;
        await this.toolAdapter.sendAndStream(sessionId, textContent, parts.length > 0 ? parts : undefined, (chunk) => {
          if (chunk.type === "text" && chunk.text) {
            chunks.push(chunk.text);
          } else if (chunk.type === "error") {
            streamError = chunk.error ?? "Unknown stream error";
            logger.error("OpenCode stream error chunk", { error: streamError });
          }
        });

        const fullText = chunks.join("");
        logger.info("Received OpenCode response", { from: msg.from_user_id, responseLength: fullText.length, hadError: !!streamError });

        // Step 9: Send response chunks to WeChat
        if (streamError) {
          // OpenCode returned an error — send a user-friendly message
          logger.warn("OpenCode returned error, sending fallback message", { from: msg.from_user_id, error: streamError });
          await this.sendTextMessage(msg.from_user_id, contextToken, "抱歉，AI 服务暂时出错，请稍后再试");
        } else if (fullText) {
          await this.sendChunkedMessage(msg.from_user_id, contextToken, fullText);
        } else {
          logger.warn("OpenCode returned empty response", { from: msg.from_user_id });
          await this.sendTextMessage(msg.from_user_id, contextToken, "抱歉，AI 未返回有效回复，请重试");
        }
      } finally {
        // Step 10: Stop typing indicator
        await this.streamHandler.stopTyping(msg.from_user_id, contextToken);
      }
    } catch (err) {
      // Error handling: send friendly message to WeChat
      const errorDetail = err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack }
        : { value: String(err) };
      logger.error("Error handling message", { from: msg.from_user_id, msgId, error: errorDetail });
      const errorMsg = "抱歉，编码工具暂时不可用，请稍后再试";
      try {
        const contextToken = this.sessionManager.getContextToken(msg.from_user_id) ?? msg.context_token;
        await this.sendTextMessage(msg.from_user_id, contextToken, errorMsg);
      } catch (sendErr) {
        logger.error("Failed to send error message to WeChat", { error: sendErr });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Slash command handling
  // -----------------------------------------------------------------------

  /**
   * Handle a slash command by executing it and sending the result.
   */
  private async handleSlashCommand(cmd: SlashCommand, msg: WeChatMessage): Promise<void> {
    const context: import("@/bridge/slash-commands").CommandContext = {
      sessionId: this.sessionManager.getContextToken(msg.from_user_id)
        ? undefined
        : undefined, // Will be populated when session management is fully wired
      currentTool: this.toolAdapter.name,
    };

    const result: CommandResult = await executeCommand(cmd, context);

    const contextToken = this.sessionManager.getContextToken(msg.from_user_id) ?? msg.context_token;
    await this.sendTextMessage(msg.from_user_id, contextToken, result.message);
  }

  // -----------------------------------------------------------------------
  // Media handling
  // -----------------------------------------------------------------------

  /**
   * Download, decrypt, and convert a media message to a ToolMessagePart.
   */
  private async handleMediaMessage(
    url: string,
    aesKey: string,
    type: "image" | "file",
    filename: string,
    mimeType: string,
  ): Promise<ToolMessagePart> {
    const encryptedBuffer = await this.mediaHandler.downloadFromCDN(url);
    const decryptedBuffer = this.mediaHandler.decryptMedia(encryptedBuffer, aesKey, type);
    return this.mediaHandler.convertToToolPart(decryptedBuffer, filename, mimeType);
  }

  // -----------------------------------------------------------------------
  // Session management
  // -----------------------------------------------------------------------

  /**
   * Get existing session ID for a user, or create a new one.
   */
  private async getOrCreateSession(userId: string): Promise<string> {
    // Check if user has an existing session
    const existingToken = this.sessionManager.getContextToken(userId);
    if (existingToken) {
      // User has a cached context token — we can try to use their existing session
      // For now, create a new session each time (sessions are managed by the tool adapter)
    }

    logger.info("Creating new OpenCode session", { userId });
    const session = await this.toolAdapter.createSession();
    return session.id;
  }

  // -----------------------------------------------------------------------
  // WeChat message sending
  // -----------------------------------------------------------------------

  /**
   * Send a text message to a WeChat user.
   */
  private async sendTextMessage(userId: string, contextToken: string, text: string): Promise<void> {
    logger.debug("Sending text message", { userId, textLength: text.length, hasContextToken: !!contextToken });
    const clientId = `code-in-wechat:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const request: iLinkSendMessageRequest = {
      msg: {
        from_user_id: "", // Bot's user ID (filled by iLink)
        to_user_id: userId,
        client_id: clientId,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        context_token: contextToken,
        item_list: [{
          type: WeChatItemType.Text,
          text_item: { text },
        }],
      },
      base_info: { channel_version: "1.0.0" },
    };
    await this.client.sendMessage(request);
    logger.info("Text message sent successfully", { userId, textLength: text.length });
  }

  /**
   * Send a long text message in chunks (≤2000 Unicode chars).
   */
  private async sendChunkedMessage(userId: string, contextToken: string, text: string): Promise<void> {
    const { chunkText } = await import("@/bridge/stream-handler");
    const chunks = chunkText(text);
    logger.info("Sending response to WeChat", { from: userId, chunks: chunks.length });

    for (const chunk of chunks) {
      await this.sendTextMessage(userId, contextToken, chunk);
    }
  }

  // -----------------------------------------------------------------------
  // Deduplication
  // -----------------------------------------------------------------------

  /**
   * Check if a message ID has already been processed.
   */
  private isDuplicate(msgId: string): boolean {
    const entry = this.dedupCache.get(msgId);
    if (!entry) return false;

    // Check if the entry has expired
    if (Date.now() - entry.timestamp > this.config.dedupTtlMs) {
      this.dedupCache.delete(msgId);
      return false;
    }

    return true;
  }

  /**
   * Mark a message ID as processed.
   */
  private markProcessed(msgId: string): void {
    this.dedupCache.set(msgId, { timestamp: Date.now() });

    // Prune expired entries periodically (every 100 messages)
    if (this.dedupCache.size > 100) {
      const now = Date.now();
      for (const [key, entry] of this.dedupCache) {
        if (now - entry.timestamp > this.config.dedupTtlMs) {
          this.dedupCache.delete(key);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Session expiry
  // -----------------------------------------------------------------------

  /**
   * Handle session expiry by re-authenticating.
   */
  private async handleSessionExpired(): Promise<void> {
    logger.info("Session expired, attempting re-authentication...");
    const result = await this.authFlow.login();
    if (result.success) {
      logger.info("Re-authentication successful, restarting polling...");
      this.sessionManager.startPolling().catch((err) => {
        logger.error("Failed to restart polling after re-auth", { error: err });
      });
    } else {
      logger.error("Re-authentication failed", { error: result.error });
    }
  }

  // -----------------------------------------------------------------------
  // StatusProvider implementation
  // -----------------------------------------------------------------------

  getBotStatus() {
    const status = {
      online: this.started,
      uptime: this.started ? Date.now() - this.startTime : 0,
      lastMessageAt: this.lastMessageAt,
      polling: this.sessionManager?.getPollingInfo(),
    };
    logger.debug("getBotStatus called", {
      online: status.online,
      lastMessageAt: status.lastMessageAt,
      pollingActive: status.polling?.isActive,
      pollCount: status.polling?.pollCount,
    });
    return status;
  }

  getSessions() {
    const sessions = this.sessionManager?.getActiveSessions() ?? [];
    logger.debug("getSessions called", { count: sessions.length, ids: sessions.map(s => s.id) });
    return sessions;
  }

  getQRCode() {
    return this.authFlow.getCurrentQRCode();
  }

  getPollingInfo() {
    return this.sessionManager?.getPollingInfo();
  }
}