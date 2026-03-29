# AGENTS.md

Agent instructions for mcp-excalidraw-local. Read this before starting any task.

## What This Is

A fully local, self-hosted Excalidraw MCP server. Single Node.js/TypeScript process
running an MCP server (stdio, 32 tools), an Express+WebSocket canvas server, and
SQLite persistence with multi-tenancy.

## Commands

```bash
# Install
npm ci

# Build (frontend + server)
npm run build

# Build server only (TypeScript)
npm run build:server

# Type check
npm run type-check

# Tests
npm test                        # full suite (vitest, 369 tests)
npm run test:api                # API tests only
npm run test:ws                 # WebSocket tests only

# Run canvas server
node dist/server.js

# Health check
curl http://localhost:3000/health
```

## Architecture

```
src/index.ts    MCP server (stdio) — 32 tools, HTTP client to canvas
src/server.ts   Express canvas server — REST API, WebSocket, Zod validation
src/security.ts Security middleware — auth, CORS, rate limiting, sanitization
src/db.ts       SQLite persistence — CRUD, FTS5, migrations, tenants
src/types.ts    Shared TypeScript types, ID generation, element validation
frontend/       React + Excalidraw UI (Vite, output → dist/frontend/)
```

Data flow: MCP tool → `index.ts` → HTTP → `server.ts` → SQLite + WS broadcast → frontend.

## Key Constraints

- **ESM only** — all imports use `.js` extension. Do not use `require()`.
- **Strict TypeScript** — `noUncheckedIndexedAccess` enabled. No `any` without justification.
- **No `===` on secrets** — use `crypto.timingSafeEqual`. See `src/security.ts`.
- **Validation before DB write** — always validate element types against `VALID_ELEMENT_TYPES` before persisting.
- **Logger after validation** — never access `req.body` fields in logger calls before the array/type checks run (crash risk).
- **Auth env vars read at request time** — `security.ts` reads `process.env` on each call so tests can mutate env between cases. Do not cache `process.env.EXCALIDRAW_API_KEY`.
- **Canvas sync is fire-and-forget** — MCP handlers call canvas REST but never fail if canvas is down. Use `syncToCanvas()`.
- **Logging to file only** — never log to stdout (breaks MCP stdio JSON protocol). Use the Winston logger in `src/utils/logger.ts`.

## Security Middleware (`src/security.ts`)

All middleware lives here — do not duplicate in routes:
- `helmetMiddleware` — security headers
- `corsMiddleware` — explicit origin allowlist (env: `ALLOWED_ORIGINS`)
- `apiKeyAuth` — timing-safe API key check (env: `EXCALIDRAW_API_KEY`)
- `sanitizeBody` — strips `__proto__`/`constructor`/`prototype` keys
- `validateMermaidInput` — caps diagram size at 50 KB
- `generalRateLimit` / `destructiveRateLimit` / `writeBurstLimit` — 3-tier rate limiting
- `requireConfirm` — requires `?confirm=true` on destructive endpoints
- `verifyWsClient` — WS origin check at upgrade time
- `sanitizeSearchQuery` / `InvalidSearchQueryError` — FTS input sanitization

## Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_PORT` | `3000` | Canvas server port |
| `EXCALIDRAW_API_KEY` | _(unset)_ | Enables API key auth on all `/api/*` routes |
| `ALLOWED_ORIGINS` | `http://localhost:3000,...` | Comma-separated CORS allowlist |
| `EXCALIDRAW_DB_PATH` | `$HOME/.excalidraw-mcp/excalidraw.db` | SQLite path |
| `EXCALIDRAW_EXPORT_DIR` | `process.cwd()` | Export directory (path traversal guard) |
| `EXCALIDRAW_RATE_LIMIT_GENERAL_MAX` | `100` | Requests per 15-minute window |
| `EXCALIDRAW_RATE_LIMIT_DESTRUCTIVE_MAX` | `10` | Requests per 1-minute window |
| `EXCALIDRAW_RATE_LIMIT_WRITE_BURST_MAX` | `10` | Sync writes per 1-minute window |

## Testing Rules

- 369 tests across 20 files — all must pass before any commit.
- New security-relevant behaviour must have a regression test.
- Tests mutate `process.env` between cases — do not cache env values at module init.
- Integration tests use real SQLite (tmpdir). Do not mock the DB.

## Protected Files

- `AGENTS.md` — immutable unless explicitly named in the request.
- `CLAUDE.md` — immutable unless explicitly named in the request.
- `CHANGELOG.md` — append-only. Never edit or reorder existing entries.

## Before `npm publish`

- [ ] Bump `version` in `package.json` (current: `1.6.2`, next: `1.6.3`)
- [ ] `npm test` → 369/369
- [ ] `npm run build` → zero errors
- [ ] `shipguard scan .` → 0 CRITICAL
- [ ] `npm publish --dry-run` → only `dist/`, `skills/`, `README.md`, `LICENSE` included
