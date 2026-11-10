import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { runtime: { id: 'ext-id', getURL: (path: string) => `chrome-extension://ext-id${path}` } } }));

import { byText, click, flush, maybeByText, text } from '../helpers/dom';
import { ARXIV_TAB, doneEvent, makeHarness, resultEvent, started, type Harness } from '../helpers/panelHarness';
import type { CheckResult } from '../../../src/core/types';
import { paper, result, summaryOf } from '../helpers/results';

const p = paper();

function rowIndexes(h: Harness): number[] {
  return [...h.root.querySelectorAll('li.row')].map((row) => Number(row.getAttribute('data-index')));
}

async function finishedRun(h: Harness, rs = [result({ index: 1 }), result({ index: 2, status: 'not_found', reason: 'Not found in Crossref, arXiv, OpenReview or OpenAlex' })]) {
  await h.emit(started(p, rs.length));
  for (const r of rs) await h.emit(resultEvent(r));
  await h.emit(doneEvent(summaryOf(p, rs)));
  return rs;
}

describe('which state the panel is in', () => {
  test('a tab it cannot see the address of shows the works-on state', async () => {
    const h = await makeHarness({ tab: { id: 7 } });
    expect(text(h.root)).toContain('RefSure works on arXiv and OpenReview papers');
    expect(h.root.querySelector('button.check-btn')).toBeNull();
  });

  test('so does an arXiv page that is not a paper', async () => {
    const h = await makeHarness({ tab: { id: 7, url: 'https://arxiv.org/list/cs.AI/recent' } });
    expect(text(h.root)).toContain('RefSure works on arXiv and OpenReview papers');
  });

  test('no tab at all is also that state', async () => {
    const h = await makeHarness({ tab: null });
    expect(text(h.root)).toContain('RefSure works on arXiv and OpenReview papers');
  });

  test('a paper that has not been checked invites a first check, and the click starts one', async () => {
    const h = await makeHarness();
    expect(text(h.root)).toContain('Ready to check this paper');
    expect(text(h.root)).toMatch(/public scholarly databases/);
    // The time is told as the README tells it.
    expect(text(h.root)).toContain('A full paper usually takes one to two minutes; results appear as they arrive.');
    expect(text(h.root)).not.toContain('under a minute');
    click(byText(h.root, 'button', 'Check references'));
    await flush();
    expect(h.sent).toContainEqual({ type: 'check:start', tabId: 7 });
    expect(h.root.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  test('a saved check is shown at once when there is one', async () => {
    const saved = { summary: summaryOf(p, [result({ index: 1 })]), results: [result({ index: 1 })] };
    const h = await makeHarness({ history: { ok: true, saved } });
    expect(h.sent).toContainEqual({ type: 'history:get', paperKey: 'arxiv:1706.03762' });
    expect(rowIndexes(h)).toEqual([1]);
    expect(text(h.root)).toContain('Saved check from');
    expect(maybeByText(h.root, 'button', 'Re-check')).toBeDefined();
  });
});

describe('streaming results', () => {
  test('the progress bar has aria-valuenow and moves', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 4));
    await h.emit(resultEvent(result({ index: 1 })));
    await h.emit(resultEvent(result({ index: 2 })));
    const bar = h.root.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('2');
    expect(bar?.getAttribute('aria-valuemax')).toBe('4');
    expect(h.root.querySelector('h1')?.textContent).toBe('Attention Is All You Need');
  });

  test('problems are listed before verified rows', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 3));
    await h.emit(resultEvent(result({ index: 1, status: 'verified' })));
    await h.emit(resultEvent(result({ index: 2, status: 'not_found' })));
    await h.emit(resultEvent(result({ index: 3, status: 'verified' })));
    expect(rowIndexes(h)).toEqual([2, 1, 3]);
  });

  test('reason text with markup renders as text', async () => {
    const h = await makeHarness();
    const payload = '<img src=x onerror=alert(1)>';
    await h.emit(started(p, 1));
    await h.emit(resultEvent(result({ index: 1, status: 'not_found', reason: payload })));
    expect(h.root.querySelector('img')).toBeNull();
    expect(h.root.textContent).toContain(payload);
  });

  test('when the check ends a live region announces the result', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    const live = h.root.querySelector('.announcer');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe('Check complete: 1 verified, 1 to look at');
    expect(text(h.root)).toContain('1 verified · 1 not found');
  });

  test('a saved check being shown does not announce anything', async () => {
    const saved = { summary: summaryOf(p, [result({ index: 1 })]), results: [result({ index: 1 })] };
    const h = await makeHarness({ history: { ok: true, saved } });
    expect(h.root.querySelector('.announcer')?.textContent).toBe('');
  });

  test('malformed events are dropped', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'check:result', tabId: 7, paperKey: 'arxiv:1706.03762', result: { index: 'x' } });
    await h.emit({ type: 'surprise' });
    expect(rowIndexes(h)).toEqual([]);
  });
});

