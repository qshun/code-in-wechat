# src/bridge

## OVERVIEW

Core message pipeline: WeChat polling → command routing → tool adapter → stream handler → WeChat sending.

## STRUCTURE

6 files, no barrel index.ts. Cross-imports allowed within the directory.
message-bridge.ts imports all siblings to wire the pipeline together.

- auth-flow.ts — QR login, bot_token persistence (save/restore/logout)
- media-handler.ts — AES-128-ECB encrypt/decrypt, CDN upload/download, media→ToolMessagePart
- message-bridge.ts — Orchestrator: dedup, async queue, web lifecycle, error recovery
- session-manager.ts — Long-polling loop, context_token cache (24h TTL), cursor persistence
- slash-commands.ts — parseCommand(), executeCommand(), COMMAND_HANDLERS registry
- stream-handler.ts — SSE→chunk emission (≤2000 chars), typing indicator management

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Add a slash command | slash-commands.ts | Register handler in COMMAND_HANDLERS |
| Change poll/retry timing | session-manager.ts | Constructor options |
| Change chunk size | stream-handler.ts | Default 2000 |
| Add bridge error handling | message-bridge.ts | handleMessage() dispatcher |
| Change cursor format | session-manager.ts | Private persistCursor() |
| Change media→part conversion | media-handler.ts | toToolMessagePart() |
| Change auth flow | auth-flow.ts | QR generation, token save/restore |
| Change typing indicators | stream-handler.ts | startTyping/stopTyping/keepalive |

## CRITICAL CONSTRAINTS

- AES key decode paths differ by media type. Image: base64(raw 16 bytes). File/voice/video: base64(hex string). See media-handler.ts.
- sendAndStream() must subscribe to SSE before sending prompt. See message-bridge.ts.
- WeChat hard limit 2000 chars per message. StreamHandler chunks at this limit.
- SessionManager emits "session-expired" on ret=-14. Daemon listens and re-auths.
- Cursor persistence is best-effort JSON write. Errors are silently ignored.

## ANTI-PATTERNS

- NEVER mix AES key decode paths (image vs file). No shared helper exists.
- NEVER await session.prompt() before SSE subscription in sendAndStream().
- NEVER exceed 2000 chars in a single WeChat message.
- Daemon accesses (this.bridge as any).sessionManager. Do not tighten encapsulation without updating daemon.ts.

## CONVENTIONS

- Import iLinkClient via @/wechat/ilink-client.
- Logging via createLogger(module) from @/log.
- No barrel index.ts. Consumers import directly from sub-modules.
- SessionManager uses EventEmitter. Events: "message", "command", "session-expired".
