/**
 * Streamable HTTP transport wiring for the MCP server.
 *
 * Lets a single long-lived process serve many MCP clients over HTTP instead of
 * each client spawning its own stdio process. Each client session gets its own
 * MCP `Server` instance (cheap in-process object) routed by `mcp-session-id`.
 */
import type { Application, Request, Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type TransportMode = 'stdio' | 'http';

/** Decide transport from the environment. stdio is the default (back-compat). */
export function resolveTransportMode(env: NodeJS.ProcessEnv): TransportMode {
  return (env['MCP_TRANSPORT'] || '').toLowerCase() === 'http' ? 'http' : 'stdio';
}

/**
 * Mount POST/GET/DELETE `/mcp` routes on an existing Express app.
 *
 * @param app           the Express app (shares the canvas server's httpServer)
 * @param createServer  factory returning a fresh MCP `Server` per session
 */
export function mountMcpRoutes(app: Application, createServer: () => Server): void {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  // Dedicated parser so /mcp accepts larger bodies than the canvas API's 100kb cap.
  const jsonParser = express.json({ limit: '5mb' });

  app.post('/mcp', jsonParser, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Plain JSON responses (no SSE) — clean request/response for Claude clients.
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      const server = createServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session ID' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId]!.handleRequest(req, res);
  };

  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);
}

/**
 * Start a dedicated HTTP server hosting the MCP `/mcp` endpoint on its own port.
 *
 * Kept independent of the canvas server so MCP stays reachable even when the
 * canvas port is owned/reused by another process.
 *
 * @returns the listening http.Server (resolves once bound)
 */
export function startMcpHttpServer(
  createServer: () => Server,
  port: number,
  host = '127.0.0.1',
): Promise<HttpServer> {
  const app = express();
  mountMcpRoutes(app, createServer);
  return new Promise<HttpServer>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => resolve(httpServer));
    httpServer.on('error', reject);
  });
}
