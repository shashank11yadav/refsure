// What the panel does at the edges: the keyboard, Stop, the services not answering, and a very narrow panel.
import { PAPER_HTML, expect, panelRows, readBadges, test, withSession, type Session } from './harness';
import type { Page } from '@playwright/test';

const PAPER = 'https://arxiv.org/html/2402.03664v5';
// Reference 1 of that paper is a book and reference 17 a thesis: neither is looked up, so they come back at once and
// do not count toward the early stop, which needs five references in a row whose lookups failed.
const NOT_LOOKED_UP = new Set([1, 17]);
const lookedUp = (rows: { index: number }[]) => rows.filter((r) => !NOT_LOOKED_UP.has(r.index));

async function openedPanel(s: Session, delayMs: number): Promise<{ paper: { page: Page; tabId: number }; panel: Page }> {
  s.serveFile(PAPER, PAPER_HTML, 'text/html; charset=utf-8');
  s.api.delayMs = delayMs;
  const paper = await s.openPaper(PAPER);
  const panel = await s.openPanel(paper);
  return { paper, panel };
}

const focusedKey = (panel: Page): Promise<string | null> => panel.evaluate(() => document.activeElement?.getAttribute('data-fk') ?? null);

test('the keyboard keeps its place: Check, Stop and Re-check each hand the focus to the next control', async () => {
  await withSession(async (s) => {
    const { panel } = await openedPanel(s, 200);
    await panel.getByRole('button', { name: 'Check references' }).focus();
    await panel.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible();
    expect(await focusedKey(panel)).toBe('act:Stop');
    // A screen reader hears that the check began.
    await expect(panel.locator('.announcer')).toHaveText(/^Checking \d+ references\. Results appear as they arrive\.$/);

    await expect.poll(async () => (await panelRows(panel)).length, { timeout: 30_000 }).toBeGreaterThan(2);
    await panel.keyboard.press('Enter');
    await expect(panel.getByText('Check stopped.')).toBeVisible();
    expect(await focusedKey(panel)).toBe('act:Copy report');

    await panel.getByRole('button', { name: 'Re-check' }).focus();
    await panel.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible();
    expect(await focusedKey(panel)).toBe('act:Stop');
    await panel.keyboard.press('Enter');
    await expect(panel.getByText('Check stopped.')).toBeVisible();
    expect(s.leaks).toEqual([]);
  });
});

test('Stop keeps the rows and the badges already drawn, and what was found can be copied and saved as partial', async () => {
  await withSession(async (s) => {
    const { paper, panel } = await openedPanel(s, 250);
    await panel.getByRole('button', { name: 'Check references' }).click();
    await expect.poll(async () => (await panelRows(panel)).length, { timeout: 30_000 }).toBeGreaterThan(3);
    await panel.getByRole('button', { name: 'Stop' }).click();
    await expect(panel.getByText('Check stopped.')).toBeVisible();
    const found = (await panelRows(panel)).length;
    expect(found).toBeLessThan(s.world.total);

    // The page keeps the badges it was given; a moment later nothing has been added or taken away.
    const badges = await readBadges(paper.page);
    expect(badges.length).toBeGreaterThanOrEqual(found);
    await panel.waitForTimeout(1500);
    expect(await readBadges(paper.page)).toHaveLength(badges.length);
    expect(await panelRows(panel)).toHaveLength(found);

    // Clicking the toolbar again would only show the panel; Re-check is the way to start over, and it clears the old badges.
    await panel.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('refused', 'NotAllowedError'));
    });
    await panel.getByRole('button', { name: 'Copy report' }).click();
    const report = await panel.locator('textarea.report-box').inputValue();
    expect(report).toContain(`Stopped after ${found} of ${s.world.total} references`);
    await expect(panel.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Export JSON' })).toBeVisible();
    expect(s.leaks).toEqual([]);
  });
});

