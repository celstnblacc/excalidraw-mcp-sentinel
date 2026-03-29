import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setActiveTenant } from '../../src/db.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;
const frontendDir = path.join(process.cwd(), 'dist/frontend');
const frontendHtmlPath = path.join(frontendDir, 'index.html');
let originalFrontendHtml: string | null = null;
let hadFrontendHtml = false;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  setActiveTenant('default');
  hadFrontendHtml = fs.existsSync(frontendHtmlPath);
  originalFrontendHtml = hadFrontendHtml ? fs.readFileSync(frontendHtmlPath, 'utf8') : null;
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.writeFileSync(frontendHtmlPath, '<!doctype html><html><head><title>Test</title></head><body><div id="root"></div></body></html>');
  const mod = await import('../../src/server.js');
  app = mod.default;
});

afterEach(() => {
  delete process.env.EXCALIDRAW_API_KEY;
  delete process.env.ALLOWED_ORIGINS;
  closeDb();
  if (hadFrontendHtml && originalFrontendHtml !== null) {
    fs.writeFileSync(frontendHtmlPath, originalFrontendHtml);
  } else {
    try { fs.unlinkSync(frontendHtmlPath); } catch {}
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

// ─── API Key Auth ───────────────────────────────────────────────────────────

describe('API Key Auth — disabled (no env var)', () => {
  it('allows GET /api/elements without API key', async () => {
    delete process.env.EXCALIDRAW_API_KEY;
    const res = await request(app).get('/api/elements');
    expect(res.status).toBe(200);
  });

  it('allows DELETE /api/elements/clear without API key', async () => {
    delete process.env.EXCALIDRAW_API_KEY;
    const res = await request(app).delete('/api/elements/clear?confirm=true');
    expect(res.status).toBe(200);
  });
});

describe('API Key Auth — enabled (EXCALIDRAW_API_KEY set)', () => {
  it('rejects GET /api/elements without key → 401', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const res = await request(app).get('/api/elements');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects GET /api/elements with wrong key → 401', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const res = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('allows GET /api/elements with correct key → 200', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const res = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'test-secret');
    expect(res.status).toBe(200);
  });

  it('rejects POST /api/elements without key → 401', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });
    expect(res.status).toBe(401);
  });

  it('rejects DELETE /api/elements/clear without key → 401', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const res = await request(app).delete('/api/elements/clear?confirm=true');
    expect(res.status).toBe(401);
  });

  it('health endpoint is exempt from auth → 200', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('rejects empty X-API-Key header → 401', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const res = await request(app)
      .get('/api/elements')
      .set('X-API-Key', '');
    expect(res.status).toBe(401);
  });
});

// ─── MCP → Canvas inter-service auth (trust boundary A) ─────────────────────
// When EXCALIDRAW_API_KEY is set, the canvas REST API must reject requests that
// don't include the key — including any inter-service caller (MCP or other).
// This validates that the canvas enforces auth at its own boundary regardless
// of the caller; the MCP-side fix (forwarding X-API-Key in canvasHeaders) is
// verified by ensuring the canvas correctly accepts/rejects the header.

describe('MCP → Canvas auth boundary: canvas enforces key on all callers', () => {
  it('rejects inter-service request with no X-API-Key → 401', async () => {
    process.env.EXCALIDRAW_API_KEY = 'inter-service-secret';
    const res = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'default');
    expect(res.status).toBe(401);
  });

  it('accepts inter-service request with correct X-API-Key → 200', async () => {
    process.env.EXCALIDRAW_API_KEY = 'inter-service-secret';
    const res = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'default')
      .set('X-API-Key', 'inter-service-secret');
    expect(res.status).toBe(200);
  });

  it('rejects inter-service request with wrong X-API-Key → 401', async () => {
    process.env.EXCALIDRAW_API_KEY = 'inter-service-secret';
    const res = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'default')
      .set('X-API-Key', 'wrong-key');
    expect(res.status).toBe(401);
  });
});

// ─── CORS ───────────────────────────────────────────────────────────────────

