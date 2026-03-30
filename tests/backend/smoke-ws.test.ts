import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { closeDb, initDb } from '../../src/db.js';

let port: number;
let dbPath: string;
let startCanvasServer: (() => Promise<void>) | undefined;
let stopCanvasServer: (() => Promise<void>) | undefined;

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

beforeAll(async () => {
  port = 3600 + Math.floor(Math.random() * 200);
  dbPath = path.join(os.tmpdir(), `excalidraw-smoke-ws-${Date.now()}.db`);

  process.env.CANVAS_PORT = String(port);
  process.env.HOST = 'localhost';
  delete process.env.EXCALIDRAW_API_KEY;
  process.env.EXCALIDRAW_DB_PATH = dbPath;

  initDb(dbPath);
  const serverMod = await import('../../src/server.js');
  startCanvasServer = serverMod.startCanvasServer;
  stopCanvasServer = serverMod.stopCanvasServer;
  await startCanvasServer();
});

afterAll(async () => {
  if (stopCanvasServer) {
    await stopCanvasServer();
  }
  closeDb();
  delete process.env.CANVAS_PORT;
  delete process.env.HOST;
  delete process.env.EXCALIDRAW_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe('Smoke WS + persistence checks', () => {
  it('creates SQLite database file', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('accepts WebSocket connection and reports websocket_clients in /health', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await waitForOpen(ws);

    const healthRes = await fetch(`http://localhost:${port}/health`);
    expect(healthRes.ok).toBe(true);
    const healthBody = await healthRes.json() as { websocket_clients: number; status: string };
    expect(healthBody.status).toBe('healthy');
    expect(healthBody.websocket_clients).toBeGreaterThanOrEqual(1);

    ws.close();
  });
});
