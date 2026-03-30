# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [Unreleased]

### Added
- `frontend/src/utils/scenePreparation.ts` with scene-preparation utilities (`expandLabelsToNative`, `prepareElementsForScene`, `convertElementsPreservingImageProps`)
- Backend tests: `tests/backend/db-unit.test.ts`, `tests/backend/mcp-contract.test.ts`, `tests/backend/mcp-sanitization.test.ts`, `tests/backend/security-unit.test.ts`, `tests/backend/smoke-ws.test.ts`, `tests/backend/tenant-authz-behavior.test.ts`
- Frontend test: `tests/frontend/scene-preparation.test.ts`
- E2E regression suite: `tests/e2e/phase2-regressions.spec.ts`

### Changed
- `computeElementHash` is now order-stable for equivalent element sets
- `frontend/src/App.tsx` now uses centralized scene-preparation utilities for label expansion and native-vs-converted routing
- Documentation test counts updated to `443`

### Fixed
- MCP unknown tool calls now return JSON-RPC `MethodNotFound` (`-32601`)
- `import_scene` now enforces dangerous-key checks on parsed scene payloads before processing
- Double WebSocket connection race: guard now also blocks `CONNECTING` state, preventing a second WS from seeding `knownContainerIdsRef` prematurely
- Title/subtitle auto-injection for WS-delivered container elements: `handleCanvasChange()` now called explicitly after `element_created` updates scene (Excalidraw's `CaptureUpdateAction.NEVER` suppresses the `onChange` callback)
- Curved arrow control points remain deformable after sync round-trip (merge strategy preserves Excalidraw internals)
- E2E: `curved arrow stays deformable after sync round-trip` regression test passing
- E2E: `new container arrival auto-injects title and subtitle text` now reliably passes with the double-WS fix

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