describe('CORS — origin restriction', () => {
  it('allows requests with no Origin header', async () => {
    const res = await request(app).get('/api/elements');
    expect(res.status).toBe(200);
  });

  it('reflects localhost:3000 as allowed origin', async () => {
    const res = await request(app)
      .get('/api/elements')
      .set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('reflects 127.0.0.1:3000 as allowed origin', async () => {
    const res = await request(app)
      .get('/api/elements')
      .set('Origin', 'http://127.0.0.1:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
  });

  it('does NOT reflect untrusted origin in ACAO header', async () => {
    const res = await request(app)
      .get('/api/elements')
      .set('Origin', 'https://evil.com');
    const acao = res.headers['access-control-allow-origin'];
    expect(acao).not.toBe('https://evil.com');
    expect(acao).not.toBe('*');
  });

  it('allows custom origin from ALLOWED_ORIGINS env var', async () => {
    process.env.ALLOWED_ORIGINS = 'http://myapp.local:4000,http://localhost:3000';
    const res = await request(app)
      .get('/api/elements')
      .set('Origin', 'http://myapp.local:4000');
    expect(res.headers['access-control-allow-origin']).toBe('http://myapp.local:4000');
  });

  it('rejects origin not in custom ALLOWED_ORIGINS list', async () => {
    process.env.ALLOWED_ORIGINS = 'http://myapp.local:4000';
    const res = await request(app)
      .get('/api/elements')
      .set('Origin', 'http://localhost:3000');
    const acao = res.headers['access-control-allow-origin'];
    expect(acao).not.toBe('http://localhost:3000');
    expect(acao).not.toBe('*');
  });
});

describe('validateApiKey — timing-safe comparison', () => {
  it('accepts correct key', async () => {
    process.env.EXCALIDRAW_API_KEY = 'secure-key-abc123';
    const { validateApiKey } = await import('../../src/security.js');
    expect(validateApiKey('secure-key-abc123')).toBe(true);
  });

  it('rejects wrong key', async () => {
    process.env.EXCALIDRAW_API_KEY = 'secure-key-abc123';
    const { validateApiKey } = await import('../../src/security.js');
    expect(validateApiKey('wrong-key')).toBe(false);
  });

  it('rejects key that is a prefix of the correct key', async () => {
    process.env.EXCALIDRAW_API_KEY = 'secure-key-abc123';
    const { validateApiKey } = await import('../../src/security.js');
    expect(validateApiKey('secure-key-abc')).toBe(false);
  });

  it('rejects key that is a superstring of the correct key', async () => {
    process.env.EXCALIDRAW_API_KEY = 'secure-key-abc123';
    const { validateApiKey } = await import('../../src/security.js');
    expect(validateApiKey('secure-key-abc123EXTRA')).toBe(false);
  });

  it('rejects undefined', async () => {
    process.env.EXCALIDRAW_API_KEY = 'secure-key-abc123';
    const { validateApiKey } = await import('../../src/security.js');
    expect(validateApiKey(undefined)).toBe(false);
  });

  it('allows anything when auth is disabled', async () => {
    delete process.env.EXCALIDRAW_API_KEY;
    const { validateApiKey } = await import('../../src/security.js');
    expect(validateApiKey(undefined)).toBe(true);
    expect(validateApiKey('anything')).toBe(true);
  });
});

describe('GET / frontend auth bootstrap', () => {
  it('injects __EXCALIDRAW_API_KEY__ into the served HTML when auth is enabled', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('window.__EXCALIDRAW_API_KEY__="test-secret"');
  });

  it('does not inject __EXCALIDRAW_API_KEY__ when auth is disabled', async () => {
    delete process.env.EXCALIDRAW_API_KEY;
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('__EXCALIDRAW_API_KEY__');
  });

  it('injects the current EXCALIDRAW_API_KEY value', async () => {
    process.env.EXCALIDRAW_API_KEY = 'rotated-secret';
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('window.__EXCALIDRAW_API_KEY__="rotated-secret"');
  });
});
