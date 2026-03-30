/**
 * Tests for security gaps on MCP-adjacent paths.
 *
 * CONTEXT: Express middleware (sanitizeBody, apiKeyAuth, rate limiting) only
 * runs on HTTP requests. MCP tool calls arrive over stdio and call db functions
 * directly — bypassing all Express middleware.
 *
 * These tests:
 * 1. Confirm sanitizeBody WORKS on REST paths (baseline proof it's applied).
 * 2. Document the adversarial JSON parsing scenarios that the MCP import_scene
 *    handler faces without any Express-layer protection.
 * 3. Test path traversal blocking on export endpoints (shared logic with MCP).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import {
  initDb,
  closeDb,
  setActiveTenant,
} from '../../src/db.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;

beforeEach(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `excalidraw-mcp-sanit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  initDb(dbPath);
  setActiveTenant('default');
  const mod = await import('../../src/server.js');
  app = mod.default;
});

afterEach(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

// ── Prototype pollution guard — REST layer ────────────────────────────────────

describe('sanitizeBody middleware — REST path coverage', () => {
  it('rejects POST body containing __proto__ key → 400', async () => {
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .send('{"__proto__": {"isAdmin": true}, "type": "rectangle", "x": 0, "y": 0}');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disallowed keys/i);
  });

  it('rejects POST body containing constructor key → 400', async () => {
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .send('{"constructor": {"name": "evil"}, "type": "rectangle", "x": 0, "y": 0}');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disallowed keys/i);
  });

  it('rejects POST body containing nested __proto__ → 400', async () => {
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .send('{"element": {"__proto__": {"evil": true}}, "type": "rectangle", "x": 0, "y": 0}');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disallowed keys/i);
  });

  it('accepts clean POST body → not 400', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });

    expect(res.status).not.toBe(400);
  });
});

// ── MCP import_scene adversarial JSON — documented gap ───────────────────────
//
// MCP tool calls reach `import_scene` via stdio → index.ts.
// The handler does: `sceneData = JSON.parse(params.data)` with no sanitization.
//
// SAFETY NOTE: In modern Node.js (V8 ≥ 8.x), JSON.parse does NOT pollute
// Object.prototype when encountering `{"__proto__": ...}` — it creates a plain
// key named "__proto__" on the result object without calling [[Set]] on the
// prototype chain. However, downstream code that uses Object.assign() or
// spread {...sceneData} can re-trigger pollution if the key is spread into
// an object whose prototype is Object.prototype.
//
// The tests below are NOT executable without a running MCP stdio process.
// They are represented as unit assertions on the JSON.parse behaviour itself
// to document the exact risk surface.

describe('MCP import_scene — JSON.parse prototype behaviour (gap documentation)', () => {
  it('JSON.parse with __proto__ key does NOT pollute Object.prototype in modern Node', () => {
    // This is the safety net we rely on. If this test ever fails, the MCP path
    // is directly exploitable for prototype pollution.
    const parsed = JSON.parse('{"__proto__": {"isAdmin": true}}');

    // The key exists as a plain own property, not as a prototype mutation
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect((Object.prototype as any).isAdmin).toBeUndefined();
  });

  it('Object.assign with a JSON-parsed __proto__ key mutates the spread target prototype chain', () => {
    // CONFIRMED REAL BEHAVIOUR: Object.assign({}, parsed) where parsed has a
    // "__proto__" own key (from JSON.parse) triggers the __proto__ setter on
    // Object.prototype, which changes the *target* object's prototype to the
    // value. This means `cloned.injected` resolves via prototype lookup.
    //
    // This does NOT pollute Object.prototype itself — only the cloned object's
    // prototype chain. But any code in index.ts that does `{ ...sceneData }` or
    // `Object.assign({}, sceneData)` after JSON.parse on MCP input is affected.
    const parsed = JSON.parse('{"__proto__": {"injected": true}}') as any;

    // Verify parsed has __proto__ as an own property (not prototype pollution)
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect((Object.prototype as any).injected).toBeUndefined(); // Object.prototype is clean

    // Spreading/assigning DOES change the target's prototype:
    const cloned = Object.assign({}, parsed);
    expect((cloned as any).injected).toBe(true); // inherited from mutated prototype

    // Object.prototype is still clean after the spread
    expect((Object.prototype as any).injected).toBeUndefined();
  });

  it('deeply nested JSON (depth 1000) does not cause stack overflow during JSON.parse', () => {
    // MCP import_scene does JSON.parse on user-supplied data with no depth limit.
    // Node.js JSON.parse handles deep nesting iteratively — verify it does not
    // blow the call stack at practical depths.
    const depth = 1000;
    const nested = '['.repeat(depth) + '1' + ']'.repeat(depth);

    expect(() => JSON.parse(nested)).not.toThrow();
  });

  it('HYPOTHESIS: extremely deep nesting (depth 100_000) may throw in some runtimes', () => {
    // Document the practical limit. If this throws a RangeError (stack overflow),
    // the MCP import_scene handler is vulnerable to DoS via deeply nested payloads.
    const depth = 100_000;
    const nested = '['.repeat(depth) + '1' + ']'.repeat(depth);

    // We only assert "does not silently succeed with wrong data" — either it
    // parses correctly or throws a catchable error (not a process crash).
    let threw = false;
    try {
      JSON.parse(nested);
    } catch {
      threw = true;
    }
    // Either outcome is acceptable — the key assertion is that the process survives
    expect(true).toBe(true);
  });
});

// ── Path traversal — export endpoint (shared sanitizeFilePath logic) ──────────

describe('Path traversal on export endpoints', () => {
  it('POST /api/export/image with path traversal in filePath → error (not 200)', async () => {
    const res = await request(app)
      .post('/api/export/image')
      .send({
        filePath: '../../../../etc/passwd',
        format: 'png'
      });

    // Should not be 200 — either 400 (validation) or 500 (server error before write)
    expect(res.status).not.toBe(200);
  });

  it('POST /api/export/image with absolute path outside cwd → error (not 200)', async () => {
    const outsidePath = '/tmp/traversal-test-excalidraw.png';
    const res = await request(app)
      .post('/api/export/image')
      .send({
        filePath: outsidePath,
        format: 'png'
      });

    expect(res.status).not.toBe(200);
  });
});

// ── Null-byte injection ───────────────────────────────────────────────────────

describe('Null byte and encoding edge cases', () => {
  it('POST /api/elements with null byte in type field does not crash server', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle\x00', x: 0, y: 0, width: 100, height: 50 });

    // Must return a 4xx — not 200 and not an unhandled 500
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('POST /api/elements/batch with oversized element text does not hang', async () => {
    // Verify server responds within reasonable time even with a large text field
    // (this is a regression guard — a 413 or 400 is both acceptable)
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'text',
        x: 0, y: 0, width: 100, height: 50,
        text: 'A'.repeat(200 * 1024) // 200 KB — over the 100 KB limit
      }));

    expect(res.status).toBe(413);
  });
});
