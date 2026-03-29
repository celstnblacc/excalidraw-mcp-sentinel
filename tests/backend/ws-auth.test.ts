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

function connectAndCollect(waitMs = 300): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => setTimeout(() => resolve({ ws, messages }), waitMs));
    ws.on('error', reject);
  });
}

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

function waitForClose(ws: WebSocket, timeoutMs = 7000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for close')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function collectMessagesFor(ws: WebSocket, durationMs: number): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    const handler = (data: WebSocket.RawData) => messages.push(JSON.parse(data.toString()));
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

beforeAll(async () => {
  port = 3400 + Math.floor(Math.random() * 100);
  process.env.CANVAS_PORT = String(port);
  process.env.HOST = 'localhost';

  dbPath = path.join(os.tmpdir(), `excalidraw-ws-auth-test-${Date.now()}.db`);
  initDb(dbPath);

  const mod = await import('../../src/server.js');
  startCanvasServer = mod.startCanvasServer;
  stopCanvasServer = mod.stopCanvasServer;
  await startCanvasServer();
});

afterAll(async () => {
  delete process.env.EXCALIDRAW_API_KEY;
  await stopCanvasServer();
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

beforeEach(() => {
  delete process.env.EXCALIDRAW_API_KEY;
  setActiveTenant('default');
  clearElements();
});

describe('WebSocket auth gate', () => {
  it('auth enabled: WS connection receives auth_required and no element data before hello', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const { ws, messages } = await connectAndCollect();

    const types = messages.map(m => m.type);
    expect(types).toContain('auth_required');
    expect(types).not.toContain('tenant_switched');
    expect(types).not.toContain('initial_elements');
    expect(types).not.toContain('files_added');
    expect(types).not.toContain('sync_status');

    ws.terminate();
  });

  it('auth enabled: WS closes with 4001 if no valid hello arrives within 5s', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const { ws, messages } = await connectAndCollect();
    expect(messages.some(m => m.type === 'auth_required')).toBe(true);

    const authFailedPromise = waitForMessageOfType(ws, 'auth_failed', 7000);
    const closePromise = waitForClose(ws, 7000);
    const [authFailed, close] = await Promise.all([authFailedPromise, closePromise]);

    expect(authFailed.reason).toBe('timeout');
    expect(close.code).toBe(4001);
  });

  it('auth enabled: hello with valid apiKey and no tenantId bootstraps the active tenant', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    ensureTenant('boot-tenant', 'Boot Tenant', 'workspace/boot-tenant');
    setActiveTenant('boot-tenant');

    const { ws, messages } = await connectAndCollect();
    expect(messages.some(m => m.type === 'auth_required')).toBe(true);

    const ackPromise = waitForMessageOfType(ws, 'hello_ack', 5000);
    ws.send(JSON.stringify({ type: 'hello', apiKey: 'test-secret' }));
    const ack = await ackPromise;

    expect(ack.tenantId).toBe('boot-tenant');
    expect(ack.tenant.id).toBe('boot-tenant');
    expect(ack.projectId).toBe(getDefaultProjectForTenant('boot-tenant'));

    ws.close();
  });

  it('auth enabled: hello with wrong apiKey sends auth_failed and closes 4001', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const { ws, messages } = await connectAndCollect();
    expect(messages.some(m => m.type === 'auth_required')).toBe(true);

    const authFailedPromise = waitForMessageOfType(ws, 'auth_failed', 5000);
    const closePromise = waitForClose(ws, 5000);

    ws.send(JSON.stringify({ type: 'hello', apiKey: 'wrong-key' }));

    const [authFailed, close] = await Promise.all([authFailedPromise, closePromise]);
    expect(authFailed.reason).toBe('invalid_key');
    expect(close.code).toBe(4001);
  });

  it('auth enabled: hello with valid apiKey and unknown tenantId sends error and no elements', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    const { ws, messages } = await connectAndCollect();
    expect(messages.some(m => m.type === 'auth_required')).toBe(true);

    const errorPromise = waitForMessageOfType(ws, 'error', 5000);
    ws.send(JSON.stringify({ type: 'hello', apiKey: 'test-secret', tenantId: 'missing-tenant' }));

    const error = await errorPromise;
    expect(error.message).toBe('Unknown tenant');

    const trailingMessages = await collectMessagesFor(ws, 300);
    expect(trailingMessages.some(msg => msg.type === 'hello_ack')).toBe(false);

    ws.close();
  });

  it('auth enabled: invalid projectId falls back to the tenant default project', async () => {
    process.env.EXCALIDRAW_API_KEY = 'test-secret';
    ensureTenant('scope-a', 'Scope A', 'workspace/scope-a');
    ensureTenant('scope-b', 'Scope B', 'workspace/scope-b');

    const defaultProjectId = getDefaultProjectForTenant('scope-a');
    const otherProjectId = getDefaultProjectForTenant('scope-b');

    setElement('scope-a-element', {
      id: 'scope-a-element',
      type: 'rectangle',
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      version: 1,
    } as ServerElement, defaultProjectId);
    setElement('scope-b-element', {
      id: 'scope-b-element',
      type: 'ellipse',
      x: 20,
      y: 20,
      width: 60,
      height: 60,
      version: 1,
    } as ServerElement, otherProjectId);

    const { ws, messages } = await connectAndCollect();
    expect(messages.some(m => m.type === 'auth_required')).toBe(true);

    const ackPromise = waitForMessageOfType(ws, 'hello_ack', 5000);
    ws.send(JSON.stringify({
      type: 'hello',
      apiKey: 'test-secret',
      tenantId: 'scope-a',
      projectId: otherProjectId,
    }));

    const ack = await ackPromise;
    expect(ack.tenantId).toBe('scope-a');
    expect(ack.projectId).toBe(defaultProjectId);
    expect(ack.elements.map((element: any) => element.id)).toContain('scope-a-element');
    expect(ack.elements.map((element: any) => element.id)).not.toContain('scope-b-element');

    ws.close();
  });

  it('auth disabled: WS connection receives tenant_switched and initial_elements immediately', async () => {
    delete process.env.EXCALIDRAW_API_KEY;
    const { ws, messages } = await connectAndCollect();

    const types = messages.map(m => m.type);
    expect(types).toContain('tenant_switched');
    expect(types).toContain('initial_elements');
    expect(types).toContain('sync_status');
    expect(types).not.toContain('auth_required');

    ws.close();
  });

  it('auth disabled: hello without apiKey still works and receives hello_ack', async () => {
    delete process.env.EXCALIDRAW_API_KEY;
    const { ws } = await connectAndCollect();
    const ackPromise = waitForMessageOfType(ws, 'hello_ack', 5000);

    ws.send(JSON.stringify({ type: 'hello', tenantId: 'default' }));

    const ack = await ackPromise;
    expect(ack.tenantId).toBe('default');
    expect(Array.isArray(ack.elements)).toBe(true);

    ws.close();
  });
});
