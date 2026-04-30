/**
 * TDD tests for MessageBridge.
 *
 * Covers:
 * 1. Full text pipeline: incoming text → tool → streamed response → chunked messages
 * 2. Slash command routing: /help returns help text directly
 * 3. Media message pipeline: incoming image → decrypt → tool adapter with file part
 * 4. Error handling: tool error → friendly error message sent to WeChat
 * 5. Message deduplication: same message not processed twice
 * 6. Context token flow: received token → cached → used in response
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageBridge } from "../../src/bridge/message-bridge";
import type { iLinkClient } from "../../src/wechat/ilink-client";
import type { ToolAdapter } from "../../src/tools/adapter";
import type { StreamHandler } from "../../src/bridge/stream-handler";
import type { MediaHandler } from "../../src/bridge/media-handler";
import type { AuthFlow } from "../../src/bridge/auth-flow";
import type { WeChatMessage } from "../../src/wechat/types";
import { WeChatItemType, MESSAGE_TYPE_BOT, MESSAGE_STATE_FINISH } from "../../src/wechat/types";
import type { ToolSession, ToolResponse, StreamChunk, ToolMessagePart } from "../../src/types/tool";
import type { SlashCommand, CommandResult } from "../../src/bridge/slash-commands";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock fs for SessionManager cursor persistence
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{"get_updates_buf":""}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("path", () => ({
  dirname: vi.fn((p: string) => {
    const sep = p.includes("\\") ? "\\" : "/";
    const parts = p.split(sep);
    return parts.slice(0, -1).join(sep);
  }),
  join: vi.fn((...paths: string[]) => paths.join("/")),
  sep: "/",
}));

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockClient(): iLinkClient {
  return {
    getUpdates: vi.fn(async () => ({
      ret: 0,
      msgs: [],
      get_updates_buf: "buf-1",
      longpolling_timeout_ms: 30000,
    })),
    sendMessage: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
    getConfig: vi.fn(async () => ({ typing_ticket: "ticket-1" })),
    getUploadUrl: vi.fn(),
    getBotQRCode: vi.fn(),
    getQRCodeStatus: vi.fn(),
  } as unknown as iLinkClient;
}

function createMockToolAdapter(): ToolAdapter {
  return {
    name: "mock-adapter",
    initialize: vi.fn(async () => {}),
    createSession: vi.fn(async (title?: string): Promise<ToolSession> => ({
      id: "session-1",
      title,
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
    sendMessage: vi.fn(async (sessionId: string, content: string, parts?: ToolMessagePart[]): Promise<ToolResponse> => ({
      id: "msg-1",
      sessionId,
      text: `Response to: ${content}`,
      parts: [{ type: "text", text: `Response to: ${content}` }],
    })),
    streamResponse: vi.fn(async (sessionId: string, onChunk: (chunk: StreamChunk) => void) => {
      onChunk({ type: "text", text: "Hello " });
      onChunk({ type: "text", text: "World" });
      onChunk({ type: "done" });
    }),
    sendAndStream: vi.fn(async (sessionId: string, content: string, parts: ToolMessagePart[] | undefined, onChunk: (chunk: StreamChunk) => void) => {
      onChunk({ type: "text", text: "Hello " });
      onChunk({ type: "text", text: "World" });
      onChunk({ type: "done" });
    }),
    abortSession: vi.fn(async () => {}),
    getSessionInfo: vi.fn(async () => ({
      id: "session-1",
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
    dispose: vi.fn(async () => {}),
  } as unknown as ToolAdapter;
}

function createMockStreamHandler(): StreamHandler {
  return {
    startTyping: vi.fn(async () => {}),
    stopTyping: vi.fn(async () => {}),
    handleStream: vi.fn(async () => "Hello World"),
  } as unknown as StreamHandler;
}

function createMockMediaHandler(): MediaHandler {
  return {
    downloadFromCDN: vi.fn(async () => Buffer.from("fake-media-data")),
    decryptMedia: vi.fn(() => Buffer.from("decrypted-media-data")),
    convertToToolPart: vi.fn((_buffer: Buffer, filename: string, mimeType: string) => ({
      type: "file" as const,
      mime: mimeType,
      url: `data:${mimeType};base64,ZmFrZS1tZWRpYS1kYXRh`,
      filename,
    })),
    encryptMedia: vi.fn(),
    uploadToCDN: vi.fn(),
  } as unknown as MediaHandler;
}

function createMockAuthFlow(): AuthFlow {
  return {
    login: vi.fn(async () => ({ success: true, botToken: "new-token", baseUrl: "https://example.com" })),
    restoreSession: vi.fn(async () => ({ success: true, botToken: "restored-token", baseUrl: "https://example.com" })),
    logout: vi.fn(async () => {}),
    isAuthenticated: vi.fn(() => true),
    getState: vi.fn(() => "confirmed"),
  } as unknown as AuthFlow;
}

function createMockMessage(overrides: Partial<WeChatMessage> = {}): WeChatMessage {
  return {
    from_user_id: "user-1",
    to_user_id: "bot-1",
    message_type: 1,
    message_state: 0,
    context_token: "ctx-token-1",
    item_list: [{ type: WeChatItemType.Text, text: "Hello" }],
    msg_id: "msg-1",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageBridge", () => {
  let mockClient: iLinkClient;
  let mockToolAdapter: ToolAdapter;
  let mockStreamHandler: StreamHandler;
  let mockMediaHandler: MediaHandler;
  let mockAuthFlow: AuthFlow;

  const baseConfig = {
    sessionDbPath: "/tmp/test-session.json",
    server: { port: 3000, host: "localhost" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    mockToolAdapter = createMockToolAdapter();
    mockStreamHandler = createMockStreamHandler();
    mockMediaHandler = createMockMediaHandler();
    mockAuthFlow = createMockAuthFlow();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Test 1: Full text pipeline
  // -----------------------------------------------------------------------

  test("full text pipeline: incoming text → tool → streamed response → chunked messages", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      baseConfig,
    );

    // Manually set up session manager (normally done in start())
    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    const msg = createMockMessage({
      item_list: [{ type: WeChatItemType.Text, text: "Write a hello world function" }],
      msg_id: "msg-text-1",
    });

    await bridge.handleIncomingMessage(msg);

    // Should have called sendAndStream on the tool adapter
    expect(mockToolAdapter.createSession).toHaveBeenCalled();
    expect(mockToolAdapter.sendAndStream).toHaveBeenCalled();

    // Should have started and stopped typing
    expect(mockStreamHandler.startTyping).toHaveBeenCalledWith("user-1", "ctx-token-1");
    expect(mockStreamHandler.stopTyping).toHaveBeenCalledWith("user-1", "ctx-token-1");

    // Should have sent a message to WeChat
    expect(mockClient.sendMessage).toHaveBeenCalled();
    const sentMsg = (mockClient.sendMessage as any).mock.calls[0][0];
    expect(sentMsg.msg.to_user_id).toBe("user-1");
    expect(sentMsg.msg.context_token).toBe("ctx-token-1");
    expect(sentMsg.msg.item_list[0].type).toBe(WeChatItemType.Text);
  });

  // -----------------------------------------------------------------------
  // Test 2: Slash command routing
  // -----------------------------------------------------------------------

  test("slash command routing: /help returns help text directly", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      baseConfig,
    );

    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    const msg = createMockMessage({
      item_list: [{ type: WeChatItemType.Text, text: "/help" }],
      msg_id: "msg-help-1",
    });

    await bridge.handleIncomingMessage(msg);

    // Should NOT have called the tool adapter
    expect(mockToolAdapter.sendAndStream).not.toHaveBeenCalled();
    expect(mockToolAdapter.createSession).not.toHaveBeenCalled();

    // Should have sent a message with help text
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = (mockClient.sendMessage as any).mock.calls[0][0];
    expect(sentMsg.msg.item_list[0].text_item.text).toContain("Available commands");
  });

  // -----------------------------------------------------------------------
  // Test 3: Media message pipeline
  // -----------------------------------------------------------------------

  test("media message pipeline: incoming image → decrypt → tool adapter with file part", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      baseConfig,
    );

    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    const msg = createMockMessage({
      item_list: [{
        type: WeChatItemType.Image,
        image_url: "https://cdn.example.com/image.jpg",
        aes_key: "dGVzdGtleQ==",
        image_size: 1024,
      }],
      msg_id: "msg-image-1",
    });

    await bridge.handleIncomingMessage(msg);

    // Should have downloaded and decrypted the media
    expect(mockMediaHandler.downloadFromCDN).toHaveBeenCalledWith("https://cdn.example.com/image.jpg");
    expect(mockMediaHandler.decryptMedia).toHaveBeenCalled();
    expect(mockMediaHandler.convertToToolPart).toHaveBeenCalled();

    // Should have called the tool adapter
    expect(mockToolAdapter.createSession).toHaveBeenCalled();
    expect(mockToolAdapter.sendAndStream).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 4: Error handling
  // -----------------------------------------------------------------------

  test("error handling: tool error → friendly error message sent to WeChat", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      baseConfig,
    );

    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    // Make the tool adapter throw
    (mockToolAdapter.sendAndStream as any).mockRejectedValueOnce(new Error("Tool connection lost"));

    const msg = createMockMessage({
      item_list: [{ type: WeChatItemType.Text, text: "Hello" }],
      msg_id: "msg-error-1",
    });

    await bridge.handleIncomingMessage(msg);

    // Should have sent a friendly error message
    expect(mockClient.sendMessage).toHaveBeenCalled();
    const sentMsg = (mockClient.sendMessage as any).mock.calls[0][0];
    expect(sentMsg.msg.item_list[0].text_item.text).toBe("抱歉，编码工具暂时不可用，请稍后再试");
  });

  // -----------------------------------------------------------------------
  // Test 5: Message deduplication
  // -----------------------------------------------------------------------

  test("message deduplication: same message not processed twice", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      baseConfig,
    );

    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    const msg = createMockMessage({
      msg_id: "msg-dedup-1",
      item_list: [{ type: WeChatItemType.Text, text: "Hello" }],
    });

    // Process the same message twice
    await bridge.handleIncomingMessage(msg);
    await bridge.handleIncomingMessage(msg);

    // Tool adapter should only have been called once (createSession + sendAndStream)
    expect(mockToolAdapter.createSession).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 6: Context token flow
  // -----------------------------------------------------------------------

  test("context token flow: received token → cached → used in response", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      baseConfig,
    );

    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    const msg = createMockMessage({
      from_user_id: "user-ctx-1",
      context_token: "my-special-token",
      item_list: [{ type: WeChatItemType.Text, text: "Hello" }],
      msg_id: "msg-ctx-1",
    });

    await bridge.handleIncomingMessage(msg);

    // The context token should be cached and used in the response
    expect(mockClient.sendMessage).toHaveBeenCalled();
    const sentMsg = (mockClient.sendMessage as any).mock.calls[0][0];
    expect(sentMsg.msg.context_token).toBe("my-special-token");

    // Verify it was also cached in the session manager
    const cachedToken = sessionManager.getContextToken("user-ctx-1");
    expect(cachedToken).toBe("my-special-token");
  });

  // -----------------------------------------------------------------------
  // Test 7: Long text is chunked
  // -----------------------------------------------------------------------

  test("long text response is chunked into multiple messages", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      baseConfig,
    );

    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    // Make sendAndStream produce a long text
    const longText = "A".repeat(3000); // Exceeds 2000 char chunk limit
    (mockToolAdapter.sendAndStream as any).mockImplementationOnce(
      async (_sessionId: string, _content: string, _parts: ToolMessagePart[] | undefined, onChunk: (chunk: StreamChunk) => void) => {
        onChunk({ type: "text", text: longText });
        onChunk({ type: "done" });
      },
    );

    const msg = createMockMessage({
      item_list: [{ type: WeChatItemType.Text, text: "Write a long essay" }],
      msg_id: "msg-long-1",
    });

    await bridge.handleIncomingMessage(msg);

    // Should have sent 2 messages (3000 chars / 2000 per chunk = 2 chunks)
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Test 8: Mixed text and media message
  // -----------------------------------------------------------------------

  test("mixed text and media message: both parts processed", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      baseConfig,
    );

    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    const msg = createMockMessage({
      item_list: [
        { type: WeChatItemType.Text, text: "What is in this image?" },
        {
          type: WeChatItemType.Image,
          image_url: "https://cdn.example.com/photo.jpg",
          aes_key: "aW1hZ2VrZXk=",
          image_size: 2048,
        },
      ],
      msg_id: "msg-mixed-1",
    });

    await bridge.handleIncomingMessage(msg);

    // Should have processed the media
    expect(mockMediaHandler.downloadFromCDN).toHaveBeenCalledWith("https://cdn.example.com/photo.jpg");
    expect(mockMediaHandler.decryptMedia).toHaveBeenCalled();

    // Should have called the tool adapter
    expect(mockToolAdapter.sendAndStream).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 9: Deduplication cache expiry
  // -----------------------------------------------------------------------

  test("deduplication cache expires after TTL", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      { ...baseConfig, dedupTtlMs: 100 }, // 100ms TTL for testing
    );

    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    const msg = createMockMessage({
      msg_id: "msg-ttl-1",
      item_list: [{ type: WeChatItemType.Text, text: "Hello" }],
    });

    // Process once
    await bridge.handleIncomingMessage(msg);
    expect(mockToolAdapter.createSession).toHaveBeenCalledTimes(1);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Process again — should NOT be deduplicated now
    await bridge.handleIncomingMessage(msg);
    expect(mockToolAdapter.createSession).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Test 10: /new and /reset slash commands
  // -----------------------------------------------------------------------

  test("/new slash command returns success message", async () => {
    const bridge = new MessageBridge(
      mockClient,
      mockToolAdapter,
      mockStreamHandler,
      mockMediaHandler,
      mockAuthFlow,
      baseConfig,
    );

    const { SessionManager } = await import("../../src/bridge/session-manager");
    const sessionManager = new SessionManager(mockClient, { sessionDbPath: "/tmp/test-session.json" });
    (bridge as any).sessionManager = sessionManager;

    const msg = createMockMessage({
      item_list: [{ type: WeChatItemType.Text, text: "/new" }],
      msg_id: "msg-new-1",
    });

    await bridge.handleIncomingMessage(msg);

    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = (mockClient.sendMessage as any).mock.calls[0][0];
    expect(sentMsg.msg.item_list[0].text_item.text).toContain("New conversation started");
  });
});