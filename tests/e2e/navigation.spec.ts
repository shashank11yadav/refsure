// Leaving the paper in the middle of a check ends the run and leaves no stale results anywhere:
// not in the panel, not on the other page, and no more lookups are made.
import { join } from 'node:path';
import { PAPER_HTML, expect, panelRows, PAGES, readBadges, test, withSession } from './harness';

const PAPER = 'https://arxiv.org/html/2402.03664v5';
const OTHER = 'https://arxiv.org/html/2503.00258';

test('navigating away mid-check stops the run and leaves no stale results', async () => {
  await withSession(async (s) => {
    s.serveFile(PAPER, PAPER_HTML, 'text/html; charset=utf-8');
    s.serveFile(OTHER, join(PAGES, 'arxiv-2503.00258.html'), 'text/html; charset=utf-8');
    s.api.delayMs = 400;
    const paper = await s.openPaper(PAPER);
    const panel = await s.openPanel(paper);
    await panel.getByRole('button', { name: 'Check references' }).click();

    // Some results are in, the check is not over.
    await expect.poll(async () => (await panelRows(panel)).length, { timeout: 30_000 }).toBeGreaterThan(2);
    expect(await readBadges(paper.page)).not.toHaveLength(0);
    await expect(panel.getByRole('progressbar')).toHaveCount(1);

    // Leave for a different paper in the same tab.
    await paper.page.goto(OTHER);
    await s.refreshPanel(panel);
    await expect(panel.getByRole('heading', { name: 'Ready to check this paper' })).toBeVisible();
    expect(await panelRows(panel)).toEqual([]);
    expect(await readBadges(paper.page)).toEqual([]);
    await expect(panel.getByRole('progressbar')).toHaveCount(0);

    // The run is really over: after what was already in flight has landed, no new lookup starts.
    await paper.page.waitForTimeout(1500);
    const settled = s.api.requests.length;
    await paper.page.waitForTimeout(3000);
    expect(s.api.requests.length).toBe(settled);
    expect(await panelRows(panel)).toEqual([]);
    expect(await readBadges(paper.page)).toEqual([]);

    // Coming back to the first paper shows nothing left over from the abandoned run either.
    await paper.page.goto(PAPER);
    await s.refreshPanel(panel);
    await expect(panel.getByRole('heading', { name: 'Ready to check this paper' })).toBeVisible();
    expect(await panelRows(panel)).toEqual([]);
    expect(await readBadges(paper.page)).toEqual([]);
    await paper.page.waitForTimeout(1500);
    expect(s.api.requests.length).toBe(settled);
    expect(s.leaks).toEqual([]);
  });
});

test('closing the paper tab mid-check stops the run', async () => {
  await withSession(async (s) => {
    s.serveFile(PAPER, PAPER_HTML, 'text/html; charset=utf-8');
    s.api.delayMs = 400;
    const paper = await s.openPaper(PAPER);
    const panel = await s.openPanel(paper);
    await panel.getByRole('button', { name: 'Check references' }).click();
    await expect.poll(async () => (await panelRows(panel)).length, { timeout: 30_000 }).toBeGreaterThan(2);
    await paper.page.close();
    await panel.waitForTimeout(1500);
    const settled = s.api.requests.length;
    await panel.waitForTimeout(3000);
    expect(s.api.requests.length).toBe(settled);
    expect(s.leaks).toEqual([]);
  });
});
