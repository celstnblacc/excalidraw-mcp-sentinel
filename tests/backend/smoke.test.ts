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
const frontendAssetsDir = path.join(frontendDir, 'assets');
const frontendSmokeAssetPath = path.join(frontendAssetsDir, 'smoke.js');
let originalFrontendHtml: string | null = null;
let hadFrontendHtml = false;
let hadSmokeAsset = false;
let originalSmokeAsset: string | null = null;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-smoke-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  setActiveTenant('default');
  hadFrontendHtml = fs.existsSync(frontendHtmlPath);
  originalFrontendHtml = hadFrontendHtml ? fs.readFileSync(frontendHtmlPath, 'utf8') : null;
  hadSmokeAsset = fs.existsSync(frontendSmokeAssetPath);
  originalSmokeAsset = hadSmokeAsset ? fs.readFileSync(frontendSmokeAssetPath, 'utf8') : null;
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.mkdirSync(frontendAssetsDir, { recursive: true });
  fs.writeFileSync(frontendHtmlPath, '<!doctype html><html><head><title>Smoke</title></head><body><div id="root"></div></body></html>');
  fs.writeFileSync(frontendSmokeAssetPath, 'console.log("smoke asset");');
  const mod = await import('../../src/server.js');
  app = mod.default;
});

afterEach(() => {
  delete process.env.EXCALIDRAW_API_KEY;
  closeDb();
  if (hadFrontendHtml && originalFrontendHtml !== null) {
    fs.writeFileSync(frontendHtmlPath, originalFrontendHtml);
  } else {
    try { fs.unlinkSync(frontendHtmlPath); } catch {}
  }
  if (hadSmokeAsset && originalSmokeAsset !== null) {
    fs.writeFileSync(frontendSmokeAssetPath, originalSmokeAsset);
  } else {
    try { fs.unlinkSync(frontendSmokeAssetPath); } catch {}
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe('Smoke checks', () => {
  it('serves the health endpoint and frontend shell', async () => {
    const healthRes = await request(app).get('/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe('healthy');

    const rootRes = await request(app).get('/');
    expect(rootRes.status).toBe(200);
    expect(rootRes.text).toContain('<div id="root"></div>');
  });

  it('serves frontend assets from /assets', async () => {
    const assetRes = await request(app).get('/assets/smoke.js');
    expect(assetRes.status).toBe(200);
    expect(assetRes.text).toContain('smoke asset');
    expect(assetRes.headers['content-type']).toContain('javascript');
  });

  it('supports a keyed create-list-delete smoke flow', async () => {
    process.env.EXCALIDRAW_API_KEY = 'smoke-secret';

    const createRes = await request(app)
      .post('/api/elements')
      .set('X-API-Key', 'smoke-secret')
      .send({ id: 'smoke-el', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });
    expect(createRes.status).toBe(200);

    const listRes = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'smoke-secret');
    expect(listRes.status).toBe(200);
    expect(listRes.body.count).toBe(1);
    expect(listRes.body.elements[0].id).toBe('smoke-el');

    const searchRes = await request(app)
      .get('/api/elements/search')
      .set('X-API-Key', 'smoke-secret')
      .query({ q: 'rectangle' });
    expect(searchRes.status).toBe(200);

    const deleteRes = await request(app)
      .delete('/api/elements/smoke-el')
      .set('X-API-Key', 'smoke-secret');
    expect(deleteRes.status).toBe(200);

    const finalListRes = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'smoke-secret');
    expect(finalListRes.body.count).toBe(0);
  });
});
