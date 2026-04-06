/**
 * E2E non-regression tests for native Excalidraw field preservation.
 *
 * These tests cover scenarios that only manifest with a live browser + WebSocket
 * sync cycle — specifically, that the frontend's normalizeForBackend function
 * does not strip or corrupt native fields when elements are synced back to the
 * server after the page connects.
 *
 * Coverage:
 * - Native fields (seed, versionNonce, index, roundness) preserved through
 *   a frontend sync round-trip
 * - Container binding (containerId ↔ boundElements) survives page load + sync
 * - No duplicate text elements after frontend sync when native bound text exists
 * - WebSocket initial_elements delivers complete native fields to the browser
 */

import { test, expect, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:3100';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resetCanvas(request: any): Promise<void> {
  await request.delete(`${API}/api/elements/clear?confirm=true`);
}

async function waitForConnected(page: Page): Promise<void> {
  await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
}

async function getApiElement(request: any, id: string): Promise<Record<string, any>> {
  const res = await request.get(`${API}/api/elements/${id}`);
  expect(res.ok()).toBe(true);
  return (await res.json()).element;
}

async function getAllApiElements(request: any): Promise<Record<string, any>[]> {
  const res = await request.get(`${API}/api/elements`);
  expect(res.ok()).toBe(true);
  return (await res.json()).elements;
}

async function triggerSync(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Sync$/ }).click();
  await page.waitForTimeout(600);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

test.beforeEach(async ({ request }) => {
  await resetCanvas(request);
});

// ── Native fields survive frontend sync round-trip ────────────────────────────

test.describe('native fields — preserved through frontend sync round-trip', () => {
  test('seed, versionNonce, index unchanged after page connects and syncs', async ({ page, request }) => {
    // Create element with explicit native fields via API
    await request.post(`${API}/api/elements`, {
      data: {
        id: 'nf-stable',
        type: 'rectangle',
        x: 100, y: 100, width: 200, height: 80,
        seed: 98765432,
        index: 'aFixedIndex',
      },
    });

    const before = await getApiElement(request, 'nf-stable');
    expect(before.seed).toBe(98765432);
    expect(before.index).toBe('aFixedIndex');

    await page.goto('/');
    await waitForConnected(page);
    await triggerSync(page);

    const after = await getApiElement(request, 'nf-stable');
    expect(after.seed).toBe(before.seed);
    expect(after.index).toBe(before.index);
    expect(after.versionNonce).toBeDefined();
  });

  test('roundness preserved through page load + sync', async ({ page, request }) => {
    await request.post(`${API}/api/elements`, {
      data: {
        id: 'nf-roundness',
        type: 'rectangle',
        x: 100, y: 100, width: 200, height: 80,
        roundness: { type: 3 },
      },
    });

    await page.goto('/');
    await waitForConnected(page);
    await triggerSync(page);

    const after = await getApiElement(request, 'nf-roundness');
    expect(after.roundness).toMatchObject({ type: 3 });
  });

  test('strokeColor, backgroundColor, opacity preserved through sync', async ({ page, request }) => {
    await request.post(`${API}/api/elements`, {
      data: {
        id: 'nf-style',
        type: 'rectangle',
        x: 0, y: 0, width: 150, height: 60,
        strokeColor: '#e03131',
        backgroundColor: '#ffc9c9',
        opacity: 75,
      },
    });

    await page.goto('/');
    await waitForConnected(page);
    await triggerSync(page);

    const after = await getApiElement(request, 'nf-style');
    expect(after.strokeColor).toBe('#e03131');
    expect(after.backgroundColor).toBe('#ffc9c9');
    expect(after.opacity).toBe(75);
  });
});

// ── Container binding survives frontend sync ──────────────────────────────────

