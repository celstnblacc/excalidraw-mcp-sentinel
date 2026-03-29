import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setActiveTenant } from '../../src/db.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-validation-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  setActiveTenant('default');
  const mod = await import('../../src/server.js');
  app = mod.default;
});

afterEach(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

// ─── Prototype Pollution ─────────────────────────────────────────────────────
// The sanitizeBody middleware strips dangerous keys from req.body and returns
// 400 when they are detected, so that nothing reaches the route handlers.

describe('Prototype pollution prevention', () => {
  it('rejects __proto__ key in POST /api/elements → 400', async () => {
    // Send raw JSON string (real attack vector — not via JS object)
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .send('{"__proto__":{"admin":true},"type":"rectangle","x":0,"y":0,"width":100,"height":50}');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects constructor key in POST /api/elements → 400', async () => {
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .send('{"constructor":{"name":"pwned"},"type":"rectangle","x":0,"y":0,"width":100,"height":50}');
    expect(res.status).toBe(400);
  });

  it('rejects __proto__ key in PUT /api/elements/:id → 400', async () => {
    const res = await request(app)
      .put('/api/elements/some-id')
      .set('Content-Type', 'application/json')
      .send('{"__proto__":{"admin":true},"x":10,"y":10}');
    expect(res.status).toBe(400);
  });

  it('allows clean body in POST /api/elements → not 400', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });
    expect(res.status).not.toBe(400);
  });
});

// ─── Mermaid Injection ───────────────────────────────────────────────────────

describe('Mermaid diagram validation', () => {
  it('rejects diagram > 50KB → 400', async () => {
    const res = await request(app)
      .post('/api/elements/from-mermaid')
      .send({ mermaidDiagram: 'graph TD\n' + 'A-->B\n'.repeat(9000) }); // ~54KB > 50KB limit
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects config with > 10 keys → 400', async () => {
    const config: Record<string, number> = {};
    for (let i = 0; i < 15; i++) config[`key${i}`] = i;
    const res = await request(app)
      .post('/api/elements/from-mermaid')
      .send({ mermaidDiagram: 'graph TD\nA-->B', config });
    expect(res.status).toBe(400);
  });

  it('accepts valid small diagram → not 400', async () => {
    const res = await request(app)
      .post('/api/elements/from-mermaid')
      .send({ mermaidDiagram: 'graph TD\nA-->B' });
    // 200 (no WS client) or 503 (no frontend connected) — both valid
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(413);
  });

  it('rejects non-string mermaid diagram → 400', async () => {
    const res = await request(app)
      .post('/api/elements/from-mermaid')
      .send({ mermaidDiagram: 12345 });
    expect(res.status).toBe(400);
  });
});

// ─── Search Filter Sanitization ──────────────────────────────────────────────

describe('Search filter sanitization', () => {
  it('handles empty search query without crashing → 200', async () => {
    const res = await request(app).get('/api/elements/search');
    expect(res.status).toBe(200);
  });

  it('search with unmatched quote returns 400, not 500', async () => {
    const res = await request(app)
      .get('/api/elements/search')
      .query({ q: '"unterminated' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid search query');
  });

  it("search with bare FTS operator 'AND' returns 400, not 500", async () => {
    const res = await request(app)
      .get('/api/elements/search')
      .query({ q: 'AND' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid search query');
  });

  it("search with 'NEAR/3' returns 400, not 500", async () => {
    const res = await request(app)
      .get('/api/elements/search')
      .query({ q: 'NEAR/3' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid search query');
  });

  it("search 400 response does not contain 'fts5' or 'sqlite' in error message", async () => {
    const res = await request(app)
      .get('/api/elements/search')
      .query({ q: 'AND' });
    expect(res.status).toBe(400);
    expect(String(res.body.error).toLowerCase()).not.toContain('fts5');
    expect(String(res.body.error).toLowerCase()).not.toContain('sqlite');
  });

  it('search with valid query still returns 200', async () => {
    const createRes = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });
    expect(createRes.status).toBe(200);

    const res = await request(app)
      .get('/api/elements/search')
      .query({ q: 'rectangle' });
    expect(res.status).toBe(200);
  });
});

// ─── Import Validation ───────────────────────────────────────────────────────

describe('POST /api/elements/import validation', () => {
  it('rejects non-array elements in import body → 400', async () => {
    const res = await request(app)
      .post('/api/elements/import')
      .send({ elements: 'not-an-array' });
    // 400 = validation rejected, 404 = endpoint doesn't exist — both are safe
    expect([400, 404]).toContain(res.status);
  });
});
