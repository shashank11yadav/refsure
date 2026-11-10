// Screenshots of the side panel in light and dark mode, at 360 px and 480 px wide, the inline badges on the paper,
// the panel beside the paper at the store listings' 1280 x 800, and the settings page at 1280 x 800. They are for
// checking the look by eye. A normal run writes them to test-results/screenshots;
// `REFSURE_UPDATE_SCREENSHOTS=1 npm run test:e2e` refreshes the tracked copies in docs/screenshots.
//
// The paper is invented (tests/fixtures/pages/arxiv-invented-screenshots.handmade.html): its authors, title,
// references and venues are all made up, so no real person or paper is shown with a status, and the faked services
// give each status at least once.
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { API, CONTACT_EMAIL } from '../../src/config';
import { buildWorld, type World } from './fakeApi';
import { expect, PAGES, panelRows, ROOT, test, withSession, type Session } from './harness';
import { screenshotDir } from './screenshotDir';

const INVENTED_HTML = join(PAGES, 'arxiv-invented-screenshots.handmade.html');
// A new-style arXiv number dated January 2000, before new-style numbers existed: no real paper has it.
const PAPER = 'https://arxiv.org/html/0001.00001v1';
const OUT = screenshotDir(ROOT, process.env);
const STORE = { width: 1280, height: 800 };
const PANEL_WIDTH = 360;

/**
 * The world of the invented paper. On top of the usual altered references, the one reference that carries a DOI is
 * taken out of every search, and its DOI resolves to a different paper (served below): that one comes out Wrong ID.
 */
function inventedWorld(): { world: World; misfiled: { index: number; doi: string } } {
  const built = buildWorld(INVENTED_HTML);
  const misfiled = built.entries.find((e) => !e.doi.startsWith('10.99999/'));
  if (misfiled === undefined) throw new Error('The invented paper needs one reference with a DOI');
  return { world: { ...built, entries: built.entries.filter((e) => e !== misfiled) }, misfiled };
}

function serveInventedPaper(s: Session, misfiled: { doi: string }): void {
  s.serveFile(PAPER, INVENTED_HTML, 'text/html; charset=utf-8');
  const path = misfiled.doi.split('/').map(encodeURIComponent).join('/');
  const work = {
    DOI: misfiled.doi,
    title: ['Seasonal migration of garden snails across invented meadows'],
    author: [
      { given: 'A.', family: 'Unrelated', sequence: 'first' },
      { given: 'B.', family: 'Elsewhere', sequence: 'additional' },
    ],
    issued: { 'date-parts': [[2011]] },
    'container-title': ['Journal of Fixture Studies'],
    type: 'journal-article',
  };
  s.serve(`${API.crossref}/works/${path}?${new URLSearchParams({ mailto: CONTACT_EMAIL }).toString()}`, {
    contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', message: work }),
  });
}

/** Scrolls the reference list of the paper to the top of the window. */
async function showReferences(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('bib')?.scrollIntoView({ block: 'start' }));
}

/**
 * The side panel open beside the paper, the way Chrome shows it, made from a screenshot of each: the panel cannot be
 * opened for real in a headless browser (see harness.ts), so the two pictures are put side by side in a blank page.
 */
async function besideThePaper(s: Session, paper: Buffer, panel: Buffer, scheme: 'light' | 'dark', path: string): Promise<void> {
  const frame = await s.ctx.newPage();
  try {
    await frame.setViewportSize(STORE);
    const line = scheme === 'dark' ? '#3c4043' : '#dadce0';
    const src = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
    await frame.setContent(
      `<!doctype html><html><body style="margin:0;display:flex;width:${STORE.width}px;height:${STORE.height}px;overflow:hidden">` +
        `<img alt="" src="${src(paper)}" style="display:block;width:${STORE.width - PANEL_WIDTH - 1}px;height:${STORE.height}px">` +
        `<div style="width:1px;background:${line}"></div>` +
        `<img alt="" src="${src(panel)}" style="display:block;width:${PANEL_WIDTH}px;height:${STORE.height}px">` +
        `</body></html>`,
    );
    await frame.waitForFunction(() => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0));
    await frame.screenshot({ path });
  } finally {
    await frame.close();
  }
}

