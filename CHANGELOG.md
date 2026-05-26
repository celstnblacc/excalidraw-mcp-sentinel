# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [Unreleased]

### Fixed
- `clear_canvas`, `import_scene` (mode `replace`), and `restore_snapshot` MCP
  tools silently failed to wipe the canvas because their internal `fetch()`
  calls to `DELETE /api/elements/clear` did not include the `?confirm=true`
  query parameter required by the `requireConfirm` security middleware
  (introduced in v1.6.3, commit 55392350). The DELETE returned 400 and the
  calling code either ignored the response (`import_scene`, `restore_snapshot`)
  or surfaced a `Failed to clear canvas: 400 Bad Request` to the caller
  (`clear_canvas` token-confirm step). After this fix, the three MCP tools
  pass `?confirm=true` and `import_scene` / `restore_snapshot` also throw on
  a non-OK clear response so the bug cannot regress silently.

## [1.1.0] - 2026-04-06

### Added
- Batch workspace select/delete UI: Select/Unselect All, per-row checkboxes,
  Delete N workspaces button with confirmation — active workspace is disabled
  from selection
- `POST /api/tenants/batch-delete` endpoint — delete up to 50 tenants in one
  request with per-tenant cascade (projects, elements, snapshots)
- `fillNativeFields()` in db layer — fills all universal and type-specific
  native Excalidraw fields (angle, strokeColor, roundness, seed, etc.) on
  every write so elements are identical to those produced by the VSCode
  Excalidraw extension
- `repairContainerBinding()` in db layer — enforces bidirectional
  `containerId` ↔ `boundElements` binding on every write path (create, update,
  batch, sync/v2) so text labels always follow their container when moved
- Server-side label materialization (`materializeLabel` in server.ts): MCP
  `create_element`/`update_element` calls with `label.text` or `text` on a
  shape now produce a native bound text element in the DB instead of an MCP
  label stub — no synthetic generation required on export
- 42 new backend non-regression tests for native field preservation, container
  binding repair, and label materialization (519 total)

## [1.0.6] - 2026-04-06

### Added
- `DELETE /api/tenants/:id` endpoint — delete workspaces (tenants) with cascade (projects, elements, snapshots)
- Workspace delete UI: inline confirm buttons in the workspace switcher panel

### Fixed
- Project switch in browser did not load new project's elements — `switchProjectUI` now directly clears canvas and calls `loadExistingElements()` instead of relying on WS roundtrip

## [1.0.5] - 2026-04-06

### Added
- Project management UI in canvas header: create, switch, delete projects with inline confirm
- Sync countdown timer in header — shows seconds until next auto-sync after drawing stops
- REST endpoints: `GET /api/projects`, `POST /api/projects`, `PUT /api/project/active`, `DELETE /api/projects/:id`
- E2e test suite for project switching round-trips (`project-switch-e2e.test.ts`)
- Sync countdown unit tests with fake timers (`sync-countdown.test.ts`)

### Fixed
- `resolveTenantProject` always returned first project by creation date instead of the active project — switching projects had no effect on element queries
- `resolveScope` had the same bug, causing WebSocket broadcasts to target the wrong project
- Switching projects while a sync countdown was pending could overwrite the new project with the old project's elements — pending sync now auto-saves before switching
- `onChange` triggered sync countdown on selection/appState changes (not just element changes) — added element hash comparison to filter false triggers

### Changed
- Test count: 477/477 (was 446)

## [1.0.3] - 2026-03-30

### Fixed
- Global install crash (`Schema method literal must be a string`) — upgraded `zod` from `3.25.5` to `^4.3.6` so the package uses real zod v4 rather than falling back to zod 3.x's v4 compatibility shim, which lacks the `.value` getter required by `@modelcontextprotocol/sdk@1.26.0`
- `z.record(z.any())` call updated to `z.record(z.string(), z.any())` to satisfy zod v4's stricter record key-type requirement

## [1.0.2] - 2026-03-30

### Added
- `frontend/src/utils/scenePreparation.ts` — centralized scene-preparation utilities (`expandLabelsToNative`, `prepareElementsForScene`, `convertElementsPreservingImageProps`)
- E2E regression suite: `tests/e2e/phase2-regressions.spec.ts` (4 tests: position stability, auto-title, two-tab sync, curved arrow deformability)
- Backend tests: `db-unit`, `mcp-contract`, `mcp-sanitization`, `security-unit`, `smoke-ws`, `tenant-authz-behavior`
- Frontend tests: `scene-preparation`, `helpers`, `sync-logic`

