// In Chromium a badge click on the page opens the side panel. The content script's click
// reaches the background as a message, and Chromium lets sidePanel.open be called while that message is handled.
// The test watches the real sidePanel.open in the service worker and records whether the browser accepted the call.
import { PAPER_HTML, clickBadge, expect, readBadges, test, withSession } from './harness';

const PAPER = 'https://arxiv.org/html/2402.03664v5';

interface Opened {
  ok: boolean;
  error?: string;
}

test('a badge click on the page opens the side panel (the browser accepts the call), and the open panel shows the row', async () => {
  await withSession(async (s) => {
    s.serveFile(PAPER, PAPER_HTML, 'text/html; charset=utf-8');
    const paper = await s.openPaper(PAPER);
    const panel = await s.openPanel(paper);
    await s.runCheck(panel);
    await expect.poll(async () => (await readBadges(paper.page)).length).toBe(s.world.total);

    // Record every call to the real sidePanel.open and what the browser made of it.
    await s.sw.evaluate(() => {
      const g = globalThis as unknown as { __opened: Opened[]; browser?: { sidePanel?: E2eSidePanel } };
      g.__opened = [];
      for (const api of new Set([chrome.sidePanel, g.browser?.sidePanel].filter((a) => a !== undefined))) {
        const real = api.open.bind(api);
        api.open = (options: { tabId: number }) => {
          const pending = real(options);
          pending.then(
            () => g.__opened.push({ ok: true }),
            (error: unknown) => g.__opened.push({ ok: false, error: String(error) }),
          );
          return pending;
        };
      }
    });
    const opened = (): Promise<Opened[]> => s.sw.evaluate(() => (globalThis as unknown as { __opened: Opened[] }).__opened);

    // Without a user action the browser refuses: the check below is not passing by accident.
    const without = await s.sw.evaluate((tabId) => chrome.sidePanel.open({ tabId }).then(() => 'opened', (error: unknown) => String(error)), paper.tabId);
    expect(without).toMatch(/user gesture/i);
    await expect.poll(opened).toHaveLength(1);

    await clickBadge(paper.page, 1);
    await expect.poll(async () => (await opened()).length).toBe(2);
    expect((await opened())[1]).toEqual({ ok: true });
    // The panel (here in a tab) shows the clicked reference's row, opened.
    await expect(panel.locator('li.row button.row-toggle[aria-expanded="true"]')).toHaveCount(1);
    expect(s.leaks).toEqual([]);
  });
});
