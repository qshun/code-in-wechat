import { existsSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import type { iLinkClient } from "../wechat/ilink-client.js";
import type { iLinkQRCodeResponse, iLinkQRCodeStatusResponse } from "../wechat/types.js";
import { NetworkError } from "../wechat/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthState =
  | "unauthenticated"
  | "qrcode_displayed"
  | "scanned"
  | "confirmed"
  | "expired"
  | "error";

export interface AuthResult {
  success: boolean;
  botToken?: string;
  baseUrl?: string;
  error?: string;
}

export interface QRCodeDisplayData {
  qrcode: string;
  qrcodeImgContent: string;
}

/** Pluggable QR code display strategy. Default: terminal (console.log). */
export type QRCodeDisplayer = (data: QRCodeDisplayData) => void;

export interface AuthFlowConfig {
  /** Path to persist bot_token JSON file */
  botTokenPath: string;
  /** Polling interval in ms (default: 2000) */
  pollIntervalMs?: number;
  /** Timeout in ms (default: 300000 = 5 minutes) */
  timeoutMs?: number;
  /** Custom QR code display strategy */
  qrCodeDisplayer?: QRCodeDisplayer;
}

// ---------------------------------------------------------------------------
// Default QR code display (terminal)
// ---------------------------------------------------------------------------

function terminalDisplayer(data: QRCodeDisplayData): void {
  console.log(`\n📱 Scan QR code to login:\n${data.qrcodeImgContent}\n`);
  console.log(`Or open: ${data.qrcode}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SavedTokenData {
  bot_token: string;
  base_url: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// AuthFlow
// ---------------------------------------------------------------------------

export class AuthFlow {
  private readonly client: iLinkClient;
  private readonly config: Required<Pick<AuthFlowConfig, "botTokenPath" | "pollIntervalMs" | "timeoutMs">> & {
    qrCodeDisplayer?: QRCodeDisplayer;
  };

  private state: AuthState = "unauthenticated";
  private currentQRCode: string | null = null;

  constructor(client: iLinkClient, config: AuthFlowConfig) {
    this.client = client;
    this.config = {
      botTokenPath: config.botTokenPath,
      pollIntervalMs: config.pollIntervalMs ?? 2000,
      timeoutMs: config.timeoutMs ?? 300_000,
      qrCodeDisplayer: config.qrCodeDisplayer,
    };
  }

  /** Current auth state (read-only). */
  getState(): AuthState {
    return this.state;
  }

  /** Get the current QR code URL, if one is being displayed. */
  getCurrentQRCode(): string | null {
    return this.currentQRCode;
  }

  /** Check if we have a valid saved bot_token file. */
  isAuthenticated(): boolean {
    // Synchronous check — we just verify the file exists and is non-empty.
    // For true validation, use restoreSession().
    try {
      if (!existsSync(this.config.botTokenPath)) return false;
      const content = readFileSync(this.config.botTokenPath, "utf-8");
      if (!content.trim()) return false;
      const data = JSON.parse(content) as SavedTokenData;
      return !!(data.bot_token && data.base_url);
    } catch {
      return false;
    }
  }

  /** Full login flow: get QR → display → poll → save token. */
  async login(): Promise<AuthResult> {
    this.state = "unauthenticated";
    this.currentQRCode = null;

    const startTime = Date.now();

    try {
      // Step 1: Get QR code
      let qrResponse: iLinkQRCodeResponse;
      try {
        qrResponse = await this.client.getBotQRCode();
      } catch (err) {
        this.state = "error";
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      this.currentQRCode = qrResponse.qrcode;
      this.state = "qrcode_displayed";

      // Step 2: Display QR code
      const displayer = this.config.qrCodeDisplayer ?? terminalDisplayer;
      displayer({
        qrcode: qrResponse.qrcode,
        qrcodeImgContent: qrResponse.qrcode_img_content,
      });

      // Step 3: Poll for QR code status
      while (true) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= this.config.timeoutMs) {
          this.state = "expired";
          return {
            success: false,
            error: "QR code login timed out after 5 minutes",
          };
        }

        let status: iLinkQRCodeStatusResponse;
        try {
          status = await this.client.getQRCodeStatus(this.currentQRCode);
        } catch (err) {
          // Network errors during polling are retryable
          if (err instanceof NetworkError) {
            await sleep(this.config.pollIntervalMs);
            continue;
          }
          this.state = "error";
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        switch (status.status) {
          case "wait":
            // Still waiting — poll again
            await sleep(this.config.pollIntervalMs);
            break;

          case "scaned":
            // QR code scanned — transition state, keep polling
            this.state = "scanned";
            await sleep(this.config.pollIntervalMs);
            break;

          case "confirmed":
            // Success! Save token and return
            this.state = "confirmed";
            if (!status.bot_token || !status.baseurl) {
              this.state = "error";
              return {
                success: false,
                error: "QR code confirmed but missing bot_token or baseurl",
              };
            }
            await this.saveToken(status.bot_token, status.baseurl);
            return {
              success: true,
              botToken: status.bot_token,
              baseUrl: status.baseurl,
            };

          default:
            // Unknown status — treat as error
            this.state = "error";
            return {
              success: false,
              error: `Unexpected QR code status: ${String((status as unknown as Record<string, unknown>).status ?? "unknown")}`,
            };
        }
      }
    } catch (err) {
      this.state = "error";
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Try to restore session from saved bot_token file. */
  async restoreSession(): Promise<AuthResult> {
    try {
      const content = await fs.readFile(this.config.botTokenPath, "utf-8");
      if (!content.trim()) {
        return { success: false, error: "Token file is empty" };
      }

      const data = JSON.parse(content) as SavedTokenData;
      if (!data.bot_token || !data.base_url) {
        return { success: false, error: "Token file is missing required fields" };
      }

      this.state = "confirmed";
      return {
        success: true,
        botToken: data.bot_token,
        baseUrl: data.base_url,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { success: false, error: "No saved session found" };
      }
      return {
        success: false,
        error: `Failed to restore session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Delete token file and reset state. */
  async logout(): Promise<void> {
    this.state = "unauthenticated";
    this.currentQRCode = null;

    try {
      await fs.unlink(this.config.botTokenPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      // File doesn't exist — that's fine, already logged out
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Persist bot_token to file with restricted permissions. */
  private async saveToken(botToken: string, baseUrl: string): Promise<void> {
    const data: SavedTokenData = {
      bot_token: botToken,
      base_url: baseUrl,
    };

    // Ensure directory exists
    const dir = path.dirname(this.config.botTokenPath);
    await fs.mkdir(dir, { recursive: true });

    // Write token file
    await fs.writeFile(
      this.config.botTokenPath,
      JSON.stringify(data, null, 2),
      "utf-8",
    );

    // Try to set restrictive permissions (0600) — best-effort on Windows
    try {
      await fs.chmod(this.config.botTokenPath, 0o600);
    } catch {
      // chmod may fail on Windows or certain filesystems — ignore
    }
  }
}