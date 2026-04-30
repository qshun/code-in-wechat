import { Hono } from "hono";
import type { ServerConfig } from "@/types/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotStatus {
  online: boolean;
  uptime: number;
  lastMessageAt?: number;
  /** Polling diagnostics — helps diagnose "no data" on the dashboard. */
  polling?: {
    isActive: boolean;
    lastPollAt?: number;
    pollCount: number;
    totalMessagesReceived: number;
    pollErrorCount: number;
  };
}

export interface SessionInfo {
  id: string;
  tool: string;
  messageCount: number;
  createdAt: number;
}

export interface StatusProvider {
  getBotStatus(): BotStatus;
  getSessions(): SessionInfo[];
  getQRCode(): string | null;
  getPollingInfo?(): {
    isActive: boolean;
    lastPollAt: number | undefined;
    pollCount: number;
    totalMessagesReceived: number;
    pollErrorCount: number;
  };
}

// ---------------------------------------------------------------------------
// HTML page
// ---------------------------------------------------------------------------

function renderStatusPage(
  status: BotStatus,
  sessions: SessionInfo[],
  qrCode: string | null
): string {
  const statusColor = status.online ? "#22c55e" : "#ef4444";
  const statusText = status.online ? "Online" : "Offline";
  const uptimeSeconds = Math.floor(status.uptime / 1000);
  const uptimeMinutes = Math.floor(uptimeSeconds / 60);
  const uptimeHours = Math.floor(uptimeMinutes / 60);
  const uptimeDisplay =
    uptimeHours > 0
      ? `${uptimeHours}h ${uptimeMinutes % 60}m`
      : `${uptimeMinutes}m ${uptimeSeconds % 60}s`;

  const lastMessageDisplay = status.lastMessageAt
    ? new Date(status.lastMessageAt).toLocaleString()
    : "N/A";

  const pollInfo = status.polling;
  const pollingStatusText = pollInfo
    ? (pollInfo.isActive ? "Active" : "Stopped")
    : "Unknown";
  const pollingStatusColor = pollInfo
    ? (pollInfo.isActive ? "#22c55e" : "#ef4444")
    : "#f59e0b";
  const lastPollDisplay = pollInfo?.lastPollAt
    ? new Date(pollInfo.lastPollAt).toLocaleString()
    : "N/A";

  const sessionRows =
    sessions.length > 0
      ? sessions
          .map(
            (s) => `
        <tr>
          <td>${s.id}</td>
          <td>${s.tool}</td>
          <td>${s.messageCount}</td>
          <td>${new Date(s.createdAt).toLocaleString()}</td>
        </tr>`
          )
          .join("")
      : '<tr><td colspan="4" style="text-align:center;color:#888">No active sessions</td></tr>';

  const qrSection = qrCode
    ? `
    <div class="card">
      <h2>QR Code Login</h2>
      <p>Scan the QR code below to authenticate:</p>
      <img src="${qrCode}" alt="Login QR Code" style="max-width:256px;border-radius:8px" />
    </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="10" />
  <title>Code-in-WeChat Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 2rem;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 1.5rem;
      color: #f8fafc;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    .card h2 {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .status-indicator {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: ${statusColor};
      margin-right: 0.5rem;
      vertical-align: middle;
      box-shadow: 0 0 8px ${statusColor};
    }
    .status-text {
      font-size: 1.125rem;
      font-weight: 600;
      color: ${statusColor};
    }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 1rem;
      margin-top: 0.75rem;
    }
    .stat-item {
      background: #0f172a;
      border-radius: 6px;
      padding: 0.75rem;
    }
    .stat-label {
      font-size: 0.75rem;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-value {
      font-size: 1.125rem;
      font-weight: 600;
      color: #f1f5f9;
      margin-top: 0.25rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 0.5rem;
    }
    th {
      text-align: left;
      font-size: 0.75rem;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #334155;
    }
    td {
      padding: 0.5rem 0.75rem;
      font-size: 0.875rem;
      border-bottom: 1px solid #1e293b;
    }
    .refresh-note {
      text-align: center;
      font-size: 0.75rem;
      color: #475569;
      margin-top: 1.5rem;
    }
  </style>
</head>
<body>
  <h1>Code-in-WeChat</h1>

  <div class="card">
    <h2>Bot Status</h2>
    <div>
      <span class="status-indicator"></span>
      <span class="status-text">${statusText}</span>
    </div>
    <div class="stat-grid">
      <div class="stat-item">
        <div class="stat-label">Uptime</div>
        <div class="stat-value">${uptimeDisplay}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Last Message</div>
        <div class="stat-value">${lastMessageDisplay}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${sessions.length}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Polling</div>
        <div class="stat-value" style="color:${pollingStatusColor}">${pollingStatusText}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Last Poll</div>
        <div class="stat-value">${lastPollDisplay}</div>
      </div>
    </div>
  </div>

  ${pollInfo ? `
  <div class="card">
    <h2>Polling Details</h2>
    <div class="stat-grid">
      <div class="stat-item">
        <div class="stat-label">Poll Cycles</div>
        <div class="stat-value">${pollInfo.pollCount}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Messages Received</div>
        <div class="stat-value">${pollInfo.totalMessagesReceived}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Poll Errors</div>
        <div class="stat-value">${pollInfo.pollErrorCount}</div>
      </div>
    </div>
  </div>` : ""}

  ${qrSection}

  <div class="card">
    <h2>Active Sessions</h2>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Tool</th>
          <th>Messages</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        ${sessionRows}
      </tbody>
    </table>
  </div>

  <div class="refresh-note">Auto-refreshes every 10 seconds</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createWebServer(
  config: ServerConfig,
  statusProvider: StatusProvider
): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    const status = statusProvider.getBotStatus();
    const sessions = statusProvider.getSessions();
    const qrCode = statusProvider.getQRCode();
    const html = renderStatusPage(status, sessions, qrCode);
    return c.html(html);
  });

  app.get("/api/status", (c) => {
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    const status = statusProvider.getBotStatus();
    return c.json(status);
  });

  app.get("/api/sessions", (c) => {
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    const sessions = statusProvider.getSessions();
    return c.json(sessions);
  });

  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  return app;
}