import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import {
  closeDb,
  ensureTenant,
  initDb,
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
    `excalidraw-tenant-authz-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  initDb(dbPath);
  setActiveTenant('default');
  process.env.EXCALIDRAW_API_KEY = 'tenant-secret';
  const mod = await import('../../src/server.js');
  app = mod.default;
});

afterEach(() => {
  delete process.env.EXCALIDRAW_API_KEY;
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe('Tenant scoping behavior with API key auth', () => {
  it('any valid API key caller can scope into any existing tenant via X-Tenant-Id', async () => {
    ensureTenant('tenant-a', 'Tenant A', '/a');
    ensureTenant('tenant-b', 'Tenant B', '/b');

    await request(app)
      .post('/api/elements')
      .set('X-API-Key', 'tenant-secret')
      .set('X-Tenant-Id', 'tenant-a')
      .send({ id: 'a-only', type: 'rectangle', x: 0, y: 0, width: 40, height: 30 });

    await request(app)
      .post('/api/elements')
      .set('X-API-Key', 'tenant-secret')
      .set('X-Tenant-Id', 'tenant-b')
      .send({ id: 'b-only', type: 'ellipse', x: 0, y: 0, width: 40, height: 30 });

    const aRes = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'tenant-secret')
      .set('X-Tenant-Id', 'tenant-a');

    const bRes = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'tenant-secret')
      .set('X-Tenant-Id', 'tenant-b');

    expect(aRes.status).toBe(200);
    expect(bRes.status).toBe(200);
    expect(aRes.body.elements.map((el: any) => el.id)).toContain('a-only');
    expect(aRes.body.elements.map((el: any) => el.id)).not.toContain('b-only');
    expect(bRes.body.elements.map((el: any) => el.id)).toContain('b-only');
    expect(bRes.body.elements.map((el: any) => el.id)).not.toContain('a-only');
  });

  it('missing X-Tenant-Id falls back to active tenant context', async () => {
    ensureTenant('tenant-fallback', 'Tenant Fallback', '/fallback');

    const switchRes = await request(app)
      .put('/api/tenant/active')
      .set('X-API-Key', 'tenant-secret')
      .send({ tenantId: 'tenant-fallback' });
    expect(switchRes.status).toBe(200);

    await request(app)
      .post('/api/elements')
      .set('X-API-Key', 'tenant-secret')
      .send({ id: 'fallback-el', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 });

    const listRes = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'tenant-secret');

    expect(listRes.status).toBe(200);
    expect(listRes.body.elements.map((el: any) => el.id)).toContain('fallback-el');
  });

  it('unknown X-Tenant-Id is rejected by server behavior (document current trust boundary)', async () => {
    const res = await request(app)
      .get('/api/elements')
      .set('X-API-Key', 'tenant-secret')
      .set('X-Tenant-Id', 'does-not-exist');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
  });
});