describe('only the current paper', () => {
  test('results for a different paperKey than the active tab are not rendered', async () => {
    const h = await makeHarness();
    const other = paper({ key: 'arxiv:9999.99999', title: 'Some Other Paper' });
    await h.emit(started(other, 1));
    await h.emit(resultEvent(result({ index: 1, status: 'not_found' }), 'arxiv:9999.99999'));
    await h.emit(doneEvent(summaryOf(other, [result({ index: 1, status: 'not_found' })])));
    expect(rowIndexes(h)).toEqual([]);
    expect(text(h.root)).not.toContain('Some Other Paper');
    expect(text(h.root)).toContain('Ready to check this paper');
  });

  test('a result stamped with another paperKey does not join the current run', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 2));
    await h.emit(resultEvent(result({ index: 1 }), 'arxiv:9999.99999'));
    expect(rowIndexes(h)).toEqual([]);
  });

  test('events for another tab are not rendered here', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 1, 99));
    await h.emit(resultEvent(result({ index: 1 }), 'arxiv:1706.03762', 99));
    expect(rowIndexes(h)).toEqual([]);
  });

  test('moving the tab to another paper drops the old rows; coming back brings them back', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    expect(rowIndexes(h)).toHaveLength(2);
    await h.setTab({ id: 7, url: 'https://arxiv.org/html/2001.00001v1' });
    expect(rowIndexes(h)).toEqual([]);
    await h.setTab(ARXIV_TAB);
    expect(rowIndexes(h)).toHaveLength(2);
  });

  // Found by the end-to-end run: leaving a paper mid-check makes the background drop the run without a word, so
  // the panel's copy of it would sit at "Checking 3 of 40" for good, and be shown again on coming back.
  test('a check abandoned by leaving its paper is not shown again on coming back', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 3));
    await h.emit(resultEvent(result({ index: 1 })));
    expect(rowIndexes(h)).toEqual([1]);
    await h.setTab({ id: 7, url: 'https://arxiv.org/html/2001.00001v1' });
    await h.setTab(ARXIV_TAB);
    expect(rowIndexes(h)).toEqual([]);
    expect(h.root.querySelector('[role="progressbar"]')).toBeNull();
    expect(text(h.root)).toContain('Ready to check this paper');
  });

  test('a check that is still running is kept when the same paper is looked at again', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 3));
    await h.emit(resultEvent(result({ index: 1 })));
    await h.setTab(ARXIV_TAB);
    expect(rowIndexes(h)).toEqual([1]);
    expect(h.root.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  test('switching to a tab that is not a paper shows the works-on state', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    await h.setTab({ id: 8 });
    expect(text(h.root)).toContain('RefSure works on arXiv and OpenReview papers');
    expect(rowIndexes(h)).toEqual([]);
  });
});

