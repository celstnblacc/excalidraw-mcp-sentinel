/**
 * Security middleware for excalidraw-mcp-sentinel.
 *
 * All env vars are read at request/connection time (not at module init)
 * so that tests can mutate process.env between cases.
 */

import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { IncomingMessage } from 'http';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAllowedOrigins(): string[] {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  }
  return ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

function getEnvInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isAuthEnabled(): boolean {
  return !!process.env.EXCALIDRAW_API_KEY;
}

export function validateApiKey(provided: string | string[] | undefined): boolean {
  const required = process.env.EXCALIDRAW_API_KEY;
  if (!required) return true;
  if (typeof provided !== 'string') return false;
  // Use timing-safe comparison to prevent timing-based key enumeration.
  const a = Buffer.from(provided);
  const b = Buffer.from(required);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Security Headers (helmet) ─────────────────────────────────────────────────
// Sets X-Content-Type-Options, X-Frame-Options, X-DNS-Prefetch-Control, etc.
// Disables X-Powered-By to avoid fingerprinting.
// CSP is left permissive here (Excalidraw needs inline scripts/styles for React).
export const helmetMiddleware = helmet({
  contentSecurityPolicy: false, // Excalidraw's React bundle needs inline evaluation
  crossOriginEmbedderPolicy: false, // Allow embedding Excalidraw assets
});

// ── CORS ─────────────────────────────────────────────────────────────────────
// Restrict to an explicit allowlist. `cors()` with no config defaults to
// wildcard (*) which lets any website make cross-origin calls to the canvas
// server — a security risk for local use.

export const corsMiddleware = cors({
  origin(origin, callback) {
    // No Origin header = curl / MCP stdio / same-origin request — always allow.
    if (!origin) return callback(null, true);
    if (getAllowedOrigins().includes(origin)) return callback(null, origin);
    // Deny: return false so cors does not set ACAO header.
    // The browser will block the response; the server stays available.
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Tenant-Id', 'X-API-Key'],
});

// ── API Key Auth ──────────────────────────────────────────────────────────────
// When EXCALIDRAW_API_KEY is not set, auth is disabled (dev / backward-compat mode).
// Set the env var to protect all /api/* routes.
// /health is exempt so monitoring tools work without credentials.

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // Auth disabled — pass through.
  if (!isAuthEnabled()) return next();

  const provided = req.headers['x-api-key'];
  if (!validateApiKey(provided)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  next();
}

// ── Prototype Pollution Guard ─────────────────────────────────────────────────
// Strip (and reject) dangerous prototype-chain keys from req.body before any
// route handler sees the data. These keys are safe in JSON.parse on modern V8
// but can cause issues downstream with Object.assign / spread patterns.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasDangerousKey(obj: unknown, depth = 0): boolean {
  if (depth > 10 || obj === null || typeof obj !== 'object') return false;
  for (const key of Object.keys(obj as object)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    if (hasDangerousKey((obj as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

export function sanitizeBody(req: Request, res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object' && hasDangerousKey(req.body)) {
    res.status(400).json({ success: false, error: 'Request body contains disallowed keys.' });
    return;
  }
  next();
}

// ── Mermaid Input Validation ──────────────────────────────────────────────────
const MAX_MERMAID_LENGTH = 50 * 1024; // 50 KB
const MAX_MERMAID_CONFIG_KEYS = 10;

export function validateMermaidInput(req: Request, res: Response, next: NextFunction): void {
  const { mermaidDiagram, config } = req.body ?? {};

  if (typeof mermaidDiagram === 'string' && mermaidDiagram.length > MAX_MERMAID_LENGTH) {
    res.status(400).json({ success: false, error: 'Mermaid diagram exceeds maximum allowed size (50 KB).' });
    return;
  }

  if (config !== undefined && config !== null && typeof config === 'object' && !Array.isArray(config)) {
    if (Object.keys(config as object).length > MAX_MERMAID_CONFIG_KEYS) {
      res.status(400).json({ success: false, error: `Mermaid config must not exceed ${MAX_MERMAID_CONFIG_KEYS} keys.` });
      return;
    }
  }

  next();
}

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// General limit for all /api routes.
export const generalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: getEnvInt('EXCALIDRAW_RATE_LIMIT_GENERAL_MAX', 500),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});

// Stricter limit for destructive clear operations.
export const destructiveRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: getEnvInt('EXCALIDRAW_RATE_LIMIT_DESTRUCTIVE_MAX', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many destructive operations, please slow down.' },
});

// Stricter limit for write-heavy sync operations.
export const writeBurstLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: getEnvInt('EXCALIDRAW_RATE_LIMIT_WRITE_BURST_MAX', 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many sync operations, please slow down.' },
});

// ── Confirmation Guard ────────────────────────────────────────────────────────
// Requires ?confirm=true on destructive REST endpoints.
// Prevents accidental or CSRF-triggered data loss.
export function requireConfirm(req: Request, res: Response, next: NextFunction): void {
  if (req.query['confirm'] !== 'true') {
    res.status(400).json({
      success: false,
      error: 'Add ?confirm=true to confirm this destructive operation.',
    });
    return;
  }
  next();
}

// ── WebSocket Origin Check ────────────────────────────────────────────────────
// Passed to WebSocketServer({ verifyClient }) at server init.
// Reads allowed origins dynamically so env changes take effect without restart.

export function verifyWsClient(info: { req: IncomingMessage }): boolean {
  const origin = info.req.headers.origin;
  // No origin = non-browser client (MCP tool, curl) — allow.
  if (!origin) return true;
  return getAllowedOrigins().includes(origin);
}

export class InvalidSearchQueryError extends Error {
  constructor() {
    super('Invalid search query');
    this.name = 'InvalidSearchQueryError';
  }
}

export function sanitizeSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;

  // Keep search syntax simple and predictable by rejecting FTS operators
  // and quoting constructs that otherwise bubble SQLite parse errors.
  if (trimmed.includes('"')) {
    throw new InvalidSearchQueryError();
  }
  if (/\b(?:AND|OR|NOT|NEAR(?:\/\d+)?)\b/i.test(trimmed)) {
    throw new InvalidSearchQueryError();
  }
  if (/[*(){}^]/.test(trimmed)) {
    throw new InvalidSearchQueryError();
  }

  return trimmed;
}
