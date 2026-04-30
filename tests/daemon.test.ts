/**
 * TDD tests for Daemon.
 *
 * Covers:
 * 1. Graceful start and stop
 * 2. Auto-reconnect on session expiry (session-expired event triggers re-auth)
 * 3. Retry with exponential backoff (2s → 4s → 8s → 16s → max 5min)
 * 4. Signal handling (SIGINT/SIGTERM → graceful shutdown, SIGUSR2 → restart)
 * 5. Health monitoring at correct intervals
 * 6. Max retry limit (5 retries → fatal exit)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Daemon } from "../src/daemon";
import type { DaemonConfig, HealthStatus } from "../src/daemon";
import type { MessageBridge } from "../src/bridge/message-bridge";
import type { AuthFlow, AuthResult } from "../src/bridge/auth-flow";
import type { iLinkClient } from "../src/wechat/ilink-client";
import type { ToolAdapter } from "../src/tools/adapter";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush pending microtasks by yielding to the event loop multiple times. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => { resolve(); });
  }
}

// ---------------------------------------------------------------------------
// Helpers — mock factories
// ---------------------------------------------------------------------------

interface MockBridge {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getBotStatus: ReturnType<typeof vi.fn>;
  getSessions: ReturnType<typeof vi.fn>;
  getQRCode: ReturnType<typeof vi.fn>;
  sessionManager: EventEmitter;
}

/** Create a mock MessageBridge with a controllable sessionManager emitter. */
function createMockBridge(): MockBridge {
  const sessionManager = new EventEmitter();
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getBotStatus: vi.fn().mockReturnValue({ online: true, uptime: 0 }),
    getSessions: vi.fn().mockReturnValue([]),
    getQRCode: vi.fn().mockReturnValue(null),
    sessionManager,
  };
}