describe('the live region stays quiet', () => {
  test('expanding a row after a finished check does not touch the announcer', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    const announcer = h.root.querySelector('.announcer') as Element;
    const node = announcer.firstChild;
    expect(node?.textContent).toBe('Check complete: 1 verified, 1 to look at');
    click(h.root.querySelector('li.row[data-index="1"] button.row-toggle') as Element);
    click(byText(h.root, 'button', 'Not found 1'));
    expect(announcer.firstChild).toBe(node);
    expect(announcer.textContent).toBe('Check complete: 1 verified, 1 to look at');
  });

  test('the toast is not rewritten by an unrelated redraw', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    click(byText(h.root, 'button', 'Copy report'));
    await flush();
    const toast = h.root.querySelector('.toast') as Element;
    const node = toast.firstChild;
    expect(node?.textContent).toBe('Report copied.');
    click(h.root.querySelector('li.row[data-index="1"] button.row-toggle') as Element);
    expect(toast.firstChild).toBe(node);
  });

  test('the announcement is cleared when the tab moves to another paper', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    await h.setTab({ id: 7, url: 'https://arxiv.org/html/2001.00001v1' });
    expect(h.root.querySelector('.announcer')?.textContent).toBe('');
  });

  test('a run replayed after a reconnect is not announced', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    await h.drop();
    await h.setTab(ARXIV_TAB); // reconnects quietly
    expect(h.ports.length).toBe(2);
    const rs = [result({ index: 1 }), result({ index: 2, status: 'not_found' })];
    await h.emit({ ...started(p, 2), replayed: true });
    for (const r of rs) await h.emit({ ...resultEvent(r), replayed: true });
    await h.emit({ ...doneEvent(summaryOf(p, rs)), replayed: true });
    expect(h.root.querySelector('.announcer')?.textContent).toBe('');
    expect(rowIndexes(h)).toEqual([2, 1]);
  });

  test('a toolbar-started run: the panel connects mid-run, the replay is quiet, the live end is announced', async () => {
    const h = await makeHarness();
    const rs = [result({ index: 1 }), result({ index: 2, status: 'not_found' }), result({ index: 3 })];
    await h.emit({ ...started(p, 3), replayed: true });
    await h.emit({ ...resultEvent(rs[0] as CheckResult), replayed: true });
    expect(h.root.querySelector('.announcer')?.textContent).toBe('');
    await h.emit(resultEvent(rs[1] as CheckResult));
    await h.emit(resultEvent(rs[2] as CheckResult));
    await h.emit(doneEvent(summaryOf(p, rs)));
    expect(h.root.querySelector('.announcer')?.textContent).toBe('Check complete: 2 verified, 1 to look at');
  });

  test('a run started live and finished live is announced', async () => {
    const h = await makeHarness();
    const rs = [result({ index: 1 })];
    await h.emit(started(p, 1));
    await h.emit(resultEvent(rs[0] as CheckResult));
    await h.emit(doneEvent(summaryOf(p, rs)));
    expect(h.root.querySelector('.announcer')?.textContent).toBe('Check complete: 1 verified, 0 to look at');
  });

  test('a live error is announced with its calm wording; a replayed one is not', async () => {
    const live = await makeHarness();
    await live.emit({ type: 'check:error', tabId: 7, code: 'offline', message: 'x', paperKey: 'arxiv:1706.03762' });
    expect(live.root.querySelector('.announcer')?.textContent).toBe('You appear to be offline. Connect and press Try again.');
    const replay = await makeHarness();
    await replay.emit({ type: 'check:error', tabId: 7, code: 'offline', message: 'x', paperKey: 'arxiv:1706.03762', replayed: true });
    expect(replay.root.querySelector('.announcer')?.textContent).toBe('');
    expect(replay.root.querySelector('.banner')).not.toBeNull();
  });

  test('a check the user asks for after a reconnect is announced', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    await h.drop();
    click(byText(h.root, 'button', 'Re-check'));
    await flush();
    const rs = [result({ index: 1 })];
    await h.emit(started(p, 1));
    await h.emit(resultEvent(rs[0] as CheckResult));
    await h.emit(doneEvent(summaryOf(p, rs)));
    expect(h.root.querySelector('.announcer')?.textContent).toBe('Check complete: 1 verified, 0 to look at');
  });
});

