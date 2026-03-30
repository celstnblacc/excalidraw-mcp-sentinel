import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setActiveTenant } from '../../src/db.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-middleware-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  setActiveTenant('default');
  process.env.EXCALIDRAW_API_KEY = 'test-secret';
  const mod = await import('../../src/server.js');
  app = mod.default;
  app.set('trust proxy', 1);
});

afterEach(() => {
  delete process.env.EXCALIDRAW_API_KEY;
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe('Middleware order', () => {
  it('bad API key + oversized body returns 401, not 413', async () => {
    const bigText = 'x'.repeat(150 * 1024);
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .set('X-API-Key', 'wrong-key')
      .set('X-Forwarded-For', '10.20.0.1')
      .send(JSON.stringify({ type: 'text', x: 0, y: 0, width: 100, height: 50, text: bigText }));

    expect(res.status).toBe(401);
  });

  it('bad API key returns 401 with rate-limit headers', async () => {
    const res = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'wrong-key')
      .set('X-Forwarded-For', '10.20.0.2');

    expect(res.status).toBe(401);
    expect(res.headers).toHaveProperty('ratelimit-policy');
  });

  it('401 with bad API key is still rate-limited', async () => {
    const ip = '10.20.0.3';
    for (let i = 0; i < 500; i++) {
      await request(app)
        .get('/api/elements')
        .set('X-API-Key', 'wrong-key')
        .set('X-Forwarded-For', ip);
    }

    const res = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'wrong-key')
      .set('X-Forwarded-For', ip);

    expect(res.status).toBe(429);
  });

  it('valid API key + oversized body returns 413', async () => {
    const bigText = 'x'.repeat(150 * 1024);
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .set('X-API-Key', 'test-secret')
      .set('X-Forwarded-For', '10.20.0.4')
      .send(JSON.stringify({ type: 'text', x: 0, y: 0, width: 100, height: 50, text: bigText }));

    expect(res.status).toBe(413);
  });
});