test('side panel, page and store screenshots of an invented paper, with every status', async () => {
  const { world, misfiled } = inventedWorld();
  await withSession(
    async (s) => {
      serveInventedPaper(s, misfiled);
      const paper = await s.openPaper(PAPER);
      const panel = await s.openPanel(paper);
      await s.runCheck(panel);

      // Every status is on show, each where the fake services put it.
      const byIndex = new Map((await panelRows(panel)).map((r) => [r.index, r.status]));
      expect(byIndex.get(world.scenarios.notFound)).toBe('not_found');
      expect(byIndex.get(world.scenarios.detailsDiffer)).toBe('details_differ');
      expect(byIndex.get(world.scenarios.retracted)).toBe('retracted');
      expect(byIndex.get(world.scenarios.cantCheck)).toBe('cant_check');
      expect(byIndex.get(misfiled.index)).toBe('wrong_id');
      expect([...byIndex.values()]).toContain('verified');
      expect(byIndex.size).toBe(world.total);

      for (const width of [360, 480]) {
        for (const scheme of ['light', 'dark'] as const) {
          await panel.setViewportSize({ width, height: 800 });
          await panel.emulateMedia({ colorScheme: scheme });
          // The page background really changes with the scheme (the theme follows prefers-color-scheme).
          const background = await panel.evaluate(() => getComputedStyle(document.body).backgroundColor);
          await expect(panel.getByRole('button', { name: 'Export JSON' })).toBeVisible();
          // No horizontal scrolling at this width.
          expect(await panel.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          await panel.screenshot({ path: join(OUT, `panel-${scheme}-${width}.png`) });
          if (scheme === 'dark') expect(background).not.toBe('rgb(255, 255, 255)');
        }
      }

      // The inline badges on the reference list, in both schemes.
      await paper.page.setViewportSize({ width: 1100, height: 800 });
      for (const scheme of ['light', 'dark'] as const) {
        await paper.page.emulateMedia({ colorScheme: scheme });
        await showReferences(paper.page);
        await paper.page.screenshot({ path: join(OUT, `page-badges-${scheme}.png`) });
      }

      // The panel beside the paper at 1280 x 800, in both schemes.
      await paper.page.setViewportSize({ width: STORE.width - PANEL_WIDTH - 1, height: STORE.height });
      await panel.setViewportSize({ width: PANEL_WIDTH, height: STORE.height });
      for (const scheme of ['light', 'dark'] as const) {
        await paper.page.emulateMedia({ colorScheme: scheme });
        await panel.emulateMedia({ colorScheme: scheme });
        await showReferences(paper.page);
        await panel.evaluate(() => window.scrollTo(0, 0));
        await besideThePaper(s, await paper.page.screenshot(), await panel.screenshot(), scheme, join(OUT, `store-${scheme}-1280.png`));
      }

      // One reference expanded (cited and found side by side), alone at the narrow width and beside the paper.
      await panel.emulateMedia({ colorScheme: 'light' });
      await paper.page.emulateMedia({ colorScheme: 'light' });
      const row = panel.locator(`li.row[data-index="${world.scenarios.detailsDiffer}"]`);
      await row.locator('button.row-toggle').click();
      await expect(row.locator('.diff')).toBeVisible();
      await row.scrollIntoViewIfNeeded();
      await panel.screenshot({ path: join(OUT, 'panel-details-light-360.png') });
      await besideThePaper(s, await paper.page.screenshot(), await panel.screenshot(), 'light', join(OUT, 'store-details-light-1280.png'));
      expect(s.leaks).toEqual([]);
    },
    { world },
  );
});

// The store listings show 1280 x 800 images. The settings page holds no reference data, so a test profile shows it as a
// user would see it: the default switches and no OpenAlex key.
test('settings page screenshots at 1280 x 800 in light and dark mode, with the default settings and no key', async () => {
  const { world, misfiled } = inventedWorld();
  await withSession(
    async (s) => {
      serveInventedPaper(s, misfiled);
      const paper = await s.openPaper(PAPER);
      const panel = await s.openPanel(paper);
      await panel.setViewportSize(STORE);
      await panel.getByRole('button', { name: 'Settings' }).click();
      await expect(panel.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await panel.getByText('Advanced').click();
      const key = panel.locator('input.key-input');
      await expect(key).toBeVisible();
      await expect(key).toHaveValue('');

      for (const scheme of ['light', 'dark'] as const) {
        await panel.emulateMedia({ colorScheme: scheme });
        const background = await panel.evaluate(() => getComputedStyle(document.body).backgroundColor);
        if (scheme === 'dark') expect(background).not.toBe('rgb(255, 255, 255)');
        expect(await panel.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await panel.screenshot({ path: join(OUT, `settings-${scheme}-1280.png`) });
      }
      // Opening the settings sends nothing to any service.
      expect(s.lookups).toEqual([]);
      expect(s.leaks).toEqual([]);
    },
    { world },
  );
});
