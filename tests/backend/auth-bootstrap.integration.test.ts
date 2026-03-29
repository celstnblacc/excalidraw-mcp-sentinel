import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  initDb,
  closeDb,
  clearElements,
  ensureTenant,
  getDefaultProjectForTenant,
  setActiveTenant,
  setElement,
} from '../../src/db.js';
import type { ServerElement } from '../../src/types.js';
import WebSocket from 'ws';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let port: number;
let startCanvasServer: () => Promise<void>;
let stopCanvasServer: () => Promise<void>;
const frontendDir = path.join(process.cwd(), 'dist/frontend');
const frontendHtmlPath = path.join(frontendDir, 'index.html');
let originalFrontendHtml: string | null = null;
let hadFrontendHtml = false;

function waitForMessageOfType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for message type: ${type}`)), timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

function connectAndCollect(waitMs = 200): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => setTimeout(() => resolve({ ws, messages }), waitMs));
    ws.on('error', reject);
  });
}

beforeAll(async () => {
  port = 3500 + Math.floor(Math.random() * 100);
  process.env.CANVAS_PORT = String(port);
  process.env.HOST = 'localhost';
  process.env.EXCALIDRAW_API_KEY = 'integration-secret';

  dbPath = path.join(os.tmpdir(), `excalidraw-auth-integration-${Date.now()}.db`);
  initDb(dbPath);

  hadFrontendHtml = fs.existsSync(frontendHtmlPath);
  originalFrontendHtml = hadFrontendHtml ? fs.readFileSync(frontendHtmlPath, 'utf8') : null;
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.writeFileSync(frontendHtmlPath, '<!doctype html><html><head><title>Integration</title></head><body><div id="root"></div></body></html>');

  const mod = await import('../../src/server.js');
  startCanvasServer = mod.startCanvasServer;
  stopCanvasServer = mod.stopCanvasServer;
  await startCanvasServer();
});

afterAll(async () => {
  delete process.env.EXCALIDRAW_API_KEY;
  await stopCanvasServer();
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

beforeEach(() => {
  setActiveTenant('default');
  clearElements();
});

describe('Auth bootstrap integration', () => {
  it('serves injected HTML, authenticates over WS, and reads scoped REST data', async () => {
    ensureTenant('integration-a', 'Integration A', 'workspace/integration-a');
    setActiveTenant('integration-a');
    const projectId = getDefaultProjectForTenant('integration-a');
    setElement('integration-el', {
      id: 'integration-el',
      type: 'rectangle',
      x: 25,
      y: 30,
      width: 120,
      height: 80,
      version: 1,
    } as ServerElement, projectId);

    const rootRes = await fetch(`http://localhost:${port}/`);
    expect(rootRes.status).toBe(200);
    const html = await rootRes.text();
    expect(html).toContain('window.__EXCALIDRAW_API_KEY__="integration-secret"');

    const { ws, messages } = await connectAndCollect();
    expect(messages.some(message => message.type === 'auth_required')).toBe(true);

    const ackPromise = waitForMessageOfType(ws, 'hello_ack');
    ws.send(JSON.stringify({ type: 'hello', apiKey: 'integration-secret' }));
    const ack = await ackPromise;

    expect(ack.tenantId).toBe('integration-a');
    expect(ack.projectId).toBe(projectId);
    expect(ack.elements.map((element: any) => element.id)).toContain('integration-el');

    const listRes = await fetch(`http://localhost:${port}/api/elements`, {
      headers: {
        'X-API-Key': 'integration-secret',
        'X-Tenant-Id': 'integration-a',
      },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { count: number; elements: { id: string }[] };
    expect(listBody.count).toBe(1);
    expect(listBody.elements[0].id).toBe('integration-el');

    ws.close();
  });

  it('authenticated WS clients receive tenant_switched after a keyed REST switch', async () => {
    ensureTenant('integration-b', 'Integration B', 'workspace/integration-b');
    ensureTenant('integration-c', 'Integration C', 'workspace/integration-c');
    setActiveTenant('integration-b');

    const { ws, messages } = await connectAndCollect();
    expect(messages.some(message => message.type === 'auth_required')).toBe(true);
    const ackPromise = waitForMessageOfType(ws, 'hello_ack');
    ws.send(JSON.stringify({ type: 'hello', apiKey: 'integration-secret' }));
    const ack = await ackPromise;
    expect(ack.tenantId).toBe('integration-b');

    const switchPromise = waitForMessageOfType(ws, 'tenant_switched');
    const switchRes = await fetch(`http://localhost:${port}/api/tenant/active`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'integration-secret',
      },
      body: JSON.stringify({ tenantId: 'integration-c' }),
    });

    expect(switchRes.status).toBe(200);
    const switched = await switchPromise;
    expect(switched.tenant.id).toBe('integration-c');

    ws.close();
  });
});