describe('errors', () => {
  test('offline banner shows when check:error code offline arrives', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'check:error', tabId: 7, code: 'offline', message: 'x', paperKey: 'arxiv:1706.03762' });
    const banner = h.root.querySelector('.banner');
    expect(banner?.textContent).toContain('You appear to be offline. Connect and press Try again.');
    expect(maybeByText(h.root, 'button', 'Try again')).toBeDefined();
  });

  test('a confidential paper shows the DESIGN wording and no retry button', async () => {
    const h = await makeHarness({ tab: { id: 7, url: 'https://openreview.net/forum?id=abc123XYZ' } });
    await h.emit({ type: 'check:error', tabId: 7, code: 'confidential', message: 'x', paperKey: 'openreview:abc123XYZ' });
    expect(text(h.root)).toContain("This submission isn't public, so RefSure didn't check it. Nothing was sent anywhere.");
    expect(maybeByText(h.root, 'button', 'Re-check')).toBeUndefined();
    expect(maybeByText(h.root, 'button', 'Try again')).toBeUndefined();
  });

  test('an error for another paper is not shown', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'check:error', tabId: 7, code: 'offline', message: 'x', paperKey: 'arxiv:9999.99999' });
    expect(h.root.querySelector('.banner')).toBeNull();
  });

  test('Try again after an error asks for a new check', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'check:error', tabId: 7, code: 'fetch-failed', message: 'RefSure could not read it', paperKey: 'arxiv:1706.03762' });
    expect(text(h.root)).toContain('RefSure could not read it');
    click(byText(h.root, 'button', 'Try again'));
    await flush();
    expect(h.sent).toContainEqual({ type: 'check:start', tabId: 7 });
  });

  test('the background refusing a check shows a calm banner', async () => {
    const h = await makeHarness();
    h.deps.send.mockResolvedValueOnce({ ok: false, error: "RefSure can't use that tab any more." });
    // history:get already ran during start; the next send is check:start.
    click(byText(h.root, 'button', 'Check references'));
    await flush();
    expect(text(h.root)).toContain("RefSure can't use that tab any more.");
  });
});

describe('interrupted runs', () => {
  test('a port that drops during a run shows the banner and Re-check in the action bar; acting reconnects', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 3));
    await h.emit(resultEvent(result({ index: 1 })));
    await h.drop();
    expect(text(h.root)).toContain('Check interrupted. Press Re-check to start again.');
    expect(rowIndexes(h)).toEqual([1]);
    const before = h.ports.length;
    click(byText(h.root, 'button', 'Re-check'));
    await flush();
    expect(h.ports.length).toBe(before + 1);
    expect(h.sent).toContainEqual({ type: 'check:start', tabId: 7 });
    expect(text(h.root)).not.toContain('Check interrupted');
    expect(h.root.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  test('a port that drops with nothing running shows nothing', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    await h.drop();
    expect(text(h.root)).not.toContain('interrupted');
  });

  test('Re-check after a quiet drop reconnects before sending', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    await h.drop();
    const before = h.ports.length;
    click(byText(h.root, 'button', 'Re-check'));
    await flush();
    expect(h.ports.length).toBe(before + 1);
    expect(h.sent.at(-1)).toEqual({ type: 'check:start', tabId: 7 });
  });
});

describe('what the header says', () => {
  test('an OpenReview page checked through arXiv says so, with a validated link', async () => {
    const h = await makeHarness({ tab: { id: 7, url: 'https://openreview.net/forum?id=abc123XYZ' } });
    const op = paper({ key: 'openreview:abc123XYZ', origin: 'openreview', viaArxivVersion: '1706.03762', title: 'A paper' });
    await h.emit(started(op, 1));
    expect(text(h.root)).toContain('Checked using the arXiv version (arXiv:1706.03762)');
    expect(h.root.querySelector('a[href="https://arxiv.org/abs/1706.03762"]')).not.toBeNull();
  });

  test('PDF results carry a Beta pill and one line of help', async () => {
    const h = await makeHarness({ tab: { id: 7, url: 'https://arxiv.org/pdf/1706.03762v7' } });
    const pdf = paper({ viaPdf: true, origin: 'arxiv-pdf' });
    await h.emit(started(pdf, 1));
    expect(h.root.querySelector('.pill')?.textContent).toBe('Beta');
    expect(text(h.root)).toContain('References read from the PDF. A few may be misread.');
  });
});

