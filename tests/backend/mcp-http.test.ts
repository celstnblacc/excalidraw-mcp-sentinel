import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server as HttpServer } from 'node:http';
import { mountMcpRoutes, resolveTransportMode, startMcpHttpServer } from '../../src/mcp-http.js';

// A minimal real MCP server so the SDK initialize handshake succeeds.
function makeServer(): Server {
  const server = new Server(
    { name: 'test-shared-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return server;
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

const ACCEPT = 'application/json, text/event-stream';

describe('resolveTransportMode', () => {
  it('defaults to stdio when MCP_TRANSPORT is unset', () => {
    expect(resolveTransportMode({})).toBe('stdio');
  });

  it('returns http when MCP_TRANSPORT=http (case-insensitive)', () => {
    expect(resolveTransportMode({ MCP_TRANSPORT: 'http' })).toBe('http');
    expect(resolveTransportMode({ MCP_TRANSPORT: 'HTTP' })).toBe('http');
  });

  it('falls back to stdio for any other value', () => {
    expect(resolveTransportMode({ MCP_TRANSPORT: 'sse' })).toBe('stdio');
  });
});

describe('mountMcpRoutes', () => {
  let app: Express;
  let serverInstances: number;

  beforeEach(() => {
    serverInstances = 0;
    app = express();
    mountMcpRoutes(app, () => {
      serverInstances += 1;
      return makeServer();
    });
  });

  it('creates a session on initialize and returns a session id header', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', ACCEPT)
      .send(INIT_BODY);

    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeTruthy();
    expect(serverInstances).toBe(1);
  });

  it('gives each initialize its own isolated session id and server instance', async () => {
    const a = await request(app).post('/mcp').set('Accept', ACCEPT).send(INIT_BODY);
    const b = await request(app).post('/mcp').set('Accept', ACCEPT).send(INIT_BODY);

    expect(a.headers['mcp-session-id']).toBeTruthy();
    expect(b.headers['mcp-session-id']).toBeTruthy();
    expect(a.headers['mcp-session-id']).not.toBe(b.headers['mcp-session-id']);
    expect(serverInstances).toBe(2);
  });

  it('rejects a POST with no session id that is not an initialize request', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Accept', ACCEPT)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    expect(res.status).toBe(400);
  });

  it('rejects a GET with an unknown session id', async () => {
    const res = await request(app)
      .get('/mcp')
      .set('Accept', ACCEPT)
      .set('mcp-session-id', 'does-not-exist');

    expect(res.status).toBe(400);
  });

  it('tears down a session on DELETE with a valid session id', async () => {
    const init = await request(app).post('/mcp').set('Accept', ACCEPT).send(INIT_BODY);
    const sid = init.headers['mcp-session-id'];

    const del = await request(app)
      .delete('/mcp')
      .set('Accept', ACCEPT)
      .set('mcp-session-id', sid);

    expect(del.status).toBeLessThan(500);

    // After teardown the session id is no longer valid.
    const after = await request(app)
      .get('/mcp')
      .set('Accept', ACCEPT)
      .set('mcp-session-id', sid);
    expect(after.status).toBe(400);
  });
});

describe('startMcpHttpServer', () => {
  let httpServer: HttpServer;

  afterEach(() => {
    httpServer?.close();
  });

  it('listens on its own port and serves initialize', async () => {
    httpServer = await startMcpHttpServer(makeServer, 0); // port 0 = ephemeral
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const res = await request(`http://127.0.0.1:${port}`)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', ACCEPT)
      .send(INIT_BODY);

    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeTruthy();
  });
});