### Changed
- `computeElementHash` is now order-stable for equivalent element sets
- `frontend/src/App.tsx` uses centralized scene-preparation utilities for label expansion and native-vs-converted routing
- Rate limits raised: general 100→500 req/15min, write burst 10→30 req/min
- MCP unknown tool calls now return JSON-RPC `MethodNotFound` (-32601) instead of generic error
- Test count: 446/446

### Fixed
- **Double WebSocket connection race** — second WS created during `CONNECTING` state seeded `knownContainerIdsRef` prematurely, blocking title auto-injection; guard now also blocks `CONNECTING` state
- **Title/subtitle not injected for WS-delivered containers** — `CaptureUpdateAction.NEVER` suppresses `onChange`; `handleCanvasChange()` now called explicitly after `element_created`
- **Text alignment lost after sync** — `ElementSharedFieldsSchema` did not declare `textAlign`, `verticalAlign`, `containerId`; Zod silently stripped these on every REST round-trip
- **Curved arrow deforms after sync** — element replace strategy discarded Excalidraw-internal control point state; now merges incoming over existing
- **MCP `import_scene` prototype pollution** — `assertNoDangerousKeys()` now called on all parsed JSON payloads (MCP stdio bypasses Express middleware)
- **FTS5 colon column-filter injection** — `:` added to blocked character set in `sanitizeSearchQuery`
- **Global state race in `createProject`/`listProjects`** — explicit `tenantId?` param added; MCP callers pass captured ID at call time
- Subtitle elements in MCP `create_element` now set `textAlign: "center"` and `verticalAlign: "top"`
- `ServerElement` type updated with `textAlign?`, `verticalAlign?`, `containerId?`
- `pendingTitleTimerRef` now cleaned up on component unmount (prevented stale closure after unmount)
- `localStorage` JSON.parse for widget position wrapped in try/catch (malformed value no longer crashes component)
- Docker `LABEL org.opencontainers.image.source` corrected to fork URL

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

## [Unreleased] - 2026-03-30

### Fixed
- Bidirectional sync conflict: WS-applied updates no longer reverted by browser auto-sync (lastSyncedElementsRef now updated on element_updated, element_deleted, elements_batch_created)
- Labeled container updates (rectangle, ellipse, diamond, arrow) now use convertToExcalidrawElements with ID transplant for correct text layout instead of in-place text patch that caused clipping
- Standalone text element updates now write label.text into text/originalText fields so Excalidraw renders the new value
- convertTextToLabel now maps text→label for arrows and empty strings (previously skipped falsy text)

### Changed
- Default theme set to dark

### Fixed
- Labels stored as label.text (e.g. from MCP updates) now survive page refresh — expandLabelsToNative pre-converts them to bound text before Excalidraw renders

## [1.0.4] - 2026-03-31

### Fixed
- `npm install -g excalidraw-mcp-sentinel` crashed on Windows — `postinstall` script used Unix-only `2>/dev/null || true` syntax which cmd.exe does not support; replaced with a cross-platform `node -e` inline script

- 2026-05-14: chore(ci): release workflow now manual (workflow_dispatch) -- no longer fires automatically on every CI pass on main

## [1.2.0] - 2026-05-20

### Added
- Streamable HTTP transport mode (`MCP_TRANSPORT=http`): single long-lived process serves all MCP clients over HTTP instead of spawning a new stdio process per session. Each client gets its own isolated `Server` instance routed by `mcp-session-id` header. Eliminates per-session process overhead for multi-session setups.
- `src/mcp-http.ts`: `mountMcpRoutes`, `startMcpHttpServer`, `resolveTransportMode` — full HTTP session lifecycle (POST/GET/DELETE /mcp, session map, `StreamableHTTPServerTransport`)
- `createMcpServer()` factory and `registerHandlers()` in `src/index.ts` — clean per-session server instantiation for HTTP mode
- 9 new tests in `tests/backend/mcp-http.test.ts` covering transport resolution, session isolation, session teardown, and `startMcpHttpServer`
- `CLAUDE.md`: Strict Installation Decoupling rule
- launchd agent (`~/Library/LaunchAgents/com.user.excalidraw-mcp.plist`) for single-instance persistence on macOS

### Changed
- `runServer()` now checks `MCP_TRANSPORT` env var; defaults to stdio (backward-compatible)
- `fs.writeFileSync`/`readFileSync` calls in export/import tool handlers converted to `fs.promises` async variants

### Total tests: 528 (31 files)
