// A long wait on the network must not cost the check its service worker. Chrome ends an idle worker after about
// 30 s; the background makes a cheap extension API call every 20 s while a run is on (src/background/hub.ts).
// Here every lookup that starts in the first seconds is answered 36 s late, so the run has a silent stretch
// longer than 35 s with nothing to report, and must still finish in the same worker.
//
// Caveat, measured in this setup: Playwright keeps a DevTools session attached to the worker, and an attached
// worker is not ended for idleness (a plain idle worker survived 50 s here). So this test shows the long run
// completes and that the keepalive ticks inside it; it cannot show that the worker would have died without it.
import { PAPER_HTML, expect, panelRows, test, withSession } from './harness';

const PAPER = 'https://arxiv.org/html/2402.03664v5';
const SILENT_MS = 36_000;

test('a run that waits more than 35 s on the network still completes, and the keepalive ticks', async () => {
  test.setTimeout(150_000);
  await withSession(async (s) => {
    s.serveFile(PAPER, PAPER_HTML, 'text/html; charset=utf-8');
    s.api.delayMs = (_url, sinceFirstMs) => (sinceFirstMs < 5000 ? SILENT_MS : 0);
    const paper = await s.openPaper(PAPER);
    const panel = await s.openPanel(paper);

    // Count the keepalive's calls and mark this worker, to tell it from a restarted one.
    await s.sw.evaluate(() => {
      const target = globalThis as unknown as { __marker: number; __ticks: number };
      target.__marker = 42;
      target.__ticks = 0;
      const runtime = chrome.runtime as unknown as { getPlatformInfo: (...args: unknown[]) => unknown };
      const original = runtime.getPlatformInfo.bind(runtime);
      runtime.getPlatformInfo = (...args: unknown[]) => {
        target.__ticks += 1;
        return original(...args);
      };
    });

    const started = Date.now();
    await panel.getByRole('button', { name: 'Check references' }).click();
    await expect(panel.getByRole('button', { name: 'Export JSON' })).toBeVisible({ timeout: 110_000 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThan(35_000);
    expect(await panelRows(panel)).toHaveLength(s.world.total);
    expect(s.ctx.serviceWorkers()).toHaveLength(1);
    const state = await s.sw.evaluate(() => {
      const target = globalThis as unknown as { __marker: number; __ticks: number };
      return { marker: target.__marker, ticks: target.__ticks };
    });
    expect(state.marker).toBe(42); // the same worker the whole time
    expect(state.ticks).toBeGreaterThanOrEqual(1);
    expect(s.leaks).toEqual([]);
  });
});
