import { test, expect, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:3100';

async function resetCanvas(request: any): Promise<void> {
  await request.delete(`${API}/api/elements/clear?confirm=true`);
}

async function waitForConnected(page: Page): Promise<void> {
  await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
}

test.beforeEach(async ({ request }) => {
  await resetCanvas(request);
});

test.describe('Phase 2 regressions', () => {
  test('position stability survives reloads for pre-seeded elements', async ({ page, request }) => {
    await request.post(`${API}/api/elements`, {
      data: {
        id: 'pos-stable-1',
        type: 'rectangle',
        x: 220,
        y: 140,
        width: 260,
        height: 110,
        label: { text: 'Stable Label' },
      },
    });

    await page.goto('/');
    await waitForConnected(page);
    await page.waitForTimeout(800);

    const initialRes = await request.get(`${API}/api/elements/pos-stable-1`);
    expect(initialRes.ok()).toBe(true);
    const initial = (await initialRes.json()).element as {
      x: number;
      y: number;
      width: number;
      height: number;
      label?: { text?: string };
    };

    await page.reload();
    await waitForConnected(page);
    await page.waitForTimeout(800);

    const afterReloadRes = await request.get(`${API}/api/elements/pos-stable-1`);
    expect(afterReloadRes.ok()).toBe(true);
    const afterReload = (await afterReloadRes.json()).element as {
      x: number;
      y: number;
      width: number;
      height: number;
      label?: { text?: string };
    };

    expect(afterReload.x).toBe(initial.x);
    expect(afterReload.y).toBe(initial.y);
    expect(afterReload.width).toBe(initial.width);
    expect(afterReload.height).toBe(initial.height);
    expect(afterReload.label?.text).toBe('Stable Label');
  });

  test('new container arrival auto-injects title and subtitle text', async ({ page, request }) => {
    await page.goto('/');
    await waitForConnected(page);

    const createRes = await request.post(`${API}/api/elements`, {
      data: {
        id: 'auto-title-seed',
        type: 'rectangle',
        x: 220,
        y: 140,
        width: 260,
        height: 110,
      },
    });
    expect(createRes.ok()).toBe(true);

    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /^Sync$/ }).click();

    await expect.poll(async () => {
      const listRes = await request.get(`${API}/api/elements`);
      if (!listRes.ok()) return false;
      const listBody = await listRes.json() as { elements: any[] };
      const titleText = listBody.elements.find((el) => el.type === 'text' && el.text === 'Title');
      const subtitleText = listBody.elements.find((el) => el.type === 'text' && el.text === 'Text here');
      return Boolean(titleText && subtitleText);
    }, { timeout: 7000 }).toBe(true);
  });

  test('two connected tabs receive cross-tab sync events', async ({ page, context }) => {
    const page2 = await context.newPage();

    await page2.addInitScript(() => {
      const NativeWS = window.WebSocket;
      (window as any).__wsSeenTypes = [] as string[];

      const Wrapped = function(this: any, url: string | URL, protocols?: string | string[]) {
        const ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
        ws.addEventListener('message', (event) => {
          try {
            const raw = typeof event.data === 'string' ? event.data : '';
            const parsed = JSON.parse(raw);
            if (parsed?.type) {
              (window as any).__wsSeenTypes.push(parsed.type);
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
    await page2.goto('/');
    await waitForConnected(page);
    await waitForConnected(page2);

    const createRes = await page.evaluate(async () => {
      const res = await fetch('/api/elements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'two-tab-sync-1',
          type: 'rectangle',
          x: 30,
          y: 40,
          width: 120,
          height: 70,
        }),
      });
      return { ok: res.ok, status: res.status };
    });
    expect(createRes.ok).toBe(true);

    await expect.poll(async () => {
      return await page2.evaluate(() =>
        Array.isArray((window as any).__wsSeenTypes) &&
        (window as any).__wsSeenTypes.includes('element_created')
      );
    }, { timeout: 6000 }).toBe(true);

    await page2.close();
  });
});
