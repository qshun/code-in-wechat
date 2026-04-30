/**
 * Session Manager for WeChat-Tool session state management.
 *
 * Key responsibilities:
 * - Long-polling loop via iLinkClient.getUpdates()
 * - Route incoming messages (slash command vs tool message)
 * - Cache context_tokens with 24h TTL
 * - Persist get_updates_buf cursor across restarts
 * - Handle session expiry (ret=-14) by clearing state and emitting event
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import type { iLinkClient } from "@/wechat/ilink-client";
import type { WeChatMessage } from "@/wechat/types";
import { SessionExpiredError, WeChatItemType, extractTextFromItem } from "@/wechat/types";
import { parseCommand } from "@/bridge/slash-commands";
import { createLogger } from "@/log";

const logger = createLogger("session");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionState {
  contextToken: string;
  expiresAt: number;
  sessionId?: string;
  lastActivity: number;
  messageCount: number;
  createdAt: number;
}

export interface SessionManagerOptions {
  sessionDbPath: string;
  /** Delay in ms before retrying after a non-fatal error (default: 1000) */
  retryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager extends EventEmitter {
  private readonly client: iLinkClient;
  private readonly sessionDbPath: string;
  private readonly retryDelayMs: number;
  private readonly sessions: Map<string, SessionState>;
  private polling: boolean;
  private cursor: string;
  private messageQueue: WeChatMessage[];

  /** Timestamp of last successful poll (getUpdates that didn't throw). */
  private lastPollAt: number | undefined;
  /** Total number of successful poll cycles. */
  private pollCount: number;
  /** Total number of messages received across all polls. */
  private totalMessagesReceived: number;
  /** Total number of polling errors encountered. */
  private pollErrorCount: number;

  constructor(client: iLinkClient, options: SessionManagerOptions) {
    super();
    this.client = client;
    this.sessionDbPath = options.sessionDbPath;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.sessions = new Map();
    this.polling = false;
    this.cursor = "";
    this.messageQueue = [];
    this.lastPollAt = undefined;
    this.pollCount = 0;
    this.totalMessagesReceived = 0;
    this.pollErrorCount = 0;
  }

  // -----------------------------------------------------------------------
  // Polling lifecycle
  // -----------------------------------------------------------------------

  /**
   * Begin long-polling loop via iLinkClient.getUpdates().
   * Loads the persisted cursor, then enters a while(polling) loop.
   * Stops on stopPolling() or SessionExpiredError.
   */
  async startPolling(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.cursor = this.loadCursor();
    logger.info("Starting polling loop");

    while (this.polling) {
      try {
        const response = await this.client.getUpdates(this.cursor);
        this.cursor = response.get_updates_buf;
        this.persistCursor(this.cursor);

        this.lastPollAt = Date.now();
        this.pollCount++;

        this.totalMessagesReceived += response.msgs.length;

        if (this.pollCount <= 3 || response.msgs.length > 0) {
          logger.info("Polling cycle completed", { pollCount: this.pollCount, messages: response.msgs.length, cursor: this.cursor.substring(0, 20) + "..." });
        }

        // Queue all incoming messages
        for (const msg of response.msgs) {
          logger.debug("Processing message", { from: msg.from_user_id, type: msg.message_type, items: msg.item_list.length });
          this.messageQueue.push(msg);
        }

        // Drain the queue sequentially
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift()!;
          await this.processMessage(msg);
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          this.handleSessionExpired();
          return;
        }
        // Non-fatal error: wait then retry
        this.pollErrorCount++;
        logger.error("Polling error", { error: err instanceof Error ? { message: err.message, stack: err.stack } : err });
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    logger.info("Polling stopped");
  }

  /**
   * Gracefully stop the polling loop.
   * The current getUpdates() call will complete, then the loop exits.
   */
  stopPolling(): void {
    this.polling = false;
  }

  // -----------------------------------------------------------------------
  // Message routing
  // -----------------------------------------------------------------------

  /**
   * Route an incoming message:
   * - If text starts with "/", emit "command" event with parsed SlashCommand
   * - Otherwise, emit "message" event for tool processing
   *
   * Also caches the context_token from every incoming message.
   */
  async processMessage(msg: WeChatMessage): Promise<void> {
    // Cache context_token from incoming message
    if (msg.context_token) {
      this.cacheContextToken(msg.from_user_id, msg.context_token);
    }

    // Check for slash command in text items
    for (const item of msg.item_list) {
      if (item.type === WeChatItemType.Text) {
        const text = extractTextFromItem(item as import("@/wechat/types").WeChatTextItem);
        if (text) {
          const command = parseCommand(text);
          if (command) {
            logger.info("Slash command detected", { from: msg.from_user_id, command: command.name });
            this.emit("command", command, msg);
            return;
          }
        }
      }
    }

    // Regular message — emit for tool processing
    logger.info("Regular message received", { from: msg.from_user_id, items: msg.item_list.length });
    this.emit("message", msg);
  }

  // -----------------------------------------------------------------------
  // Context token caching (24h TTL)
  // -----------------------------------------------------------------------

  /**
   * Store a context_token for a user with 24h TTL.
   * Preserves sessionId if a session already exists for this user.
   */
  cacheContextToken(userId: string, token: string): void {
    const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    const existing = this.sessions.get(userId);
    this.sessions.set(userId, {
      contextToken: token,
      expiresAt: Date.now() + TTL_MS,
      sessionId: existing?.sessionId,
      lastActivity: Date.now(),
      messageCount: existing?.messageCount ?? 0,
      createdAt: existing?.createdAt ?? Date.now(),
    });
    logger.debug("Cached context_token", { userId, expiresAt: this.sessions.get(userId)!.expiresAt });
  }

  /**
   * Increment the message count for a user's session.
   * Creates a session entry if one doesn't exist yet.
   */
  incrementMessageCount(userId: string): void {
    const state = this.sessions.get(userId);
    if (state) {
      state.messageCount++;
      state.lastActivity = Date.now();
    } else {
      this.sessions.set(userId, {
        contextToken: "",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        lastActivity: Date.now(),
        messageCount: 1,
        createdAt: Date.now(),
      });
    }
  }

  /**
   * Get all active (non-expired) sessions.
   * Returns an array of objects matching the web server's SessionInfo interface.
   */
  getActiveSessions(): Array<{ id: string; tool: string; messageCount: number; createdAt: number }> {
    const now = Date.now();
    const result: Array<{ id: string; tool: string; messageCount: number; createdAt: number }> = [];
    for (const [userId, state] of this.sessions) {
      if (now < state.expiresAt) {
        result.push({
          id: userId,
          tool: "opencode",
          messageCount: state.messageCount,
          createdAt: state.createdAt,
        });
      }
    }
    return result;
  }

  /**
   * Retrieve a cached context_token for a user.
   * Returns undefined if no token exists or if it has expired.
   */
  getContextToken(userId: string): string | undefined {
    const state = this.sessions.get(userId);
    if (!state) return undefined;
    if (Date.now() >= state.expiresAt) {
      this.sessions.delete(userId);
      return undefined;
    }
    return state.contextToken;
  }

  // -----------------------------------------------------------------------
  // Cursor persistence (JSON file)
  // -----------------------------------------------------------------------

  /**
   * Persist get_updates_buf to a JSON file.
   * Best-effort: silently ignores write errors.
   */
  persistCursor(cursor: string): void {
    try {
      const dir = path.dirname(this.sessionDbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.sessionDbPath,
        JSON.stringify({ get_updates_buf: cursor }),
        "utf-8",
      );
    } catch {
      // Best-effort persistence — silently ignore errors
    }
  }

  /**
   * Load persisted cursor from the JSON file.
   * Returns empty string if file doesn't exist or is invalid.
   */
  loadCursor(): string {
    try {
      if (fs.existsSync(this.sessionDbPath)) {
        const raw = fs.readFileSync(this.sessionDbPath, "utf-8");
        const data = JSON.parse(raw);
        return data.get_updates_buf ?? "";
      }
    } catch {
      // Return empty string on any error
    }
    return "";
  }

  // -----------------------------------------------------------------------
  // Session expiry
  // -----------------------------------------------------------------------

  /**
   * Clear all cached state and emit "session-expired" event.
   * Called when the iLink API returns ret=-14 (session expired).
   */
  handleSessionExpired(): void {
    logger.warn("Session expired, clearing state");
    this.sessions.clear();
    this.cursor = "";
    this.polling = false;
    this.messageQueue = [];
    this.emit("session-expired");
  }

  // -----------------------------------------------------------------------
  // Diagnostic info
  // -----------------------------------------------------------------------

  /**
   * Return polling diagnostics for the status dashboard.
   */
  getPollingInfo(): {
    isActive: boolean;
    lastPollAt: number | undefined;
    pollCount: number;
    totalMessagesReceived: number;
    pollErrorCount: number;
  } {
    return {
      isActive: this.polling,
      lastPollAt: this.lastPollAt,
      pollCount: this.pollCount,
      totalMessagesReceived: this.totalMessagesReceived,
      pollErrorCount: this.pollErrorCount,
    };
  }
}