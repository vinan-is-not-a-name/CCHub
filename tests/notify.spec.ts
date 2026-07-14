import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page): Promise<string> {
  await page.goto('/harness.html?e2e=1');
  await page.waitForFunction(() => '__ccHarness' in window);
  return page.evaluate(() => {
    const h = (window as any).__ccHarness;
    return h.addSession({ id: 'notify-session', label: 'Notify Session', cwd: 'D:/temp/notify' }) as string;
  });
}

test.describe('hook notification delivery', () => {
  test('ready hook flashes the tab title when browser notifications are unavailable', async ({ page }) => {
    const id = await boot(page);
    await page.evaluate((sid) => (window as any).__ccHarness.fireNotify(sid, 'ready'), id);
    await expect(page).toHaveTitle(/CC ready: New session \(Notify Session\)/);
  });

  test('approval hook flashes the tab title with the approval copy', async ({ page }) => {
    const id = await boot(page);
    await page.evaluate((sid) => (window as any).__ccHarness.fireNotify(sid, 'approval'), id);
    await expect(page).toHaveTitle(/CC needs approval: New session \(Notify Session\)/);
  });

  test('disabled notifications ignore hook signals', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cchub-notify-enabled', '0'));
    const id = await boot(page);
    await page.evaluate((sid) => (window as any).__ccHarness.fireNotify(sid, 'ready'), id);
    await expect(page).toHaveTitle('CCHub — Render Harness');
  });

  test('suppresses the title flash when the cc-hub page has focus', async ({ page }) => {
    const id = await boot(page);
    await page.evaluate(() => (window as any).__ccHarness.setPageFocus(true));
    await page.evaluate((sid) => (window as any).__ccHarness.fireNotify(sid, 'ready'), id);
    await expect(page).toHaveTitle('CCHub — Render Harness');
    // Losing focus re-enables delivery: the same hook now flashes the title.
    await page.evaluate(() => (window as any).__ccHarness.setPageFocus(false));
    await page.evaluate((sid) => (window as any).__ccHarness.fireNotify(sid, 'ready'), id);
    await expect(page).toHaveTitle(/CC ready: New session \(Notify Session\)/);
  });

  test('suppresses the desktop notification when the page has focus', async ({ page }) => {
    await page.addInitScript(() => {
      class FakeNotification {
        static permission = 'granted';
        static instances: FakeNotification[] = [];
        constructor() { FakeNotification.instances.push(this); }
        close() {}
      }
      (window as any).Notification = FakeNotification;
    });
    await page.goto('/harness.html?e2e=1');
    await page.waitForFunction(() => '__ccHarness' in window);
    const id = await page.evaluate(() =>
      (window as any).__ccHarness.addSession({ id: 'focus-suppress', label: 'Focus Suppress' }) as string);
    await page.evaluate(() => (window as any).__ccHarness.setPageFocus(true));
    await page.evaluate((sid) => (window as any).__ccHarness.fireNotify(sid, 'ready'), id);
    expect(await page.evaluate(() => (window as any).Notification.instances.length)).toBe(0);
  });

  test('notification click activates the source session', async ({ page }) => {
    await page.addInitScript(() => {
      class FakeNotification {
        static permission = 'granted';
        static instances: FakeNotification[] = [];
        title: string;
        options: NotificationOptions;
        onclick: (() => void) | null = null;
        constructor(title: string, options: NotificationOptions) {
          this.title = title;
          this.options = options;
          FakeNotification.instances.push(this);
        }
        close() {}
      }
      (window as any).Notification = FakeNotification;
    });
    await page.goto('/harness.html?e2e=1');
    await page.waitForFunction(() => '__ccHarness' in window);
    const ids = await page.evaluate(() => {
      const h = (window as any).__ccHarness;
      return [
        h.addSession({ id: 'notify-a', label: 'Notify A' }),
        h.addSession({ id: 'notify-b', label: 'Notify B' }),
      ] as string[];
    });
    await page.evaluate((sid) => (window as any).__ccHarness.fireNotify(sid, 'ready'), ids[0]);
    const notification = await page.evaluate(() => {
      const n = (window as any).Notification.instances[0];
      n.onclick();
      return { title: n.title, body: n.options.body };
    });
    expect(notification).toEqual({ title: 'CC ready', body: 'New session (Notify A)' });
    await expect(page.locator(`.term-pane[data-session-id="${ids[0]}"]`)).toHaveClass(/is-active/);
  });
});
