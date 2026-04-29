# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-30
**Commit:** 2475663
**Branch:** main

## OVERVIEW

WeChat bot bridging WeChat messages with AI coding tools (OpenCode). TypeScript/Bun, ESM modules, iLink API for WeChat transport.

## STRUCTURE

```
src/
├── bridge/       # Core pipeline: polling → routing → tool → stream → send
├── wechat/       # iLink HTTP client + WeChat/iLink API types
├── tools/        # ToolAdapter interface + OpenCode SDK adapter
├── types/        # Shared type definitions (⚠️ overlaps with wechat/types.ts)
├── config/       # Zod-validated env config loading
├── web/          # Hono status page (single file)
├── index.ts      # Entry: 12-step init, CLI parse, daemon/foreground mode
├── daemon.ts     # Process lifecycle: auto-reconnect, health monitoring
├── cli.ts        # process.argv parser (no external deps)
├── log.ts        # Structured logger, auto-masks token/secret/key fields
tests/            # Mirrors src/ structure, vitest globals mode
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add a new WeChat message type | `src/wechat/types.ts` | Define item + update `WeChatMessageItem` union |
| Add a new tool adapter | `src/tools/` | Implement `ToolAdapter` interface from `adapter.ts` |
| Change message routing logic | `src/bridge/message-bridge.ts` | `handleMessage()` is the main dispatcher |
| Change polling/cursor behavior | `src/bridge/session-manager.ts` | Long-polling loop + cursor persistence |
| Add slash command | `src/bridge/slash-commands.ts` | Register in `COMMAND_HANDLERS` map |
| Change stream chunking | `src/bridge/stream-handler.ts` | `chunkSize` default 2000 (WeChat limit) |
| Change media encryption | `src/bridge/media-handler.ts` | ⚠️ Image vs file AES key formats differ |
| Change auth flow | `src/bridge/auth-flow.ts` | QR code login, bot_token persistence |
| Add env var | `src/config/env.ts` | Must add to Zod schema + `loadConfig()` in `index.ts` |
| Add web endpoint | `src/web/server.ts` | Hono app factory |
| Change auto-reconnect | `src/daemon.ts` | Exponential backoff, health checks |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `MessageBridge` | class | `src/bridge/message-bridge.ts` | Central pipeline orchestrator |
| `SessionManager` | class | `src/bridge/session-manager.ts` | Long-polling, context_token cache (24h TTL), cursor |
| `StreamHandler` | class | `src/bridge/stream-handler.ts` | SSE→chunk emission, typing indicators |
| `AuthFlow` | class | `src/bridge/auth-flow.ts` | QR login, bot_token save/restore |
| `MediaHandler` | class | `src/bridge/media-handler.ts` | AES-128-ECB encrypt/decrypt, CDN upload |
| `Daemon` | class | `src/daemon.ts` | Auto-reconnect, signal handling, health monitoring |
| `iLinkClient` | class | `src/wechat/ilink-client.ts` | iLink HTTP API (native fetch, no HTTP lib) |
| `OpenCodeAdapter` | class | `src/tools/opencode.ts` | OpenCode SDK with SSE streaming |
| `ToolAdapter` | interface | `src/tools/adapter.ts` | Unified tool adapter contract |
| `iLinkError` | class | `src/wechat/types.ts` | Base iLink error (ret code) |
| `SessionExpiredError` | class | `src/wechat/types.ts` | ret=-14, triggers re-auth |
| `NetworkError` | class | `src/wechat/types.ts` | Fetch failure wrapper |
| `RateLimitError` | class | `src/wechat/types.ts` | HTTP 429 wrapper |
| `ToolAdapterError` | class | `src/types/tool.ts` | Adapter-specific error |

## CONVENTIONS

- **Path alias**: `@/*` → `./src/*` (tsconfig.json + vitest.config.ts — must keep in sync)
- **Build**: `tsc && tsc-alias` (tsc-alias resolves `@/` in output)
- **Logging**: `createLogger(module)` from `@/log`, auto-masks fields matching `/token|secret|password|key/i`
- **Config validation**: Zod schemas in `src/config/env.ts`, validated at startup
- **Error classes**: Custom hierarchy in `src/wechat/types.ts` — `iLinkError` → `SessionExpiredError`/`RateLimitError`/`iLinkAPIError`
- **EventEmitter**: `SessionManager` and `Daemon` emit events for async routing
- **Import style**: Use `@/` path alias. Do NOT use relative `.js` imports (2 files do this — they're legacy)
- **No external HTTP lib**: `iLinkClient` uses native `fetch` only
- **No external CLI lib**: `cli.ts` parses `process.argv` directly
- **Test mocks**: Local `createMock*()` factory functions per test file, no shared mock utilities
- **Vitest globals**: `describe/it/expect` globally available (no import needed)

## ANTI-PATTERNS (THIS PROJECT)

- **NEVER await `session.prompt()` before subscribing to SSE** — `sendAndStream()` in `opencode.ts` must: subscribe first → send prompt WITHOUT awaiting → collect events in parallel. `session.prompt()` blocks until complete; awaiting it first means all events fire before listener is attached.
- **NEVER mix AES key decode paths** — Image keys: `base64(raw 16 bytes)`. File/voice/video keys: `base64(hex string)` → decode hex after base64. Wrong path = decryption failure.
- **NEVER ignore `ret=-14`** — iLink session expiry must propagate as `SessionExpiredError` to trigger re-auth.
- **NEVER add axios/got/etc.** — HTTP calls use native `fetch` only.
- **NEVER add commander/yargs/etc.** — CLI parsing is custom in `cli.ts`.
- **NEVER exceed 2000 chars per WeChat message** — Stream handler chunks at this limit.

## UNIQUE STYLES

- **Duplicate type layer**: `src/types/` overlaps with `src/wechat/types.ts`. The `src/types/` directory appears to be an incomplete refactor. When adding types, prefer the co-located domain file (e.g., `src/wechat/types.ts` for WeChat types).
- **Duplicate `ToolAdapter`**: Defined in both `src/tools/adapter.ts` (8 methods, canonical) and `src/types/tool.ts` (7 methods, legacy). Use `adapter.ts`.
- **Daemon `as any` access**: `daemon.ts` accesses `(this.bridge as any).sessionManager` — a known encapsulation gap.
- **Daemon uses `console.*` directly** (14 calls) instead of structured logger — inconsistent with rest of codebase.
- **`auth-flow.ts` uses relative `.js` imports** — only bridge file doing this; should use `@/` alias.
- **`.gitignore` blanket `*.json`** — All JSON files ignored, then whitelisted (`!package.json`, `!tsconfig.json`). New JSON files need manual `!` exception.

## COMMANDS

```bash
bun run dev          # tsx watch src/index.ts (development)
bun run build        # tsc && tsc-alias → dist/
bun run start        # bun dist/index.js (production)
bun run test         # vitest run (single run)
bun run test:watch   # vitest (watch mode)
bun run lint         # tsc --noEmit (type check only, NOT linting)
```

## NOTES

- **`@opencode-ai/sdk` pinned to `latest`** — non-reproducible builds, should pin version
- **No CI/CD** — no GitHub Actions, Dockerfile, or deployment config
- **No ESLint/Prettier** — `lint` script is just `tsc --noEmit`
- **Dev runtime ≠ Prod runtime** — dev uses `tsx`, prod uses `bun`; behavioral differences possible
- **Tests excluded from tsconfig** but use `@/` alias via `vitest.config.ts`
- **`tests/integration/`** — empty directory, no integration tests yet
- **`vitest 1.6` compatibility** — no `vi.mocked()`, no `vi.advanceTimersByTimeAsync()`; tests use manual casts + `await Promise.resolve()` flush