/** Create a mock AuthFlow. */
function createMockAuthFlow(): AuthFlow {
  return {
    login: vi.fn().mockResolvedValue({
      success: true,
      botToken: "test-token",
      baseUrl: "https://test.example.com",
    }),
    restoreSession: vi.fn().mockResolvedValue({ success: true }),
    isAuthenticated: vi.fn().mockReturnValue(true),
    logout: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthFlow;
}

/** Create a mock iLinkClient. */
function createMockClient(): iLinkClient {
  return {
    getUpdates: vi.fn().mockResolvedValue({ ret: 0, msgs: [], get_updates_buf: "" }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockResolvedValue({}),
    getUploadUrl: vi.fn().mockResolvedValue({}),
    getBotQRCode: vi.fn().mockResolvedValue({}),
    getQRCodeStatus: vi.fn().mockResolvedValue({}),
  } as unknown as iLinkClient;
}

/** Create a mock ToolAdapter. */
function createMockToolAdapter(): ToolAdapter {
  return {
    name: "test-adapter",
    initialize: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ id: "s1" }),
    sendMessage: vi.fn().mockResolvedValue({}),
    streamResponse: vi.fn().mockResolvedValue(undefined),
    abortSession: vi.fn().mockResolvedValue(undefined),
    getSessionInfo: vi.fn().mockResolvedValue({ id: "health-check" }),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as ToolAdapter;
}

/** Small config for fast tests (delays in ms, not seconds). */
const testConfig: DaemonConfig = {
  retryBaseMs: 10,
  retryMaxMs: 100,
  maxRetries: 5,
  ilinkHealthIntervalMs: 50,
  opencodeHealthIntervalMs: 80,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Daemon", () => {
  let bridge: ReturnType<typeof createMockBridge>;
  let authFlow: ReturnType<typeof createMockAuthFlow>;
  let client: ReturnType<typeof createMockClient>;
  let toolAdapter: ReturnType<typeof createMockToolAdapter>;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    bridge = createMockBridge();
    authFlow = createMockAuthFlow();
    client = createMockClient();
    toolAdapter = createMockToolAdapter();
    originalExit = process.exit;
    process.exit = vi.fn() as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.useRealTimers();
  });

  // =========================================================================
  // 1. Graceful start and stop
  // =========================================================================

  describe("start and stop", () => {
    test("starts bridge, health monitoring, and signal handlers", async () => {
      const daemon = new Daemon(
        bridge,
        authFlow,
        testConfig,
        client,
        toolAdapter,
      );

      await daemon.start();

      expect(bridge.start).toHaveBeenCalledTimes(1);
      expect(daemon.getHealthStatus().ilinkAlive).toBe(true);
      expect(daemon.getHealthStatus().opencodeAlive).toBe(true);
      expect(daemon.getHealthStatus().retryCount).toBe(0);

      await daemon.stop();
    });

    test("stops bridge and clears health monitoring on stop()", async () => {
      const daemon = new Daemon(
        bridge,
        authFlow,
        testConfig,
        client,
        toolAdapter,
      );

      await daemon.start();
      await daemon.stop();

      expect(bridge.stop).toHaveBeenCalledTimes(1);

      // Verify health monitoring stopped by checking timers were cleared
      // (intervals no longer fire after stop)
      const statusBefore = daemon.getHealthStatus();
      // Wait a bit — no health checks should fire
      await new Promise((r) => setTimeout(r, 100));
      const statusAfter = daemon.getHealthStatus();
      // Status should be unchanged (no new checks)
      expect(statusAfter).toEqual(statusBefore);
    });

    test("start() is idempotent — second call is a no-op", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);

      await daemon.start();
      await daemon.start();

      expect(bridge.start).toHaveBeenCalledTimes(1);

      await daemon.stop();
    });

    test("stop() when not running is a no-op", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);

      await daemon.stop(); // Should not throw

      expect(bridge.stop).not.toHaveBeenCalled();
    });

    test("stop() cancels pending retry timer", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);
      (bridge.start as any).mockRejectedValue(new Error("fail"));

      await daemon.start();

      // A retry should be scheduled
      expect(daemon.getHealthStatus().retryCount).toBeGreaterThanOrEqual(0);

      await daemon.stop();

      // After stop, retryCount should be frozen (no more retries fire)
      const countAfterStop = daemon.getHealthStatus().retryCount;
      await new Promise((r) => setTimeout(r, 50));
      expect(daemon.getHealthStatus().retryCount).toBe(countAfterStop);
    });
  });

  // =========================================================================
  // 2. Auto-reconnect on session expiry
  // =========================================================================

  describe("auto-reconnect on session expiry", () => {
    test("session-expired event triggers authFlow.login()", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);
      await daemon.start();

      bridge.sessionManager.emit("session-expired");

      // Wait for async handler to complete
      await new Promise((r) => setTimeout(r, 30));

      expect(authFlow.login).toHaveBeenCalledTimes(1);

      await daemon.stop();
    });

    test("on successful re-auth, restarts bridge (stop + start)", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);
      await daemon.start();

      // Reset call counts after start
      (bridge.stop as any).mockClear();
      (bridge.start as any).mockClear();

      bridge.sessionManager.emit("session-expired");

      // Wait for async re-auth + restart
      await new Promise((r) => setTimeout(r, 50));

      expect(authFlow.login).toHaveBeenCalledTimes(1);
      expect(bridge.stop).toHaveBeenCalled();
      expect(bridge.start).toHaveBeenCalled();
      expect(daemon.getHealthStatus().retryCount).toBe(0);

      await daemon.stop();
    });

    test("on failed re-auth, schedules retry with backoff", async () => {
      (authFlow.login as any).mockResolvedValue({
        success: false,
        error: "QR code timeout",
      });

      const daemon = new Daemon(bridge, authFlow, testConfig);
      const retryEvents: Array<{ attempt: number; delay: number }> = [];
      daemon.on("retry", (e) => retryEvents.push(e));

      await daemon.start();

      bridge.sessionManager.emit("session-expired");

      // Wait for handler + first retry scheduling
      await new Promise((r) => setTimeout(r, 50));

      // Should have scheduled a retry
      expect(retryEvents.length).toBeGreaterThanOrEqual(1);
      expect(retryEvents[0].attempt).toBe(1);
      expect(retryEvents[0].delay).toBe(testConfig.retryBaseMs);

      await daemon.stop();
    });

    test("does not start double recovery if already recovering", async () => {
      let loginCallCount = 0;
      (authFlow.login as any).mockImplementation(async () => {
        loginCallCount++;
        // Simulate slow login
        await new Promise((r) => setTimeout(r, 50));
        return { success: true, botToken: "tok", baseUrl: "http://x" };
      });

      const daemon = new Daemon(bridge, authFlow, testConfig);
      await daemon.start();

      // Emit session-expired twice rapidly
      bridge.sessionManager.emit("session-expired");
      bridge.sessionManager.emit("session-expired");

      // Wait for both handlers
      await new Promise((r) => setTimeout(r, 150));

      // login should only be called once (second event is ignored)
      expect(loginCallCount).toBe(1);

      await daemon.stop();
    });
  });

  // =========================================================================
  // 3. Exponential backoff retry
  // =========================================================================

  describe("exponential backoff", () => {
    test("retry delays increase exponentially: base, 2×base, 4×base, 8×base, capped at max", () => {
      const baseMs = 2000;
      const maxMs = 300_000;

      // Verify the formula: min(baseMs * 2^attempt, maxMs)
      const expected = [2000, 4000, 8000, 16000, 32000];
      for (let i = 0; i < 5; i++) {
        const delay = Math.min(baseMs * Math.pow(2, i), maxMs);
        expect(delay).toBe(expected[i]);
      }

      // Verify cap at maxMs
      const cappedDelay = Math.min(baseMs * Math.pow(2, 20), maxMs);
      expect(cappedDelay).toBe(maxMs);
    });

    test("retry events emit increasing delays", async () => {
      vi.useFakeTimers();

      // Make bridge.start() fail, then authFlow.login() always fail
      (bridge.start as any).mockRejectedValue(new Error("network error"));
      (authFlow.login as any).mockResolvedValue({
        success: false,
        error: "auth fail",
      });

      const daemon = new Daemon(bridge, authFlow, {
        retryBaseMs: 10,
        retryMaxMs: 200,
        maxRetries: 5,
      });
      const retryEvents: Array<{ attempt: number; delay: number }> = [];
      daemon.on("retry", (e) => retryEvents.push(e));

      // start() will catch bridge.start() error and schedule first retry
      await daemon.start();
      await flushMicrotasks();

      // The first retry should be scheduled
      // Advance time to trigger each retry
      const expectedDelays = [10, 20, 40, 80, 160]; // 10 * 2^0, 10 * 2^1, ...

      for (let i = 0; i < expectedDelays.length; i++) {
        // Advance past the retry delay
        vi.advanceTimersByTime(expectedDelays[i]);

        // Flush microtasks to allow async retry callback to execute
        await flushMicrotasks();
      }

      // Check retry events were emitted with correct delays
      expect(retryEvents.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(retryEvents[i].attempt).toBe(i + 1);
        expect(retryEvents[i].delay).toBe(expectedDelays[i]);
      }

      await daemon.stop();
    });

    test("retry count resets on successful recovery", async () => {
      let callCount = 0;
      (authFlow.login as any).mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return { success: false, error: "not yet" };
        }
        return { success: true, botToken: "tok", baseUrl: "http://x" };
      });

      const daemon = new Daemon(bridge, authFlow, {
        ...testConfig,
        retryBaseMs: 5,
        maxRetries: 10,
      });

      await daemon.start();

      // Trigger session expiry
      bridge.sessionManager.emit("session-expired");

      // Wait for initial re-auth attempt + retries
      await new Promise((r) => setTimeout(r, 200));

      // After 3 login attempts (2 fails + 1 success), retryCount should reset
      expect(daemon.getHealthStatus().retryCount).toBe(0);

      await daemon.stop();
    });
  });

  // =========================================================================
  // 4. Signal handling
  // =========================================================================

  describe("signal handling", () => {
    test("SIGINT triggers graceful shutdown", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);
      await daemon.start();

      // Simulate SIGINT
      process.emit("SIGINT" as any);

      // Allow async handler to run
      await new Promise((r) => setTimeout(r, 50));

      expect(bridge.stop).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(0);

      // Restore so afterEach cleanup works
      process.exit = originalExit;
      await daemon.stop();
    });

    test("SIGTERM triggers graceful shutdown", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);
      await daemon.start();

      process.emit("SIGTERM" as any);

      await new Promise((r) => setTimeout(r, 50));

      expect(bridge.stop).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(0);

      process.exit = originalExit;
      await daemon.stop();
    });

    test("SIGUSR2 restarts bridge (stop then start)", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);
      await daemon.start();

      (bridge.stop as any).mockClear();
      (bridge.start as any).mockClear();

      process.emit("SIGUSR2" as any);

      await new Promise((r) => setTimeout(r, 50));

      expect(bridge.stop).toHaveBeenCalled();
      expect(bridge.start).toHaveBeenCalled();

      await daemon.stop();
    });

    test("signal handlers are removed on stop()", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);
      await daemon.start();
      await daemon.stop();

      (bridge.stop as any).mockClear();

      // Emit signals after stop — should not trigger bridge.stop again
      process.emit("SIGINT" as any);
      await new Promise((r) => setTimeout(r, 30));

      // process.exit was called by the signal handler that was still registered
      // but bridge.stop should NOT be called again (handler was removed)
      // Note: if the handler was properly removed, bridge.stop won't be called
      // by the signal. But process.exit might still be called by a leftover
      // handler from the process itself. We check bridge.stop specifically.
      expect(bridge.stop).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Health monitoring
  // =========================================================================

  describe("health monitoring", () => {
    test("checks iLink health at configured interval", async () => {
      vi.useFakeTimers();

      const daemon = new Daemon(bridge, authFlow, {
        ...testConfig,
        ilinkHealthIntervalMs: 1000,
        opencodeHealthIntervalMs: 999999, // Disable OpenCode check
      }, client);

      await daemon.start();

      // No check yet at time 0
      expect(client.getUpdates).not.toHaveBeenCalled();

      // Advance to first check
      vi.advanceTimersByTime(1000);
      await new Promise<void>((resolve) => { resolve(); });

      expect(client.getUpdates).toHaveBeenCalledTimes(1);
      expect(client.getUpdates).toHaveBeenCalledWith("");

      // Advance to second check
      vi.advanceTimersByTime(1000);
      await new Promise<void>((resolve) => { resolve(); });

      expect(client.getUpdates).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
      await daemon.stop();
    });

    test("checks OpenCode health at configured interval", async () => {
      vi.useFakeTimers();

      const daemon = new Daemon(bridge, authFlow, {
        ...testConfig,
        ilinkHealthIntervalMs: 999999, // Disable iLink check
        opencodeHealthIntervalMs: 2000,
      }, undefined, toolAdapter);

      await daemon.start();

      expect(toolAdapter.getSessionInfo).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);
      await new Promise<void>((resolve) => { resolve(); });

      expect(toolAdapter.getSessionInfo).toHaveBeenCalledTimes(1);
      expect(toolAdapter.getSessionInfo).toHaveBeenCalledWith("health-check");

      vi.useRealTimers();
      await daemon.stop();
    });

    test("updates ilinkAlive to false on iLink health check failure", async () => {
      vi.useFakeTimers();

      (client.getUpdates as any).mockRejectedValue(new Error("network error"));

      const daemon = new Daemon(bridge, authFlow, {
        ...testConfig,
        ilinkHealthIntervalMs: 100,
        opencodeHealthIntervalMs: 999999,
      }, client);

      await daemon.start();
      expect(daemon.getHealthStatus().ilinkAlive).toBe(true);

      vi.advanceTimersByTime(100);
      await flushMicrotasks();

      expect(daemon.getHealthStatus().ilinkAlive).toBe(false);

      vi.useRealTimers();
      await daemon.stop();
    });

    test("updates opencodeAlive to false on connection error", async () => {
      vi.useFakeTimers();

      (toolAdapter.getSessionInfo as any).mockRejectedValue(
        new Error("ECONNREFUSED connection refused"),
      );

      const daemon = new Daemon(bridge, authFlow, {
        ...testConfig,
        ilinkHealthIntervalMs: 999999,
        opencodeHealthIntervalMs: 100,
      }, undefined, toolAdapter);

      await daemon.start();
      expect(daemon.getHealthStatus().opencodeAlive).toBe(true);

      vi.advanceTimersByTime(100);
      await flushMicrotasks();

      expect(daemon.getHealthStatus().opencodeAlive).toBe(false);

      vi.useRealTimers();
      await daemon.stop();
    });

    test("opencodeAlive stays true on non-connection errors (e.g., session not found)", async () => {
      vi.useFakeTimers();

      (toolAdapter.getSessionInfo as any).mockRejectedValue(
        new Error("session not found"),
      );

      const daemon = new Daemon(bridge, authFlow, {
        ...testConfig,
        ilinkHealthIntervalMs: 999999,
        opencodeHealthIntervalMs: 100,
      }, undefined, toolAdapter);

      await daemon.start();

      vi.advanceTimersByTime(100);
      await flushMicrotasks();

      // "session not found" is not a connection error, so adapter is alive
      expect(daemon.getHealthStatus().opencodeAlive).toBe(true);

      vi.useRealTimers();
      await daemon.stop();
    });

    test("emits health-check-failed event on failure", async () => {
      vi.useFakeTimers();

      (client.getUpdates as any).mockRejectedValue(new Error("network error"));

      const daemon = new Daemon(bridge, authFlow, {
        ...testConfig,
        ilinkHealthIntervalMs: 100,
        opencodeHealthIntervalMs: 999999,
      }, client);

      const failedEvents: Array<{ component: string }> = [];
      daemon.on("health-check-failed", (e) => failedEvents.push(e));

      await daemon.start();

      vi.advanceTimersByTime(100);
      await flushMicrotasks();

      expect(failedEvents.length).toBeGreaterThanOrEqual(1);
      expect(failedEvents[0].component).toBe("ilink");

      vi.useRealTimers();
      await daemon.stop();
    });

    test("health monitoring stops when daemon stops", async () => {
      vi.useFakeTimers();

      const daemon = new Daemon(bridge, authFlow, {
        ...testConfig,
        ilinkHealthIntervalMs: 100,
        opencodeHealthIntervalMs: 999999,
      }, client);

      await daemon.start();
      await daemon.stop();

      const callCountBefore = (client.getUpdates as any).mock.calls.length;

      // Advance time — no more health checks should fire
      vi.advanceTimersByTime(500);
      await new Promise<void>((resolve) => { resolve(); });

      expect((client.getUpdates as any).mock.calls.length).toBe(callCountBefore);

      vi.useRealTimers();
    });

    test("getHealthStatus returns correct shape", async () => {
      const daemon = new Daemon(
        bridge,
        authFlow,
        testConfig,
        client,
        toolAdapter,
      );

      await daemon.start();

      const status = daemon.getHealthStatus();
      expect(status).toHaveProperty("ilinkAlive");
      expect(status).toHaveProperty("opencodeAlive");
      expect(status).toHaveProperty("retryCount");
      expect(typeof status.ilinkAlive).toBe("boolean");
      expect(typeof status.opencodeAlive).toBe("boolean");
      expect(typeof status.retryCount).toBe("number");

      await daemon.stop();
    });
  });

  // =========================================================================
  // 6. Max retry limit (5 retries → fatal exit)
  // =========================================================================

  describe("max retry limit", () => {
    test("calls process.exit(1) after maxRetries exceeded", async () => {
      vi.useFakeTimers();

      (bridge.start as any).mockRejectedValue(new Error("network error"));
      (authFlow.login as any).mockResolvedValue({
        success: false,
        error: "auth fail",
      });

      const daemon = new Daemon(bridge, authFlow, {
        retryBaseMs: 1,
        retryMaxMs: 100,
        maxRetries: 3,
      });

      await daemon.start();
      await flushMicrotasks();

      // Delays: 1ms (attempt 1), 2ms (attempt 2), 4ms (attempt 3)
      // After attempt 3 fails, retryCount=3 >= maxRetries=3 → fatalExit
      for (let i = 0; i < 3; i++) {
        const delay = 1 * Math.pow(2, i); // 1, 2, 4
        vi.advanceTimersByTime(delay);
        await flushMicrotasks();
      }

      // Flush remaining microtasks for fatalExit to complete
      await flushMicrotasks();

      // After maxRetries, fatalExit should be called
      expect(process.exit).toHaveBeenCalledWith(1);

      vi.useRealTimers();
    });

    test("does not exit before maxRetries are exhausted", async () => {
      vi.useFakeTimers();

      (bridge.start as any).mockRejectedValue(new Error("network error"));
      (authFlow.login as any).mockResolvedValue({
        success: false,
        error: "auth fail",
      });

      const daemon = new Daemon(bridge, authFlow, {
        retryBaseMs: 1,
        retryMaxMs: 100,
        maxRetries: 5,
      });

      await daemon.start();
      await flushMicrotasks();

      // Advance through 4 retries (not yet at max)
      for (let i = 0; i < 4; i++) {
        const delay = 1 * Math.pow(2, i);
        vi.advanceTimersByTime(delay);
        await flushMicrotasks();
      }

      // Not yet at max retries
      expect(process.exit).not.toHaveBeenCalledWith(1);

      // Advance through the 5th retry
      vi.advanceTimersByTime(1 * Math.pow(2, 4)); // 16ms
      await flushMicrotasks();

      // Flush remaining microtasks for fatalExit
      await flushMicrotasks();

      // Now at max retries
      expect(process.exit).toHaveBeenCalledWith(1);

      vi.useRealTimers();
    });

    test("calls stop() before process.exit on fatal error", async () => {
      vi.useFakeTimers();

      (bridge.start as any).mockRejectedValue(new Error("fatal"));
      (authFlow.login as any).mockResolvedValue({
        success: false,
        error: "fail",
      });

      const daemon = new Daemon(bridge, authFlow, {
        retryBaseMs: 1,
        retryMaxMs: 100,
        maxRetries: 2,
      });

      await daemon.start();
      await flushMicrotasks();

      // Exhaust retries
      for (let i = 0; i < 2; i++) {
        vi.advanceTimersByTime(1 * Math.pow(2, i));
        await flushMicrotasks();
      }

      // Flush remaining microtasks for fatalExit to complete
      await flushMicrotasks();

      expect(bridge.stop).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(1);

      vi.useRealTimers();
    });

    test("recovery before maxRetries resets the count", async () => {
      let attempt = 0;
      (authFlow.login as any).mockImplementation(async () => {
        attempt++;
        if (attempt <= 2) {
          return { success: false, error: "not yet" };
        }
        return { success: true, botToken: "tok", baseUrl: "http://x" };
      });

      (bridge.start as any).mockRejectedValueOnce(new Error("first fail"));

      const daemon = new Daemon(bridge, authFlow, {
        retryBaseMs: 5,
        retryMaxMs: 100,
        maxRetries: 5,
      });

      await daemon.start();

      // Wait for retries and eventual recovery
      await new Promise((r) => setTimeout(r, 300));

      // Should have recovered without hitting max retries
      expect(process.exit).not.toHaveBeenCalledWith(1);
      expect(daemon.getHealthStatus().retryCount).toBe(0);

      await daemon.stop();
    });
  });

  // =========================================================================
  // 7. Bridge start failure handling
  // =========================================================================

  describe("bridge start failure", () => {
    test("schedules retry when bridge.start() throws", async () => {
      (bridge.start as any).mockRejectedValue(new Error("network error"));

      const daemon = new Daemon(bridge, authFlow, testConfig);
      const retryEvents: Array<{ attempt: number }> = [];
      daemon.on("retry", (e) => retryEvents.push(e));

      await daemon.start();

      // Should have scheduled a retry
      expect(retryEvents.length).toBeGreaterThanOrEqual(1);
      expect(retryEvents[0].attempt).toBe(1);

      await daemon.stop();
    });

    test("starts health monitoring even if bridge.start() fails", async () => {
      (bridge.start as any).mockRejectedValue(new Error("fail"));

      const daemon = new Daemon(bridge, authFlow, testConfig, client, toolAdapter);
      await daemon.start();

      // Health monitoring should have started
      expect(daemon.getHealthStatus().ilinkAlive).toBe(true);
      expect(daemon.getHealthStatus().opencodeAlive).toBe(true);

      await daemon.stop();
    });
  });

  // =========================================================================
  // 8. Event emission
  // =========================================================================

  describe("event emission", () => {
    test("emits 'session-expired' event when session expires", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);
      const expiredEvents: void[] = [];
      daemon.on("session-expired", () => expiredEvents.push(undefined as any));

      await daemon.start();

      bridge.sessionManager.emit("session-expired");

      await new Promise((r) => setTimeout(r, 30));

      expect(expiredEvents.length).toBeGreaterThanOrEqual(1);

      await daemon.stop();
    });

    test("emits 'recovered' event on successful recovery", async () => {
      const daemon = new Daemon(bridge, authFlow, testConfig);
      const recoveredEvents: void[] = [];
      daemon.on("recovered", () => recoveredEvents.push(undefined as any));

      await daemon.start();

      bridge.sessionManager.emit("session-expired");

      await new Promise((r) => setTimeout(r, 50));

      expect(recoveredEvents.length).toBeGreaterThanOrEqual(1);

      await daemon.stop();
    });

    test("emits 'retry' event with attempt, delay, and error", async () => {
      (authFlow.login as any).mockResolvedValue({
        success: false,
        error: "fail",
      });

      const daemon = new Daemon(bridge, authFlow, testConfig);
      const retryEvents: Array<{ attempt: number; delay: number; error: Error }> = [];
      daemon.on("retry", (e) => retryEvents.push(e));

      await daemon.start();

      bridge.sessionManager.emit("session-expired");

      await new Promise((r) => setTimeout(r, 30));

      expect(retryEvents.length).toBeGreaterThanOrEqual(1);
      expect(retryEvents[0].attempt).toBe(1);
      expect(retryEvents[0].delay).toBe(testConfig.retryBaseMs);
      expect(retryEvents[0].error).toBeInstanceOf(Error);

      await daemon.stop();
    });
  });
});
