# Security

## Threat Model

This server is designed for **local and self-hosted use** — it runs on the same machine as your AI agent and browser. The primary threat surface is:

1. A malicious website making cross-origin requests to the canvas API (CSRF / drive-by reads or writes).
2. A compromised or untrusted network exposing the canvas port to other hosts.
3. Malicious input (oversized payloads, prototype pollution, injection) reaching route handlers.

The threat model does **not** cover:
- An attacker with local OS access (they can read the SQLite file directly).
- Server-side request forgery from within the canvas server itself.

---

## Mitigations

### CORS — `corsMiddleware` (`src/security.ts`)

Restricts cross-origin requests to an explicit allowlist (`ALLOWED_ORIGINS` env var, defaults to `localhost:3000` / `127.0.0.1:3000`). Requests with no `Origin` header (MCP stdio, curl, same-origin) are always allowed.

### WebSocket origin check — `verifyWsClient` (`src/security.ts`)

WebSocket upgrades are verified against the same allowlist before the connection is established. Rejects browser-originated connections from unlisted origins.

### WebSocket auth challenge-response

When `EXCALIDRAW_API_KEY` is set, the server immediately sends `{ type: "auth_required" }` after each new WebSocket connection. The client must respond with a `hello` message containing `{ type: "hello", apiKey: "<key>", ... }` within 5 seconds. If the key is missing, wrong, or the timeout fires, the server closes the connection with close code 4001. All other message types are silently dropped until auth succeeds. When auth is disabled, the `hello` handshake proceeds without key validation.

### Auth bootstrap — `GET /` key injection

When `EXCALIDRAW_API_KEY` is set, `GET /` injects `<script>window.__EXCALIDRAW_API_KEY__=…</script>` into the served HTML before `</head>`. The browser canvas reads this value at startup and includes it in the WebSocket `hello` message automatically, so users don't need to configure the key in the browser separately. The value is JSON-encoded with `<` escaped to `\u003c` to prevent script injection.

### API key auth — `apiKeyAuth` (`src/security.ts`)

When `EXCALIDRAW_API_KEY` is set, all `/api/*` routes require the header `X-API-Key: <key>`. Disabled by default for backward compatibility and zero-config local use. The `/health` endpoint is always exempt.

### Security headers — `helmetMiddleware` (`src/security.ts`)

Sets `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `X-DNS-Prefetch-Control`, and removes `X-Powered-By`. CSP and COEP are intentionally disabled to allow Excalidraw's React bundle (inline scripts/styles).

### Rate limiting — `generalRateLimit` / `destructiveRateLimit` / `writeBurstLimit` (`src/security.ts`)

Three limiters apply, all returning `RateLimit-*` headers (draft-7) so clients can self-throttle:

| Limiter | Applied to | Default | Override env var |
|---------|-----------|---------|-----------------|
| `generalRateLimit` | All `/api/*` routes | 100 req / 15 min | `EXCALIDRAW_RATE_LIMIT_GENERAL_MAX` |
| `destructiveRateLimit` | `DELETE /api/elements/clear` | 10 req / 1 min | `EXCALIDRAW_RATE_LIMIT_DESTRUCTIVE_MAX` |
| `writeBurstLimit` | `POST /api/elements/sync`, `POST /api/elements/sync/v2` | 10 req / 1 min | `EXCALIDRAW_RATE_LIMIT_WRITE_BURST_MAX` |

Ceilings are read from env vars at server start. The E2E test harness sets them to high values via `playwright.config.ts` so tests are not self-throttled.

### Confirmation guard — `requireConfirm` (`src/security.ts`)

The `DELETE /api/elements/clear` endpoint requires `?confirm=true`. Prevents accidental or CSRF-triggered canvas wipes.

### Body size limits (`src/server.ts`)

- Default body limit: **100 KB** (standard API requests).
- Batch/sync endpoints: **5 MB** (element arrays and sync payloads).
- Oversized payloads return `413 Payload Too Large`.

### Prototype pollution guard — `sanitizeBody` (`src/security.ts`)

Rejects any request body containing `__proto__`, `constructor`, or `prototype` as object keys. Returns `400 Bad Request` before any route handler sees the data.

### Search query sanitization — `sanitizeSearchQuery` (`src/security.ts`)

`GET /api/elements/search?q=…` passes the query through `sanitizeSearchQuery` before handing it to the SQLite FTS5 engine. The function rejects queries that contain FTS5 operators (`AND`, `OR`, `NOT`, `NEAR/N`), double-quote quoting constructs, or special characters (`*`, `(`, `)`, `{`, `}`, `^`). This prevents malformed FTS5 syntax from bubbling up as SQLite parse errors and closes a narrow injection surface into the FTS virtual table.

### Mermaid input validation — `validateMermaidInput` (`src/security.ts`)

- Diagram string: max **50 KB** (prevents DoS via large Mermaid parse).
- Config object: max **10 keys** (prevents unbounded config expansion).

### Error handling (`src/server.ts`)

The global error handler never exposes stack traces, file paths, or `node_modules` references in responses. 500 errors return the generic message `"Internal server error"`. Non-500 errors surface the error message only.

### Docker host binding (`Dockerfile.canvas`, `docker-compose.yml`)

`HOST=0.0.0.0` inside Docker is intentional: the container binds all interfaces, but the port is only reachable via the published port mapping. For local non-Docker use, the server defaults to `127.0.0.1` (loopback only).

---

## Pinned Dependencies

Security-critical packages are pinned to exact versions (no `^` range) to prevent silent upgrades introducing regressions:

| Package | Reason |
|---------|--------|
| `helmet` | Security headers — pin to known-good config |
| `express-rate-limit` | Rate limiter — header format changes between major versions |
| `cors` | CORS policy enforcement |
| `express` | HTTP server — patch releases may change middleware behavior |
| `ws` | WebSocket server — security patches applied selectively |
| `better-sqlite3` | Native module — ABI compatibility with pinned Node.js |
| `zod` | Input validation — schema breaking changes between minors |
| `@modelcontextprotocol/sdk` | Protocol — pin to tested version |

---

## Reporting Vulnerabilities

Open an issue in the project repository. For sensitive disclosures, contact the maintainer directly via GitHub.

---

## Known Limitations

- **No HTTPS**: The canvas server speaks plain HTTP. Use a reverse proxy (nginx, Caddy) with TLS for any non-localhost deployment.
- **Single shared API key**: There is no per-user or per-tenant auth. The key protects the entire API surface equally.
- **Rate limits are in-memory**: They reset on process restart and are not shared across multiple server instances.
- **SQLite is not encrypted**: The database file is stored in plaintext. Apply OS-level encryption if needed.
