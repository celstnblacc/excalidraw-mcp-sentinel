/**
 * End-to-end tests for project switching.
 *
 * Exercises the full HTTP stack: create projects → add elements → switch →
 * verify elements are isolated per project and survive round-trips.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setActiveTenant } from '../../src/db.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-e2e-project-switch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

function rect(id: string, x = 0, y = 0) {
  return { id, type: 'rectangle', x, y, width: 100, height: 60, version: 1 };
}

// ─── E2E: draw in project, switch away, switch back ─────────

describe('E2E: project switch round-trip', () => {
  it('draw 2 elements in "dude", switch to default, switch back — elements preserved', async () => {
    // 1. Create project "dude"
    const createRes = await request(app).post('/api/projects').send({ name: 'dude' });
    expect(createRes.status).toBe(201);
    const dudeId = createRes.body.project.id;

    // Remember default project id
    const listBefore = await request(app).get('/api/projects');
    const defaultProject = listBefore.body.projects.find((p: any) => p.name === 'Default');
    expect(defaultProject).toBeDefined();
    const defaultId = defaultProject.id;

    // 2. Switch to "dude"
    const switchRes = await request(app).put('/api/project/active').send({ projectId: dudeId });
    expect(switchRes.status).toBe(200);

    // 3. Draw 2 rectangles in "dude"
    const r1 = await request(app).post('/api/elements').send(rect('dude-box-1', 10, 10));
    const r2 = await request(app).post('/api/elements').send(rect('dude-box-2', 200, 200));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Verify 2 elements present
    const dudeCheck1 = await request(app).get('/api/elements');
    expect(dudeCheck1.body.elements.length).toBe(2);

    // 4. Switch to "default"
    await request(app).put('/api/project/active').send({ projectId: defaultId });

    // Default should be empty
    const defaultCheck = await request(app).get('/api/elements');
    expect(defaultCheck.body.elements.length).toBe(0);

    // 5. Switch back to "dude"
    await request(app).put('/api/project/active').send({ projectId: dudeId });

    // 6. Verify both elements are still there
    const dudeCheck2 = await request(app).get('/api/elements');
    expect(dudeCheck2.body.elements.length).toBe(2);
    const ids = dudeCheck2.body.elements.map((e: any) => e.id);
    expect(ids).toContain('dude-box-1');
    expect(ids).toContain('dude-box-2');
  });

  it('multiple switches do not leak elements between projects', async () => {
    // Create 3 projects
    const pA = await request(app).post('/api/projects').send({ name: 'Alpha' });
    const pB = await request(app).post('/api/projects').send({ name: 'Bravo' });
    const pC = await request(app).post('/api/projects').send({ name: 'Charlie' });
    const aId = pA.body.project.id;
    const bId = pB.body.project.id;
    const cId = pC.body.project.id;

    // Add 1 element to each
    await request(app).put('/api/project/active').send({ projectId: aId });
    await request(app).post('/api/elements').send(rect('alpha-el'));

    await request(app).put('/api/project/active').send({ projectId: bId });
    await request(app).post('/api/elements').send(rect('bravo-el'));

    await request(app).put('/api/project/active').send({ projectId: cId });
    await request(app).post('/api/elements').send(rect('charlie-el'));

    // Rapid switching: C → A → B → A → C
    await request(app).put('/api/project/active').send({ projectId: aId });
    await request(app).put('/api/project/active').send({ projectId: bId });
    await request(app).put('/api/project/active').send({ projectId: aId });
    await request(app).put('/api/project/active').send({ projectId: cId });

    // Verify each project has exactly its own element
    await request(app).put('/api/project/active').send({ projectId: aId });
    const aElems = await request(app).get('/api/elements');
    expect(aElems.body.elements.length).toBe(1);
    expect(aElems.body.elements[0].id).toBe('alpha-el');

    await request(app).put('/api/project/active').send({ projectId: bId });
    const bElems = await request(app).get('/api/elements');
    expect(bElems.body.elements.length).toBe(1);
    expect(bElems.body.elements[0].id).toBe('bravo-el');

    await request(app).put('/api/project/active').send({ projectId: cId });
    const cElems = await request(app).get('/api/elements');
    expect(cElems.body.elements.length).toBe(1);
    expect(cElems.body.elements[0].id).toBe('charlie-el');
  });

  it('updating an element in one project does not affect another', async () => {
    const pX = await request(app).post('/api/projects').send({ name: 'ProjX' });
    const xId = pX.body.project.id;
    const listRes = await request(app).get('/api/projects');
    const defaultId = listRes.body.projects.find((p: any) => p.name === 'Default').id;

    // Add element to default
    await request(app).put('/api/project/active').send({ projectId: defaultId });
    await request(app).post('/api/elements').send(rect('def-rect', 0, 0));

    // Add element to ProjX
    await request(app).put('/api/project/active').send({ projectId: xId });
    await request(app).post('/api/elements').send(rect('x-rect', 0, 0));

    // Update element in ProjX
    const updateRes = await request(app).put('/api/elements/x-rect').send({ x: 999, y: 999 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);

    // Verify ProjX has updated coords
    const xElems = await request(app).get('/api/elements');
    expect(xElems.body.elements).toHaveLength(1);
    expect(xElems.body.elements[0].x).toBe(999);

    // Verify Default still has original coords
    await request(app).put('/api/project/active').send({ projectId: defaultId });
    const defElems = await request(app).get('/api/elements');
    expect(defElems.body.elements[0].x).toBe(0);
  });

  it('deleting an element in one project does not affect another', async () => {
    const pY = await request(app).post('/api/projects').send({ name: 'ProjY' });
    const yId = pY.body.project.id;
    const listRes = await request(app).get('/api/projects');
    const defaultId = listRes.body.projects.find((p: any) => p.name === 'Default').id;

    // Add element to default
    await request(app).put('/api/project/active').send({ projectId: defaultId });
    await request(app).post('/api/elements').send(rect('def-del', 50, 50));

    // Add element to ProjY
    await request(app).put('/api/project/active').send({ projectId: yId });
    await request(app).post('/api/elements').send(rect('y-del', 50, 50));

    // Delete from ProjY
    await request(app).delete('/api/elements/y-del');

    // ProjY: 0 elements
    const yElems = await request(app).get('/api/elements');
    expect(yElems.body.elements.length).toBe(0);

    // Default: still has its element
    await request(app).put('/api/project/active').send({ projectId: defaultId });
    const defElems = await request(app).get('/api/elements');
    expect(defElems.body.elements.length).toBe(1);
    expect(defElems.body.elements[0].id).toBe('def-del');
  });
});
