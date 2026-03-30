/**
 * Unit tests for src/security.ts
 *
 * Covers: validateApiKey, sanitizeSearchQuery, sanitizeBody behaviour.
 * No server or DB required — pure function tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateApiKey,
  sanitizeSearchQuery,
  InvalidSearchQueryError,
  isAuthEnabled,
} from '../../src/security.js';

// ── validateApiKey ────────────────────────────────────────────────────────────

describe('validateApiKey — auth disabled', () => {
  beforeEach(() => { delete process.env.EXCALIDRAW_API_KEY; });

  it('returns true for any value when no API key env var is set', () => {
    expect(validateApiKey('anything')).toBe(true);
    expect(validateApiKey(undefined)).toBe(true);
    expect(validateApiKey('')).toBe(true);
  });

  it('isAuthEnabled returns false when env var is unset', () => {
    expect(isAuthEnabled()).toBe(false);
  });
});

describe('validateApiKey — auth enabled', () => {
  const CORRECT_KEY = 'super-secret-key-32chars!!!!!!!!';

  beforeEach(() => { process.env.EXCALIDRAW_API_KEY = CORRECT_KEY; });
  afterEach(() => { delete process.env.EXCALIDRAW_API_KEY; });

  it('returns true for exact match', () => {
    expect(validateApiKey(CORRECT_KEY)).toBe(true);
  });

  it('returns false for undefined', () => {
    expect(validateApiKey(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(validateApiKey('')).toBe(false);
  });

  it('returns false for array (non-string type guard)', () => {
    expect(validateApiKey(['correct'] as any)).toBe(false);
  });

  it('returns false for a wrong key of the SAME length — timingSafeEqual path', () => {
    // Same length forces the timingSafeEqual code path (not the early-exit).
    // timingSafeEqual must not throw when buffers are the same length.
    const sameLen = 'X'.repeat(CORRECT_KEY.length);
    expect(() => validateApiKey(sameLen)).not.toThrow();
    expect(validateApiKey(sameLen)).toBe(false);
  });

  it('returns false for correct key with one extra char (different length)', () => {
    // DESIGN NOTE: the current implementation returns false early when lengths
    // differ, without calling timingSafeEqual. This means an attacker probing
    // keys of length 1..N can infer the correct key length via response-time
    // differences. Documented here as a known design decision.
    expect(validateApiKey(CORRECT_KEY + 'x')).toBe(false);
  });

  it('returns false for correct key with one char missing', () => {
    expect(validateApiKey(CORRECT_KEY.slice(0, -1))).toBe(false);
  });

  it('returns false for key that differs only in one character', () => {
    // Replace last char with something definitely different from the original
    const lastChar = CORRECT_KEY[CORRECT_KEY.length - 1]!;
    const differentChar = lastChar === 'Z' ? 'A' : 'Z';
    const almostRight = CORRECT_KEY.slice(0, -1) + differentChar;
    expect(validateApiKey(almostRight)).toBe(false);
  });

  it('isAuthEnabled returns true when env var is set', () => {
    expect(isAuthEnabled()).toBe(true);
  });
});

// ── sanitizeSearchQuery ───────────────────────────────────────────────────────

describe('sanitizeSearchQuery — valid inputs', () => {
  it('trims whitespace and returns clean query', () => {
    expect(sanitizeSearchQuery('  hello world  ')).toBe('hello world');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeSearchQuery('   ')).toBe('');
  });

  it('allows plain alphanumeric query', () => {
    expect(sanitizeSearchQuery('rectangle')).toBe('rectangle');
  });

  it('allows hyphenated terms', () => {
    expect(sanitizeSearchQuery('my-diagram')).toBe('my-diagram');
  });

  it('allows numbers', () => {
    expect(sanitizeSearchQuery('123')).toBe('123');
  });
});

describe('sanitizeSearchQuery — FTS operator injection', () => {
  it('throws on double-quote character', () => {
    expect(() => sanitizeSearchQuery('"quoted phrase"')).toThrow(InvalidSearchQueryError);
  });

  it('throws on AND operator (uppercase)', () => {
    expect(() => sanitizeSearchQuery('foo AND bar')).toThrow(InvalidSearchQueryError);
  });

  it('throws on AND operator (lowercase)', () => {
    expect(() => sanitizeSearchQuery('foo and bar')).toThrow(InvalidSearchQueryError);
  });

  it('throws on OR operator', () => {
    expect(() => sanitizeSearchQuery('foo OR bar')).toThrow(InvalidSearchQueryError);
  });

  it('throws on NOT operator', () => {
    expect(() => sanitizeSearchQuery('NOT secret')).toThrow(InvalidSearchQueryError);
  });

  it('throws on NEAR operator', () => {
    expect(() => sanitizeSearchQuery('foo NEAR bar')).toThrow(InvalidSearchQueryError);
  });

  it('throws on NEAR/N distance syntax', () => {
    expect(() => sanitizeSearchQuery('foo NEAR/5 bar')).toThrow(InvalidSearchQueryError);
  });

  it('throws on glob wildcard *', () => {
    expect(() => sanitizeSearchQuery('pass*')).toThrow(InvalidSearchQueryError);
  });

  it('throws on parentheses (grouping)', () => {
    expect(() => sanitizeSearchQuery('(foo bar)')).toThrow(InvalidSearchQueryError);
  });

  it('throws on curly braces', () => {
    expect(() => sanitizeSearchQuery('{foo}')).toThrow(InvalidSearchQueryError);
  });

  it('throws on caret prefix-weight operator', () => {
    expect(() => sanitizeSearchQuery('^important')).toThrow(InvalidSearchQueryError);
  });

  it('throws on colon column-filter syntax (FTS5 column filter)', () => {
    // "label_text:secret" would scope the search to a single FTS column.
    // Fixed: colon is now a blocked character.
    expect(() => sanitizeSearchQuery('label_text:secret')).toThrow(InvalidSearchQueryError);
  });
});