describe('rows, filters and the page', () => {
  test('filter chips show counts and narrow the list', async () => {
    const h = await makeHarness();
    await finishedRun(h, [result({ index: 1 }), result({ index: 2, status: 'not_found' }), result({ index: 3 })]);
    expect([...(h.root.querySelector('.filters')?.querySelectorAll('button') ?? [])].map((b) => text(b))).toEqual(['All 3', 'Not found 1', 'Verified 2']);
    click(byText(h.root, 'button', 'Verified 2'));
    expect(rowIndexes(h)).toEqual([1, 3]);
    click(byText(h.root, 'button', 'All 3'));
    expect(rowIndexes(h)).toEqual([2, 1, 3]);
  });

  test('clicking a row on an HTML page asks the page to scroll to that reference', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    click(h.root.querySelector('li.row[data-index="2"] .citation') as Element);
    await flush();
    expect(h.tabMessages).toEqual([{ tabId: 7, message: { type: 'ref:scrollTo', index: 2 } }]);
  });

  test('on a PDF or abstract page there is nothing to scroll to', async () => {
    const h = await makeHarness({ tab: { id: 7, url: 'https://arxiv.org/abs/1706.03762' } });
    const abs = paper({ origin: 'arxiv-abs' });
    await h.emit(started(abs, 1));
    await h.emit(resultEvent(result({ index: 1 })));
    click(h.root.querySelector('li.row .citation') as Element);
    await flush();
    expect(h.tabMessages).toEqual([]);
    expect(maybeByText(h.root, 'button', 'Show on page')).toBeUndefined();
  });

  test('a badge click on the page opens that row', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    await h.emit({ type: 'badge:clicked', tabId: 7, index: 2 });
    const row = h.root.querySelector('li.row[data-index="2"]');
    expect(row?.querySelector('button.row-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  // The click opened the panel, so its event can arrive before the panel knows its tab or has the row.
  test('a badge click that arrives before the panel knows its tab opens the row once it does', async () => {
    const h = await makeHarness({ tab: null });
    const rs = [result({ index: 1 }), result({ index: 2, status: 'not_found', reason: 'Not found' })];
    await h.emit({ ...started(p, rs.length), replayed: true });
    for (const r of rs) await h.emit({ ...resultEvent(r), replayed: true });
    await h.emit({ ...doneEvent(summaryOf(p, rs)), replayed: true });
    await h.emit({ type: 'badge:clicked', tabId: 7, index: 2 });
    await h.setTab(ARXIV_TAB);
    expect(h.root.querySelector('li.row[data-index="2"] button.row-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  test('a badge click that arrives before the saved check is read back opens the row once it is', async () => {
    const rs = [result({ index: 1 }), result({ index: 2, status: 'not_found', reason: 'Not found' })];
    const h = await makeHarness({ tab: null, history: { ok: true, saved: { summary: summaryOf(p, rs), results: rs } } });
    await h.emit({ type: 'badge:clicked', tabId: 7, index: 2 });
    await h.setTab(ARXIV_TAB);
    await flush();
    expect(h.root.querySelector('li.row[data-index="2"] button.row-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  // The background keeps a click made while no panel was open for the panel of that tab that asks.
  test('a panel opened by a badge click asks for it by its tab and opens that row', async () => {
    const rs = [result({ index: 1 }), result({ index: 2, status: 'not_found', reason: 'Not found' })];
    const h = await makeHarness({ history: { ok: true, saved: { summary: summaryOf(p, rs), results: rs } }, badgeTake: { ok: true, badgeIndex: 2 } });
    await flush();
    expect(h.sent).toContainEqual({ type: 'badge:take', tabId: 7 });
    expect(h.root.querySelector('li.row[data-index="2"] button.row-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  test('a live badge click from another tab is ignored', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    await h.emit({ type: 'badge:clicked', tabId: 8, index: 2 });
    expect(h.root.querySelector('li.row[data-index="2"] button.row-toggle')?.getAttribute('aria-expanded')).toBe('false');
  });

  test('a waiting badge click is dropped after a few seconds, and never applied to another tab', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = await makeHarness({ tab: null });
      const rs = [result({ index: 1 }), result({ index: 2, status: 'not_found', reason: 'Not found' })];
      await h.emit(started(p, rs.length));
      for (const r of rs) await h.emit(resultEvent(r));
      await h.emit(doneEvent(summaryOf(p, rs)));
      await h.emit({ type: 'badge:clicked', tabId: 8, index: 2 });
      await h.emit({ type: 'badge:clicked', tabId: 7, index: 2 });
      vi.setSystemTime(Date.now() + 30_000);
      await h.setTab(ARXIV_TAB);
      expect(h.root.querySelector('li.row[data-index="2"] button.row-toggle')?.getAttribute('aria-expanded')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a badge click while another filter hides the row clears the filter', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    click(byText(h.root, 'button', 'Verified 1'));
    await h.emit({ type: 'badge:clicked', tabId: 7, index: 2 });
    expect(h.root.querySelector('li.row[data-index="2"]')).not.toBeNull();
  });
});

describe('actions', () => {
  test('Stop cancels the run and keeps what was found', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.emit(resultEvent(result({ index: 1 })));
    click(byText(h.root, 'button', 'Stop'));
    await flush();
    expect(h.sent).toContainEqual({ type: 'check:cancel', tabId: 7 });
    expect(text(h.root)).toContain('Check stopped');
    expect(rowIndexes(h)).toEqual([1]);
    expect(maybeByText(h.root, 'button', 'Re-check')).toBeDefined();
  });

  test('exports appear only when the check is done', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 2));
    await h.emit(resultEvent(result({ index: 1 })));
    expect(maybeByText(h.root, 'button', 'Export CSV')).toBeUndefined();
    expect(maybeByText(h.root, 'button', 'Copy report')).toBeUndefined();
    await h.emit(doneEvent(summaryOf(p, [result({ index: 1 })])));
    expect(maybeByText(h.root, 'button', 'Export CSV')).toBeDefined();
  });

  test('Export CSV and Export JSON hand the right text to the download', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    click(byText(h.root, 'button', 'Export CSV'));
    click(byText(h.root, 'button', 'Export JSON'));
    expect(h.downloads[0]?.name).toBe('refsure-arxiv-1706.03762.csv');
    expect(h.downloads[0]?.mime).toBe('text/csv');
    expect(h.downloads[0]?.content).toMatch(/^"Number",/);
    expect(h.downloads[1]?.name).toBe('refsure-arxiv-1706.03762.json');
    expect(h.downloads[1]?.mime).toBe('application/json');
    expect(() => JSON.parse(h.downloads[1]?.content ?? '')).not.toThrow();
  });

  test('Copy report writes the report to the clipboard and says so', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    click(byText(h.root, 'button', 'Copy report'));
    await flush();
    expect(h.copied[0]).toMatch(/^RefSure check — /);
    expect(text(h.root.querySelector('.toast') as Element)).toContain('Report copied');
  });

  test('when the clipboard refuses, the report is shown in a selectable box', async () => {
    const h = await makeHarness({ clipboard: 'fail' });
    await finishedRun(h);
    click(byText(h.root, 'button', 'Copy report'));
    await flush();
    const box = h.root.querySelector<HTMLTextAreaElement>('textarea.report-box');
    expect(box?.value).toMatch(/^RefSure check — /);
    expect(box?.hasAttribute('readonly')).toBe(true);
  });

  test('with no clipboard at all the box is shown too', async () => {
    const h = await makeHarness({ clipboard: 'none' });
    await finishedRun(h);
    click(byText(h.root, 'button', 'Copy report'));
    await flush();
    expect(h.root.querySelector('textarea.report-box')).not.toBeNull();
  });
});

describe('the active tab', () => {
  test('a slow answer for an older question does not overwrite a newer one', async () => {
    const h = await makeHarness({ tab: null });
    let release: (tab: { id: number; url: string; title: string }) => void = () => undefined;
    const slow = new Promise<{ id: number; url: string; title: string }>((resolve) => {
      release = resolve;
    });
    h.deps.activeTab = () => slow;
    const first = h.panel.refreshActiveTab();
    h.deps.activeTab = () => Promise.resolve({ id: 7, url: 'https://arxiv.org/html/2001.00001v1', title: 'The newer paper' });
    await h.panel.refreshActiveTab();
    release({ id: 7, url: 'https://arxiv.org/html/1706.03762v7', title: 'The older paper' });
    await first;
    await flush();
    expect(text(h.root)).toContain('The newer paper');
    expect(text(h.root)).not.toContain('The older paper');
  });
});

describe('stopping with nothing found', () => {
  test('says "No results yet", not "No references"', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    click(byText(h.root, 'button', 'Stop'));
    await flush();
    expect(text(h.root)).toContain('No results yet');
    expect(text(h.root)).not.toContain('No references');
  });

  test('so does an interruption before any result', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.drop();
    expect(text(h.root)).toContain('No results yet');
  });
});

describe('the page structure', () => {
  test('the host page has no landmark of its own: the panel draws the only main', async () => {
    const html = readFileSync(join(process.cwd(), 'src/entrypoints/sidepanel/index.html'), 'utf8');
    expect(html).not.toMatch(/<main/);
    const h = await makeHarness();
    expect(h.doc.querySelectorAll('main')).toHaveLength(1);
  });
});

describe('settings', () => {
  test('Back returns focus to the Settings button', async () => {
    const h = await makeHarness();
    const settings = byText(h.root, 'button', 'Settings');
    click(settings);
    await flush();
    click(byText(h.root, 'button', 'Back'));
    await flush();
    expect(h.doc.activeElement).toBe(byText(h.root, 'button', 'Settings'));
  });

  test('the Settings button opens the settings view and Back returns', async () => {
    const h = await makeHarness();
    click(byText(h.root, 'button', 'Settings'));
    await flush();
    expect(text(h.root)).toContain('Keep history');
    click(byText(h.root, 'button', 'Back'));
    await flush();
    expect(text(h.root)).toContain('Ready to check this paper');
  });

  test('Clear history sends history:clear and confirms only after ok', async () => {
    const h = await makeHarness();
    click(byText(h.root, 'button', 'Settings'));
    await flush();
    click(byText(h.root, 'button', 'Clear history'));
    await flush();
    expect(h.sent).toContainEqual({ type: 'history:clear' });
    expect(text(h.root.querySelector('.toast') as Element)).toContain('History cleared.');
  });

  test('a clear the background refuses is reported as failed', async () => {
    const h = await makeHarness();
    h.setClearReply({ ok: false, error: 'nope' });
    click(byText(h.root, 'button', 'Settings'));
    await flush();
    click(byText(h.root, 'button', 'Clear history'));
    await flush();
    expect(text(h.root.querySelector('.toast') as Element)).toContain("Couldn't clear history");
  });
});

describe('messages it does not own', () => {
  test('the panel and its UI code register no runtime.onMessage listener at all', () => {
    // Offscreen parse requests are broadcast and can be tens of MB; a panel with no listener cannot
    // answer one by mistake. Events reach the panel over its port only.
    const dirs = ['src/ui', 'src/entrypoints/sidepanel', 'src/entrypoints/welcome'];
    for (const dir of dirs) {
      for (const file of readdirSync(join(process.cwd(), dir), { recursive: true, encoding: 'utf8' })) {
        if (!/\.(ts|html)$/.test(file)) continue;
        const source = readFileSync(join(process.cwd(), dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        // `runtime.onMessage` only: a Port's own `onMessage` (our private channel) is how events arrive.
        expect(source, `${dir}/${file}`).not.toMatch(/runtime\s*\.\s*onMessage/);
      }
    }
  });
});
