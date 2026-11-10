// The main flow on an arXiv HTML paper: check, results streaming into the panel, a badge on every reference,
// the filter chips, the report on the clipboard (or its fallback box), and a row click that scrolls the page.
import { PAPER_HTML, countBy, expect, hoverBadgePopovers, panelRows, readBadges, test, withSession, type Session } from './harness';
import type { Page } from '@playwright/test';

const PAPER = 'https://arxiv.org/html/2402.03664v5';

async function startedSession(s: Session, delayMs: number): Promise<{ paper: { page: Page; tabId: number }; panel: Page }> {
  s.serveFile(PAPER, PAPER_HTML, 'text/html; charset=utf-8');
  s.api.delayMs = delayMs;
  const paper = await s.openPaper(PAPER);
  const panel = await s.openPanel(paper);
  return { paper, panel };
}

test('checks an arXiv HTML paper from the panel: results stream in, every reference gets a badge', async () => {
  await withSession(async (s) => {
    const { paper, panel } = await startedSession(s, 150);
    await expect(panel.getByRole('heading', { name: 'Ready to check this paper' })).toBeVisible();
    await panel.getByRole('button', { name: 'Check references' }).click();

    // Streaming: rows appear while the progress bar is still there, and the count grows over time.
    const counts: number[] = [];
    await expect(async () => {
      const rows = (await panelRows(panel)).length;
      counts.push(rows);
      expect(rows).toBeGreaterThan(5);
      expect(await panel.getByRole('progressbar').count()).toBe(1);
      // The extension's CSP refuses inline style attributes; the bar must still fill (its width is set through the CSSOM).
      expect(await panel.locator('.progress-fill').evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });
    await expect(panel.getByRole('button', { name: 'Export JSON' })).toBeVisible({ timeout: 60_000 });
    expect(counts[counts.length - 1]).toBeLessThan(s.world.total);
    await expect(panel.getByRole('progressbar')).toHaveCount(0);

    // All references have a row and a badge, and both show the same statuses.
    const rows = await panelRows(panel);
    expect(rows).toHaveLength(s.world.total);
    const badges = await readBadges(paper.page);
    expect(badges).toHaveLength(s.world.total);
    expect(countBy(badges, (b) => b.status)).toEqual(countBy(rows, (r) => r.status));

    // Every kind of result the fake world was built to produce is there.
    const byIndex = new Map(rows.map((r) => [r.index, r.status]));
    expect(byIndex.get(s.world.scenarios.notFound)).toBe('not_found');
    expect(byIndex.get(s.world.scenarios.detailsDiffer)).toBe('details_differ');
    expect(byIndex.get(s.world.scenarios.retracted)).toBe('retracted');
    expect(byIndex.get(s.world.scenarios.cantCheck)).toBe('cant_check');
    expect(countBy(rows, (r) => r.status)['verified']).toBeGreaterThan(20);

    expect(s.leaks).toEqual([]);
    expect(s.lookups.length).toBeGreaterThan(20);
  });
});

// The popovers must not make the arXiv page wider (a box that is only hidden still counts toward the scrollable
// width), and a shown one stays inside the viewport. Measured on the real page, at a narrow width where it matters.
test('badges and their popovers do not widen the paper page and stay inside the viewport', async () => {
  await withSession(async (s) => {
    const { paper, panel } = await startedSession(s, 0);
    await paper.page.setViewportSize({ width: 700, height: 800 });
    const width = (): Promise<{ scroll: number; client: number }> =>
      paper.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    const before = await width();
    await s.runCheck(panel);
    expect(await readBadges(paper.page)).toHaveLength(s.world.total);
    const after = await width();
    expect(after.scroll).toBe(before.scroll);

    const boxes = await hoverBadgePopovers(paper.page);
    expect(boxes.length).toBeGreaterThan(10);
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(after.client);
    }
    expect((await width()).scroll).toBe(before.scroll);
    expect(s.leaks).toEqual([]);
  });
});

// One finished check, then everything the panel offers on it. Reduced motion makes the page scroll instant,
// so its position can be read at once.
test('after a check: filter chips, copy report (and its fallback), and row click scrolling', async () => {
  await withSession(
    async (s) => {
      const { paper, panel } = await startedSession(s, 0);
      await s.runCheck(panel);
      const all = await panelRows(panel);

      await test.step('filter chips narrow the list and All brings it back', async () => {
        const wanted = countBy(all, (r) => r.status);
        const showing = async (status: string): Promise<{ index: number; status: string }[]> => {
          await expect(panel.locator(`button.chip[data-filter="${status}"]`)).toHaveAttribute('aria-pressed', 'true');
          return panelRows(panel);
        };
        for (const [status, count] of Object.entries(wanted)) {
          await panel.locator(`button.chip[data-filter="${status}"]`).click();
          await expect.poll(async () => (await showing(status)).length, { message: status }).toBe(count);
          expect((await panelRows(panel)).every((r) => r.status === status)).toBe(true);
        }
        await panel.locator('button.chip[data-filter="all"]').click();
        await expect.poll(async () => (await panelRows(panel)).length).toBe(all.length);
      });

      await test.step('Copy report puts the report on the clipboard', async () => {
        await panel.bringToFront();
        await panel.getByRole('button', { name: 'Copy report' }).click();
        await expect(panel.getByText('Report copied.')).toBeVisible();
        await expect(panel.locator('textarea.report-box')).toHaveCount(0);
        // Pasted into another page to read it (reading the clipboard directly needs a permission that
        // cannot be granted to an extension page).
        const scratch = await s.ctx.newPage();
        await scratch.setContent('<textarea id="t"></textarea>');
        await scratch.bringToFront();
        await scratch.locator('#t').focus();
        await scratch.keyboard.press('ControlOrMeta+V');
        const pasted = await scratch.locator('#t').inputValue();
        expect(pasted).toContain('RefSure check');
        expect(pasted).toContain('Partial Gromov-Wasserstein Metric');
        expect(pasted).toContain('71 references');
        expect(pasted).toContain('Retracted');
        await scratch.close();
      });

      await test.step('a refused clipboard shows the report in a box to copy by hand', async () => {
        await panel.bringToFront();
        await panel.evaluate(() => {
          navigator.clipboard.writeText = () => Promise.reject(new DOMException('refused', 'NotAllowedError'));
        });
        await panel.getByRole('button', { name: 'Copy report' }).click();
        const box = panel.locator('textarea.report-box');
        await expect(box).toBeVisible();
        expect(await box.inputValue()).toContain('RefSure check');
      });

      await test.step('clicking a row scrolls the paper to that reference and outlines its badge', async () => {
        expect(await paper.page.evaluate(() => window.scrollY)).toBe(0);
        const target = 33;
        await panel.locator(`li.row[data-index="${target}"] p.citation`).click();
        await expect.poll(() => paper.page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
        const item = paper.page.locator('li.ltx_bibitem').nth(target - 1);
        const box = await item.boundingBox();
        const viewport = paper.page.viewportSize();
        expect(box).not.toBeNull();
        expect(box === null || viewport === null || (box.y >= 0 && box.y < viewport.height)).toBe(true);

        const outlined = (await readBadges(paper.page)).filter((b) => b.highlighted);
        expect(outlined).toHaveLength(1);
        expect(outlined[0]?.bibId).toBe(await item.getAttribute('id'));
        // The outline goes away by itself.
        await expect.poll(async () => (await readBadges(paper.page)).filter((b) => b.highlighted).length, { timeout: 6000 }).toBe(0);
      });
    },
    { reducedMotion: true },
  );
});