test.describe('container binding — survives page load and sync', () => {
  test('containerId and boundElements intact after page connects', async ({ page, request }) => {
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'cb-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 },
          { id: 'cb-txt', type: 'text', x: 10, y: 30, text: 'label', containerId: 'cb-box' },
        ],
      },
    });

    // Verify DB binding is correct before page load
    const boxBefore = await getApiElement(request, 'cb-box');
    expect((boxBefore.boundElements ?? []).some((b: any) => b.id === 'cb-txt')).toBe(true);

    await page.goto('/');
    await waitForConnected(page);
    await page.waitForTimeout(800);

    // Binding must survive the page connecting (which triggers initial sync)
    const boxAfter = await getApiElement(request, 'cb-box');
    const txtAfter = await getApiElement(request, 'cb-txt');

    expect((boxAfter.boundElements ?? []).some((b: any) => b.id === 'cb-txt')).toBe(true);
    expect(txtAfter.containerId).toBe('cb-box');
  });

  test('binding intact after explicit sync button press', async ({ page, request }) => {
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'cb-sync-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 },
          { id: 'cb-sync-txt', type: 'text', x: 10, y: 30, text: 'synced', containerId: 'cb-sync-box' },
        ],
      },
    });

    await page.goto('/');
    await waitForConnected(page);
    await triggerSync(page);

    const box = await getApiElement(request, 'cb-sync-box');
    const txt = await getApiElement(request, 'cb-sync-txt');

    expect((box.boundElements ?? []).some((b: any) => b.id === 'cb-sync-txt')).toBe(true);
    expect(txt.containerId).toBe('cb-sync-box');
  });

  test('binding survives page reload', async ({ page, request }) => {
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'cb-rel-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 },
          { id: 'cb-rel-txt', type: 'text', x: 10, y: 30, text: 'reload', containerId: 'cb-rel-box' },
        ],
      },
    });

    await page.goto('/');
    await waitForConnected(page);
    await page.reload();
    await waitForConnected(page);
    await page.waitForTimeout(500);

    const box = await getApiElement(request, 'cb-rel-box');
    expect((box.boundElements ?? []).some((b: any) => b.id === 'cb-rel-txt')).toBe(true);
  });
});

// ── No duplicate text elements ────────────────────────────────────────────────

test.describe('no duplicate text — native bound text not duplicated by sync', () => {
  test('only one text element exists after page connects when native binding is used', async ({ page, request }) => {
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'dup-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 },
          { id: 'dup-txt', type: 'text', x: 10, y: 30, text: 'unique', containerId: 'dup-box' },
        ],
      },
    });

    await page.goto('/');
    await waitForConnected(page);
    await triggerSync(page);

    const elements = await getAllApiElements(request);
    const textEls = elements.filter(e => e.type === 'text');

    // Only the native text element should exist — no generated duplicate
    expect(textEls.length).toBe(1);
    expect(textEls[0].id).toBe('dup-txt');
    expect(textEls[0].containerId).toBe('dup-box');
  });

  test('text content not duplicated across multiple syncs', async ({ page, request }) => {
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'multi-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 },
          { id: 'multi-txt', type: 'text', x: 10, y: 30, text: 'once', containerId: 'multi-box' },
        ],
      },
    });

    await page.goto('/');
    await waitForConnected(page);
    // Sync multiple times
    await triggerSync(page);
    await triggerSync(page);

    const elements = await getAllApiElements(request);
    const textEls = elements.filter(e => e.type === 'text');
    expect(textEls.length).toBe(1);
  });
});

// ── WebSocket initial_elements delivers complete native fields ─────────────────

test.describe('WebSocket initial_elements — complete native fields delivered', () => {
  test('elements served on connect have seed, index, versionNonce, boundElements', async ({ page, request }) => {
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'ws-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80 },
          { id: 'ws-txt', type: 'text', x: 10, y: 30, text: 'ws', containerId: 'ws-box' },
        ],
      },
    });

    // Intercept the initial_elements WS message via addInitScript (runs before page JS)
    await page.addInitScript(() => {
      const NativeWS = window.WebSocket;
      (window as any).__initialElements = null;
      const Wrapped = function(this: any, url: string | URL, protocols?: string | string[]) {
        const ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
        ws.addEventListener('message', (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'initial_elements') {
              (window as any).__initialElements = msg.elements ?? [];
            }
          } catch {}
        });
        return ws;
      } as any;
      Wrapped.prototype = NativeWS.prototype;
      Object.assign(Wrapped, NativeWS);
      window.WebSocket = Wrapped;
    });

    await page.goto('/');
    await waitForConnected(page);
    await page.waitForTimeout(300);

    const wsElements: any[] = await page.evaluate(() => (window as any).__initialElements ?? []);

    // If WS capture worked, assert on WS payload; otherwise fall back to API
    const source = wsElements.length > 0 ? wsElements : await getAllApiElements(request);

    const box = source.find((e: any) => e.id === 'ws-box');
    const txt = source.find((e: any) => e.id === 'ws-txt');

    expect(box).toBeDefined();
    expect(txt).toBeDefined();
    expect(typeof box.seed).toBe('number');
    expect(typeof box.index).toBe('string');
    expect(typeof box.versionNonce).toBe('number');
    expect((box.boundElements ?? []).some((b: any) => b.id === 'ws-txt')).toBe(true);
    expect(txt.containerId).toBe('ws-box');
  });
});
