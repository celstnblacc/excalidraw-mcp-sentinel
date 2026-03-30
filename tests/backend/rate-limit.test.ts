import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setActiveTenant } from '../../src/db.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-ratelimit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  setActiveTenant('default');
  const mod = await import('../../src/server.js');
  app = mod.default;
  app.set('trust proxy', 1);
});

afterEach(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

// ─── Clear Canvas Confirmation ───────────────────────────────────────────────

describe('DELETE /api/elements/clear — confirmation token', () => {
  it('rejects clear without confirm=true query param → 400', async () => {
    const res = await request(app).delete('/api/elements/clear');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects clear with confirm=false → 400', async () => {
    const res = await request(app).delete('/api/elements/clear?confirm=false');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('allows clear with confirm=true → 200', async () => {
    const res = await request(app).delete('/api/elements/clear?confirm=true');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─── Payload Size Limits ─────────────────────────────────────────────────────

describe('Payload size limits', () => {
  it('rejects POST /api/elements with body > 100KB → 413', async () => {
    const bigText = 'x'.repeat(150 * 1024); // 150KB
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'text', x: 0, y: 0, width: 100, height: 50, text: bigText }));
    expect(res.status).toBe(413);
  });

  it('accepts POST /api/elements with body within limit → not 413', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });
    expect(res.status).not.toBe(413);
  });

  it('rejects POST /api/elements/batch with body > 5MB → 413', async () => {
    // Build a payload just over 5MB
    const elements = Array.from({ length: 10 }, (_, i) => ({
      id: `el-${i}`,
      type: 'rectangle',
      x: i * 10, y: 0, width: 100, height: 50,
      // Pad each element with ~600KB of label text
      label: 'x'.repeat(600 * 1024),
    }));
    const res = await request(app)
      .post('/api/elements/batch')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ elements }));
    expect(res.status).toBe(413);
  });
});

// ─── Rate Limiting ───────────────────────────────────────────────────────────

describe('Rate limiting — destructive endpoints', () => {
  it('returns 429 after exceeding clear rate limit', async () => {
    // Exhaust the per-minute limit for destructive ops (default 10)
    const limit = 10;
    for (let i = 0; i < limit; i++) {
      await request(app).delete('/api/elements/clear?confirm=true');
    }
    const res = await request(app).delete('/api/elements/clear?confirm=true');
    expect(res.status).toBe(429);
  });

  it('returns RateLimit headers on destructive endpoint', async () => {
    const res = await request(app).delete('/api/elements/clear?confirm=true');
    // express-rate-limit draft-7 sets ratelimit-policy on every response
    expect(res.headers).toHaveProperty('ratelimit-policy');
  });
});

describe('Rate limiting — sync endpoints', () => {
  it('returns 429 after exceeding /api/elements/sync write-burst limit', async () => {
    const ip = '10.10.0.1';
    for (let i = 0; i < 30; i++) {
      await request(app)
        .post('/api/elements/sync')
        .set('X-Forwarded-For', ip)
        .send({ elements: [], timestamp: new Date().toISOString() });
    }

    const res = await request(app)
      .post('/api/elements/sync')
      .set('X-Forwarded-For', ip)
      .send({ elements: [], timestamp: new Date().toISOString() });

    expect(res.status).toBe(429);
  });

  it('returns 429 after exceeding /api/elements/sync/v2 write-burst limit', async () => {
    const ip = '10.10.0.2';
    for (let i = 0; i < 30; i++) {
      await request(app)
        .post('/api/elements/sync/v2')
        .set('X-Forwarded-For', ip)
        .send({ lastSyncVersion: 0, changes: [] });
    }

    const res = await request(app)
      .post('/api/elements/sync/v2')
      .set('X-Forwarded-For', ip)
      .send({ lastSyncVersion: 0, changes: [] });

    expect(res.status).toBe(429);
  });

  it('sync 429 responses include rate-limit headers', async () => {
    const ip = '10.10.0.3';
    for (let i = 0; i < 30; i++) {
      await request(app)
        .post('/api/elements/sync')
        .set('X-Forwarded-For', ip)
        .send({ elements: [], timestamp: new Date().toISOString() });
    }

    const res = await request(app)
      .post('/api/elements/sync')
      .set('X-Forwarded-For', ip)
      .send({ elements: [], timestamp: new Date().toISOString() });

    expect(res.status).toBe(429);
    expect(res.headers).toHaveProperty('ratelimit-policy');
  });
});
