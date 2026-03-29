import { test, expect } from '@playwright/test';

const API = 'http://127.0.0.1:3100';

test.beforeEach(async ({ request }) => {
  await request.put(`${API}/api/settings/clear_canvas_skip_confirm`, {
    data: { value: 'false' },
  });
  await request.delete(`${API}/api/elements/clear?confirm=true`);
});

test.describe('Clear canvas preference', () => {
  test('checking "Don\'t ask again" persists and skips the next confirmation dialog', async ({ page, request }) => {
    await request.post(`${API}/api/elements`, {
      data: { id: 'pref-el-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
    });

    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });

    await page.locator('button:has-text("Clear Canvas")').click();
    await expect(page.locator('.confirm-dialog')).toBeVisible();
    await page.locator('.confirm-checkbox-label input').check();
    await page.locator('.confirm-dialog button:has-text("Clear")').click();
    await expect(page.locator('.confirm-dialog')).not.toBeVisible();

    await expect.poll(async () => {
      const res = await request.get(`${API}/api/settings/clear_canvas_skip_confirm`);
      const body = await res.json() as { value?: string };
      return body.value;
    }).toBe('true');

    await request.post(`${API}/api/elements`, {
      data: { id: 'pref-el-2', type: 'rectangle', x: 20, y: 20, width: 80, height: 40 },
    });

    await page.locator('button:has-text("Clear Canvas")').click();
    await expect(page.locator('.confirm-dialog')).not.toBeVisible();

    await expect.poll(async () => {
      const res = await request.get(`${API}/api/elements`);
      const body = await res.json() as { count: number };
      return body.count;
    }).toBe(0);
  });
});
