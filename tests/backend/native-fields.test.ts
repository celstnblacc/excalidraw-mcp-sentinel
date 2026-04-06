/**
 * Non-regression tests for native Excalidraw field preservation.
 *
 * Covers:
 * - Universal fields populated on every write (seed, versionNonce, index, etc.)
 * - Type-specific fields: text, arrow, line, image, freedraw
 * - roundness defaults: { type: 3 } for closed shapes, null for others
 * - Zod passthrough: unknown native fields not stripped by schema
 * - repairContainerBinding: both sides of containerId ↔ boundElements kept in sync
 *   across all write paths (create, batch-create, update, sync/v2)
 * - Export: stored version/updated preserved; no duplicate text on export
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import {
  initDb, closeDb,
  getElement, getAllElements,
  setActiveTenant,
} from '../../src/db.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;

const UNIVERSAL_FIELDS = [
  'angle', 'strokeColor', 'backgroundColor', 'fillStyle',
  'strokeWidth', 'strokeStyle', 'roughness', 'opacity',
  'groupIds', 'frameId', 'seed', 'versionNonce',
  'isDeleted', 'updated', 'link', 'locked', 'boundElements', 'index',
];

beforeEach(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `excalidraw-native-fields-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createElement(body: Record<string, any>) {
  const res = await request(app).post('/api/elements').send(body);
  expect(res.status).toBe(200);
  return res.body.element as Record<string, any>;
}

async function batchCreate(elements: Record<string, any>[]) {
  const res = await request(app).post('/api/elements/batch').send({ elements });
  expect(res.status).toBe(200);
  return res.body.elements as Record<string, any>[];
}

async function syncV2(changes: { id: string; action: string; element?: Record<string, any> }[]) {
  const res = await request(app).post('/api/elements/sync/v2').send({
    lastSyncVersion: 0,
    changes,
  });
  expect(res.status).toBe(200);
}

async function updateElement(id: string, updates: Record<string, any>) {
  const res = await request(app).put(`/api/elements/${id}`).send({ id, ...updates });
  expect(res.status).toBe(200);
  return res.body.element as Record<string, any>;
}

function dbEl(id: string): Record<string, any> {
  const el = getElement(id);
  expect(el, `Element ${id} not found in DB`).toBeDefined();
  return el as Record<string, any>;
}

// ── Universal fields ──────────────────────────────────────────────────────────

describe('universal fields — filled on create', () => {
  it('populates all universal fields with correct default values for a minimal rectangle', async () => {
    await createElement({ type: 'rectangle', id: 'u-rect', x: 0, y: 0, width: 100, height: 50 });
    const el = dbEl('u-rect');

    // Presence
    for (const field of UNIVERSAL_FIELDS) {
      expect(el, `field "${field}" missing`).toHaveProperty(field);
    }

    // Specific default values
    expect(el.angle).toBe(0);
    expect(el.strokeColor).toBe('#1e1e1e');
    expect(el.backgroundColor).toBe('transparent');
    expect(el.fillStyle).toBe('solid');
    expect(el.strokeWidth).toBe(2);
    expect(el.strokeStyle).toBe('solid');
    expect(el.roughness).toBe(1);
    expect(el.opacity).toBe(100);
    expect(el.groupIds).toEqual([]);
    expect(el.frameId).toBeNull();
    expect(el.link).toBeNull();
    expect(el.locked).toBe(false);
    expect(el.isDeleted).toBe(false);
    expect(el.boundElements).toBeNull();
    expect(typeof el.seed).toBe('number');
    expect(typeof el.versionNonce).toBe('number');
    expect(typeof el.updated).toBe('number');
    expect(typeof el.index).toBe('string');
    expect(el.index.length).toBeGreaterThan(0);
  });

  it('populates universal fields via batch create', async () => {
    await batchCreate([{ type: 'rectangle', id: 'u-batch', x: 0, y: 0, width: 100, height: 50 }]);
    const el = dbEl('u-batch');
    expect(typeof el.seed).toBe('number');
    expect(typeof el.index).toBe('string');
    expect(el.isDeleted).toBe(false);
  });

  it('populates universal fields via sync/v2 upsert', async () => {
    await syncV2([{
      id: 'u-sync', action: 'upsert',
      element: { id: 'u-sync', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
    }]);
    const el = dbEl('u-sync');
    expect(typeof el.seed).toBe('number');
    expect(typeof el.index).toBe('string');
    expect(el.isDeleted).toBe(false);
  });

  it('does not overwrite existing seed/versionNonce/index on update', async () => {
    await createElement({ type: 'rectangle', id: 'u-stable', x: 0, y: 0, width: 100, height: 50 });
    const before = dbEl('u-stable');
    await updateElement('u-stable', { x: 50 });
    const after = dbEl('u-stable');
    expect(after.seed).toBe(before.seed);
    expect(after.index).toBe(before.index);
  });

  it('preserves caller-supplied seed and index', async () => {
    await createElement({
      type: 'rectangle', id: 'u-supplied', x: 0, y: 0, width: 100, height: 50,
      seed: 12345678, index: 'aZZ',
    });
    const el = dbEl('u-supplied');
    expect(el.seed).toBe(12345678);
    expect(el.index).toBe('aZZ');
  });
});

// ── roundness ─────────────────────────────────────────────────────────────────

describe('roundness defaults', () => {
  it.each(['rectangle', 'diamond', 'ellipse'])(
    '%s gets roundness { type: 3 } by default',
    async (type) => {
      await createElement({ type, id: `rnd-${type}`, x: 0, y: 0, width: 100, height: 50 });
      const el = dbEl(`rnd-${type}`);
      expect(el.roundness).toEqual({ type: 3 });
    }
  );

  it.each(['arrow', 'line', 'text'])(
    '%s gets roundness null by default',
    async (type) => {
      const extra: Record<string, any> = type === 'text' ? { text: 'hi' } : {};
      await createElement({ type, id: `rnd-${type}`, x: 0, y: 0, width: 100, height: 50, ...extra });
      const el = dbEl(`rnd-${type}`);
      expect(el.roundness).toBeNull();
    }
  );

  it('preserves explicit roundness: null on a rectangle', async () => {
    await createElement({
      type: 'rectangle', id: 'rnd-explicit-null', x: 0, y: 0, width: 100, height: 50,
      roundness: null,
    });
    const el = dbEl('rnd-explicit-null');
    expect(el.roundness).toBeNull();
  });
});

// ── Type-specific: text ───────────────────────────────────────────────────────

describe('text element — type-specific fields', () => {
  it('fills all type-specific fields with correct default values', async () => {
    await createElement({ type: 'text', id: 'txt-1', x: 0, y: 0, text: 'hello' });
    const el = dbEl('txt-1');
    expect(el.text).toBe('hello');
    expect(el.originalText).toBe('hello');
    expect(el.fontSize).toBe(20);
    expect(el.fontFamily).toBe(5);
    expect(el.textAlign).toBe('left');
    expect(el.verticalAlign).toBe('top');  // no containerId
    expect(el.autoResize).toBe(true);
    expect(el.lineHeight).toBe(1.25);
    expect(el.containerId).toBeNull();
  });

  it('defaults text to empty string when omitted', async () => {
    await createElement({ type: 'text', id: 'txt-empty', x: 0, y: 0 });
    const el = dbEl('txt-empty');
    expect(el.text).toBe('');
    expect(el.originalText).toBe('');
  });

  it('sets verticalAlign to "middle" when containerId is present', async () => {
    await createElement({ type: 'rectangle', id: 'txt-container', x: 0, y: 0, width: 200, height: 80 });
    await createElement({
      type: 'text', id: 'txt-bound', x: 10, y: 30, text: 'bound',
      containerId: 'txt-container',
    });
    const el = dbEl('txt-bound');
    expect(el.verticalAlign).toBe('middle');
  });

  it('preserves caller-supplied autoResize: false and lineHeight', async () => {
    await createElement({
      type: 'text', id: 'txt-custom', x: 0, y: 0, text: 'hi',
      autoResize: false, lineHeight: 1.5,
    });
    const el = dbEl('txt-custom');
    expect(el.autoResize).toBe(false);
    expect(el.lineHeight).toBe(1.5);
  });
});

// ── Type-specific: arrow ──────────────────────────────────────────────────────

describe('arrow element — type-specific fields', () => {
  it('fills points, lastCommittedPoint, startBinding, endBinding, endArrowhead, elbowed', async () => {
    await createElement({ type: 'arrow', id: 'arr-1', x: 0, y: 0, width: 100, height: 0 });
    const el = dbEl('arr-1');
    expect(Array.isArray(el.points)).toBe(true);
    expect(el.lastCommittedPoint).toBeNull();
    expect(el.startBinding).toBeNull();
    expect(el.endBinding).toBeNull();
    expect(el.endArrowhead).toBe('arrow');
    expect(el.startArrowhead).toBeNull();
    expect(el.elbowed).toBe(false);
  });
});

describe('line element — type-specific fields', () => {
  it('fills all type-specific fields with correct default values', async () => {
    await createElement({ type: 'line', id: 'line-1', x: 0, y: 0, width: 100, height: 0 });
    const el = dbEl('line-1');
    expect(Array.isArray(el.points)).toBe(true);
    expect(el.lastCommittedPoint).toBeNull();
    expect(el.startBinding).toBeNull();
    expect(el.endBinding).toBeNull();
    expect(el.startArrowhead).toBeNull();
    expect(el.endArrowhead).toBeNull();  // null for line, 'arrow' only for arrow type
    expect(el.elbowed).toBe(false);
  });
});

// ── Type-specific: image ──────────────────────────────────────────────────────

describe('image element — type-specific fields', () => {
  it('fills status and scale', async () => {
    await createElement({ type: 'image', id: 'img-1', x: 0, y: 0, width: 100, height: 100 });
    const el = dbEl('img-1');
    expect(el.status).toBe('pending');
    expect(el.scale).toEqual([1, 1]);
  });
});

// ── Type-specific: freedraw ───────────────────────────────────────────────────

describe('freedraw element — type-specific fields', () => {
  it('fills points, pressures, simulatePressure, lastCommittedPoint', async () => {
    await createElement({ type: 'freedraw', id: 'fd-1', x: 0, y: 0, width: 10, height: 10 });
    const el = dbEl('fd-1');
    expect(Array.isArray(el.points)).toBe(true);
    expect(Array.isArray(el.pressures)).toBe(true);
    expect(el.simulatePressure).toBe(true);
    expect(el.lastCommittedPoint).toBeNull();
  });
});

// ── Zod passthrough ───────────────────────────────────────────────────────────

describe('Zod schema passthrough — unknown native fields preserved', () => {
  it('preserves extra Excalidraw fields not in schema (e.g. customData)', async () => {
    await createElement({
      type: 'rectangle', id: 'pass-1', x: 0, y: 0, width: 100, height: 50,
      customData: { myKey: 'myValue' },
    });
    const el = dbEl('pass-1');
    expect(el.customData).toEqual({ myKey: 'myValue' });
  });

  it('preserves autoResize passed to a non-text element without stripping', async () => {
    // autoResize is not in the shared schema explicitly — should pass through
    await createElement({
      type: 'rectangle', id: 'pass-2', x: 0, y: 0, width: 100, height: 50,
      autoResize: true,
    });
    const el = dbEl('pass-2');
    expect(el.autoResize).toBe(true);
  });
});

// ── repairContainerBinding ────────────────────────────────────────────────────

describe('repairContainerBinding — bidirectional binding enforced on all write paths', () => {
  it('POST /api/elements: text with containerId repairs container.boundElements', async () => {
    await createElement({ type: 'rectangle', id: 'rb-box', x: 0, y: 0, width: 200, height: 80 });
    await createElement({
      type: 'text', id: 'rb-txt', x: 10, y: 30, text: 'hi',
      containerId: 'rb-box',
    });
    const box = dbEl('rb-box');
    expect(Array.isArray(box.boundElements)).toBe(true);
    expect((box.boundElements as any[]).some((b: any) => b.id === 'rb-txt')).toBe(true);
  });

  it('batch create: repairs binding for all text elements in the batch', async () => {
    await batchCreate([
      { id: 'rb-b-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 },
      { id: 'rb-b-txt', type: 'text', x: 10, y: 30, text: 'hi', containerId: 'rb-b-box' },
    ]);
    const box = dbEl('rb-b-box');
    expect((box.boundElements as any[]).some((b: any) => b.id === 'rb-b-txt')).toBe(true);
  });

  it('sync/v2: repairs binding when text with containerId is upserted', async () => {
    await syncV2([
      { id: 'rb-s-box', action: 'upsert',
        element: { id: 'rb-s-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 } },
      { id: 'rb-s-txt', action: 'upsert',
        element: { id: 'rb-s-txt', type: 'text', x: 10, y: 30, text: 'hi', containerId: 'rb-s-box' } },
    ]);
    const box = dbEl('rb-s-box');
    expect((box.boundElements as any[]).some((b: any) => b.id === 'rb-s-txt')).toBe(true);
  });

  it('PUT /api/elements: repairs binding when containerId is added via update', async () => {
    await createElement({ type: 'rectangle', id: 'rb-u-box', x: 0, y: 0, width: 200, height: 80 });
    await createElement({ type: 'text', id: 'rb-u-txt', x: 10, y: 30, text: 'hi' });
    // containerId added via update
    await updateElement('rb-u-txt', { containerId: 'rb-u-box' });
    const box = dbEl('rb-u-box');
    expect((box.boundElements as any[]).some((b: any) => b.id === 'rb-u-txt')).toBe(true);
  });

  it('does not duplicate boundElements entry if already present', async () => {
    await createElement({ type: 'rectangle', id: 'rb-dup-box', x: 0, y: 0, width: 200, height: 80 });
    await createElement({
      type: 'text', id: 'rb-dup-txt', x: 10, y: 30, text: 'hi',
      containerId: 'rb-dup-box',
    });
    // Update the text again — binding should not be duplicated
    await updateElement('rb-dup-txt', { x: 20 });
    const box = dbEl('rb-dup-box');
    const refs = (box.boundElements as any[]).filter((b: any) => b.id === 'rb-dup-txt');
    expect(refs.length).toBe(1);
  });

  it('text without containerId does not touch any container', async () => {
    await createElement({ type: 'rectangle', id: 'rb-free-box', x: 0, y: 0, width: 200, height: 80 });
    await createElement({ type: 'text', id: 'rb-free-txt', x: 10, y: 30, text: 'standalone' });
    const box = dbEl('rb-free-box');
    // boundElements should remain null / empty — not modified
    const refs = (box.boundElements as any[] | null) ?? [];
    expect(refs.filter((b: any) => b.id === 'rb-free-txt').length).toBe(0);
  });
});

// ── Export: version and updated preserved ────────────────────────────────────

describe('version and updated preserved in DB (export source)', () => {
  it('stores the correct version after updates', async () => {
    await createElement({ type: 'rectangle', id: 'ver-1', x: 0, y: 0, width: 100, height: 50 });
    await updateElement('ver-1', { x: 10 });
    await updateElement('ver-1', { x: 20 });
    const el = dbEl('ver-1');
    expect(el.version).toBeGreaterThanOrEqual(2);
  });

  it('stores a numeric updated timestamp', async () => {
    const before = Date.now();
    await createElement({ type: 'rectangle', id: 'upd-1', x: 0, y: 0, width: 100, height: 50 });
    const after = Date.now();
    const el = dbEl('upd-1');
    expect(typeof el.updated).toBe('number');
    expect(el.updated).toBeGreaterThanOrEqual(before);
    expect(el.updated).toBeLessThanOrEqual(after + 5);
  });

  it('preserves caller-supplied updated timestamp', async () => {
    const ts = 1700000000000;
    await createElement({
      type: 'rectangle', id: 'upd-2', x: 0, y: 0, width: 100, height: 50,
      updated: ts,
    });
    const el = dbEl('upd-2');
    expect(el.updated).toBe(ts);
  });
});

// ── No duplicate bound text on export ────────────────────────────────────────

describe('GET /api/elements — no duplicate text from native bound elements', () => {
  it('returns both container and its native bound text without duplication', async () => {
    await batchCreate([
      { id: 'exp-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 },
      {
        id: 'exp-txt', type: 'text', x: 10, y: 30, text: 'label',
        containerId: 'exp-box',
      },
    ]);

    const res = await request(app).get('/api/elements');
    expect(res.status).toBe(200);
    const elements: Record<string, any>[] = res.body.elements;

    const textEls = elements.filter(e => e.type === 'text');
    const labelEls = textEls.filter(e => e.id === 'exp-txt' || e.id === 'exp-box-label');
    // Only one text element should exist — the native one, not a generated duplicate
    expect(labelEls.length).toBe(1);
    expect(labelEls[0].id).toBe('exp-txt');
  });
});

// ── Label materialization ─────────────────────────────────────────────────────

describe('materializeLabel — POST /api/elements with label.text or text on a shape', () => {
  function dbEl(id: string) {
    return getElement(id) as Record<string, any>;
  }

  it('stores a native bound text element when shape is created with label.text', async () => {
    const res = await request(app).post('/api/elements').send({
      type: 'rectangle', id: 'ml-rect', x: 0, y: 0, width: 200, height: 80,
      label: { text: 'Hello' },
    });
    expect(res.status).toBe(200);

    // Container must NOT have label field
    const container = dbEl('ml-rect');
    expect(container.label).toBeUndefined();

    // Bound text must exist in DB
    const bt = dbEl('ml-rect-label');
    expect(bt).toBeTruthy();
    expect(bt.type).toBe('text');
    expect(bt.text).toBe('Hello');
    expect(bt.containerId).toBe('ml-rect');
  });

  it('stores a native bound text element when shape is created with text field', async () => {
    await request(app).post('/api/elements').send({
      type: 'ellipse', id: 'ml-ell', x: 0, y: 0, width: 100, height: 60,
      text: 'World',
    });

    const container = dbEl('ml-ell');
    expect((container as any).text).toBeUndefined();

    const bt = dbEl('ml-ell-label');
    expect(bt).toBeTruthy();
    expect(bt.text).toBe('World');
    expect(bt.containerId).toBe('ml-ell');
  });

  it('container boundElements includes reference to the bound text', async () => {
    await request(app).post('/api/elements').send({
      type: 'diamond', id: 'ml-dia', x: 0, y: 0, width: 120, height: 80,
      label: { text: 'Decision' },
    });

    const container = dbEl('ml-dia');
    const bound = container.boundElements as Array<{ id: string; type: string }>;
    expect(Array.isArray(bound)).toBe(true);
    expect(bound.some(b => b.id === 'ml-dia-label' && b.type === 'text')).toBe(true);
  });

  it('bound text has correct native fields (containerId, verticalAlign, autoResize, lineHeight)', async () => {
    await request(app).post('/api/elements').send({
      type: 'rectangle', id: 'ml-fields', x: 0, y: 0, width: 200, height: 80,
      label: { text: 'Check fields' },
    });

    const bt = dbEl('ml-fields-label');
    expect(bt.containerId).toBe('ml-fields');
    expect(bt.verticalAlign).toBe('middle');
    expect(bt.autoResize).toBe(true);
    expect(bt.lineHeight).toBe(1.25);
    expect(bt.textAlign).toBe('center');
  });

  it('response includes boundTextElement in the API response', async () => {
    const res = await request(app).post('/api/elements').send({
      type: 'rectangle', id: 'ml-resp', x: 0, y: 0, width: 200, height: 80,
      label: { text: 'Response test' },
    });
    expect(res.status).toBe(200);
    expect(res.body.boundTextElement).toBeTruthy();
    expect(res.body.boundTextElement.text).toBe('Response test');
  });

  it('shapes without text are not affected (no extra element created)', async () => {
    await request(app).post('/api/elements').send({
      type: 'rectangle', id: 'ml-notxt', x: 0, y: 0, width: 100, height: 50,
    });

    const container = dbEl('ml-notxt');
    expect(container).toBeTruthy();
    // No synthetic bound text should be stored
    expect(dbEl('ml-notxt-label')).toBeFalsy();
  });

  it('text elements themselves are not materialized (only shapes)', async () => {
    await request(app).post('/api/elements').send({
      type: 'text', id: 'ml-txt-el', x: 0, y: 0, width: 100, height: 40,
      text: 'standalone',
    });

    const el = dbEl('ml-txt-el');
    expect(el.type).toBe('text');
    // text field preserved on text elements
    expect(el.text).toBe('standalone');
  });

  it('batch create: materializes label for all shapes in the batch', async () => {
    const res = await request(app).post('/api/elements/batch').send({
      elements: [
        { id: 'ml-b1', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: { text: 'Box A' } },
        { id: 'ml-b2', type: 'ellipse', x: 300, y: 0, width: 150, height: 80, label: { text: 'Box B' } },
      ],
    });
    expect(res.status).toBe(200);

    expect(dbEl('ml-b1-label').text).toBe('Box A');
    expect(dbEl('ml-b2-label').text).toBe('Box B');
    expect(dbEl('ml-b1').label).toBeUndefined();
    expect(dbEl('ml-b2').label).toBeUndefined();
  });

  it('PUT /api/elements: updating label.text updates the bound text element', async () => {
    await request(app).post('/api/elements').send({
      type: 'rectangle', id: 'ml-upd', x: 0, y: 0, width: 200, height: 80,
      label: { text: 'Original' },
    });

    const res = await request(app).put('/api/elements/ml-upd').send({
      id: 'ml-upd', label: { text: 'Updated' },
    });
    expect(res.status).toBe(200);

    const bt = dbEl('ml-upd-label');
    expect(bt.text).toBe('Updated');
    expect(bt.originalText).toBe('Updated');
  });

  it('PUT /api/elements: updating label does not create a duplicate bound text', async () => {
    await request(app).post('/api/elements').send({
      type: 'rectangle', id: 'ml-nodup', x: 0, y: 0, width: 200, height: 80,
      label: { text: 'First' },
    });
    await request(app).put('/api/elements/ml-nodup').send({
      id: 'ml-nodup', label: { text: 'Second' },
    });

    const container = dbEl('ml-nodup');
    const bound = container.boundElements as Array<{ id: string; type: string }>;
    const textRefs = bound.filter(b => b.type === 'text');
    expect(textRefs.length).toBe(1);
  });
});