test('when every database stops answering the run ends after a few references, says so calmly, and Try again works once they are back', async () => {
  test.setTimeout(180_000); // arXiv is paced at one request per 3 s, so both halves take a while
  await withSession(async (s) => {
    const { panel } = await openedPanel(s, 0);
    s.api.down = true;
    await panel.getByRole('button', { name: 'Check references' }).click();

    // arXiv is asked once per 3 s, and each of the five references needs its turn: this takes about half a minute.
    await expect(panel.locator('.banner.tone-warn')).toContainText("The databases RefSure uses aren't answering right now. This isn't a problem with the paper.", { timeout: 60_000 });
    await expect(panel.getByRole('progressbar')).toHaveCount(0);
    // The run gave up by itself while the keyboard was on Stop: the focus goes to the obvious next step.
    await expect(panel.getByRole('button', { name: 'Try again' })).toBeFocused();
    const rows = await panelRows(panel);
    expect(lookedUp(rows)).toHaveLength(5);
    expect(rows.every((r) => r.status === 'cant_check')).toBe(true);
    // Nothing more is looked up once the run has given up.
    const settled = s.api.requests.length;
    await panel.waitForTimeout(2000);
    expect(s.api.requests.length).toBe(settled);

    s.api.down = false;
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(panel.getByRole('button', { name: 'Export JSON' })).toBeVisible({ timeout: 60_000 });
    expect(await panelRows(panel)).toHaveLength(s.world.total);
    await expect(panel.locator('.banner.tone-warn')).toHaveCount(0);
    expect(s.leaks).toEqual([]);
  });
});

// A service that asks for an hour's pause is named, with the time, and Try again sends nothing to it.
test('when every database asks RefSure to wait an hour, the banner names them and the time, and Try again says so again without asking them', async () => {
  test.setTimeout(120_000);
  await withSession(async (s) => {
    const { panel } = await openedPanel(s, 0);
    s.api.retryAfterSeconds = 3600;
    // What the panel will show: the local time an hour from now, rounded up to the minute (either side of a minute turning).
    const times = await panel.evaluate(() => {
      const at = (ms: number) => new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(Math.ceil(ms / 60_000) * 60_000));
      const t = Date.now() + 3_600_000;
      return [at(t), at(t + 60_000)];
    });
    await panel.getByRole('button', { name: 'Check references' }).click();

    const banner = panel.locator('.banner.tone-warn .banner-text');
    await expect(banner).toContainText("The databases RefSure uses aren't answering right now. This isn't a problem with the paper.", { timeout: 60_000 });
    const said = (await banner.textContent()) ?? '';
    expect(said).toMatch(/(Crossref|arXiv|OpenReview|OpenAlex)[^.]* asked RefSure to wait\. RefSure will try (it|them) again after /);
    expect(times.some((t) => said.includes(`again after ${t}.`))).toBe(true);
    await expect(panel.locator('.announcer')).toHaveText(said);
    const rows = await panelRows(panel);
    expect(lookedUp(rows)).toHaveLength(5);
    expect(rows.every((r) => r.status === 'cant_check')).toBe(true);

    // Try again during the wait: nothing is sent to a service that asked to wait, and the panel says the same again.
    const to = (host: string) => s.api.requests.filter((r) => new URL(r.url).hostname === host).length;
    const before = { crossref: to('api.crossref.org'), arxiv: to('export.arxiv.org'), all: s.api.requests.length };
    expect(before.crossref).toBe(1);
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(panel.getByRole('button', { name: 'Try again' })).toBeFocused({ timeout: 30_000 });
    await expect(banner).toHaveText(said);
    expect(to('api.crossref.org')).toBe(before.crossref);
    expect(to('export.arxiv.org')).toBe(before.arxiv);
    expect(s.api.requests.length - before.all).toBeLessThanOrEqual(2);
    expect(s.leaks).toEqual([]);
  });
});

test('a very narrow panel (320 px at 200% zoom) does not scroll sideways', async () => {
  await withSession(async (s) => {
    const { panel } = await openedPanel(s, 0);
    await s.runCheck(panel);
    await panel.setViewportSize({ width: 160, height: 800 });
    await expect.poll(() => panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    // Open one row of each kind: its details must fit too.
    for (const toggle of await panel.locator('button.row-toggle').all()) {
      await toggle.click();
      if ((await panel.locator('.details').count()) >= 6) break;
    }
    expect(await panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    // The totals line never leaves a bare number at the end of a line: each number is joined to its word.
    expect(await panel.locator('.totals').first().evaluate((node) => /\d (?!·)/.test(node.textContent ?? ''))).toBe(false);
    // The OpenAlex key field stays usable: it wraps above its Save button instead of shrinking to a sliver.
    await panel.getByRole('button', { name: 'Settings' }).click();
    await panel.getByText('Advanced').click();
    const field = panel.locator('input.key-input');
    await expect(field).toBeVisible();
    expect((await field.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(100);
    expect(await panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(s.leaks).toEqual([]);
  });
});
