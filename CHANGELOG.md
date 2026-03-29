# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [Unreleased]

## [1.0.1] - 2026-03-29

### Fixed
- `better-sqlite3` native module now rebuilt on install via `postinstall` script, fixing Node.js version mismatch errors (e.g. Node v22 vs v25) when installing via npx

## [1.0.0] - 2026-03-29

### Changed
- Renamed project from `@sanjibdevnath/mcp-excalidraw-local` to `excalidraw-mcp-sentinel`
- New npm package name: `excalidraw-mcp-sentinel` (unscoped)
- GitHub repo: `celstnblacc/excalidraw-mcp-sentinel`
- Docker images: `celstnblacc/excalidraw-mcp-sentinel` and `celstnblacc/excalidraw-mcp-sentinel-canvas`
- CLI binary renamed: `excalidraw-mcp-sentinel`
- Version reset to 1.0.0 for independent release track
- Added "Why this fork?" section to README with full attribution

### Removed
- Superseded planning docs (PLAN.md, PLAN_v2.md, REVIEW.md, HANDOFF.md)

## [1.6.3] - 2026-03-29

### Security
- Added `security.ts` middleware module: helmet headers, explicit CORS allowlist, API key auth
  with timing-safe comparison, prototype pollution guard, Mermaid input size limits
- WebSocket authentication: challenge-response (`auth_required` → `hello + apiKey`) with 5 s
  timeout and close code 4001 on failure; origin verification via `verifyClient`
- Rate limiting on all `/api/*` routes: 100 req/15 min general, 10 req/min destructive, 10 req/min
  sync write burst
- `sanitizeSearchQuery` now throws typed `InvalidSearchQueryError` instead of generic `Error`
- Docker: added `deploy.resources.limits` (canvas 1 CPU/512M, mcp 0.5 CPU/256M) to
  `docker-compose.yml`; extended `.dockerignore` with `tests/` and sensitive key file patterns

### Fixed
- `POST /api/elements/sync`: array validation now runs before logger access, preventing a
  `TypeError` crash (500) on null/non-array input — now returns 400
- `POST /api/elements/sync/v2`: element type validated against `EXCALIDRAW_ELEMENT_TYPES`
  before write; invalid types return 400 instead of being persisted silently
- Upgraded `zod` from 3.22.4 to 3.25.5 to resolve `ERR_PACKAGE_PATH_NOT_EXPORTED` crash at
  MCP server startup caused by `zod-to-json-schema` peer dependency mismatch

### Changed
- `ElementSharedFieldsSchema` extracted from `CreateElementSchema`/`UpdateElementSchema` to
  eliminate 25-field duplication; both schemas now use `.extend()`
- `VALID_ELEMENT_TYPES` moved to module-level constant (was allocated per-request)
- `resolveHelloTenantAndProject` parameter typed as `HelloMessage` (was `any`)
- `getAllFilesObject()` helper extracted; `sendFilesAdded()` and `GET /api/files` share it
- `sendLegacyInitialWsMessages` renamed to `sendAuthlessInitialMessages`
- `.project-hooks/pre-commit` added to run vitest on every commit
