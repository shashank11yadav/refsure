// A source that asked RefSure to wait (a long Retry-After) is named in the panel with the local
// time the wait ends, in the notices and in the "not answering" banner, and Try again during the wait says the same.
import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { runtime: { id: 'ext-id', getURL: (path: string) => `chrome-extension://ext-id${path}` } } }));

import { blockedNotice, clockTime, servicesDownText, SERVICES_DOWN_TEXT } from '../../../src/ui/banner';
import { byText, click, flush, text } from '../helpers/dom';
import { doneEvent, makeHarness, resultEvent, started, type Harness } from '../helpers/panelHarness';
import { paper, result, summaryOf } from '../helpers/results';

const p = paper();
// Waits still to come when the tests run (a time that has passed is never shown); the wording tests pass `now`.
const UNTIL = Math.ceil(Date.now() / 60_000) * 60_000 + 60 * 60_000 - 30_000;
const LATER = UNTIL + 23 * 60_000 + 30_000;
const NOW = UNTIL - 30 * 60_000;
const blocked = (source: 'crossref' | 'arxiv' | 'openalex', until = UNTIL) => ({ type: 'check:blocked', tabId: 7, paperKey: p.key, source, until }) as const;
const stopped = { type: 'check:stopped', tabId: 7, paperKey: p.key, reason: 'services-down' } as const;
const banners = (h: Harness): string[] => [...h.root.querySelectorAll('.banner .banner-text')].map((b) => text(b));
const failedBy = (index: number, sourcesFailed: ('crossref' | 'arxiv')[]) => result({ index, status: 'cant_check', reason: "Couldn't search", sourcesFailed });
const DOWN = "The databases RefSure uses aren't answering right now. This isn't a problem with the paper.";

describe('wording', () => {
  test('the time is the short local clock time, rounded up to the minute so it is never early', () => {
    const t = Date.UTC(2026, 9, 28, 19, 41, 30);
    expect(clockTime(t)).toBe(clockTime(Date.UTC(2026, 9, 28, 19, 42)));
    expect(clockTime(t)).not.toBe(clockTime(Date.UTC(2026, 9, 28, 19, 41)));
    expect(clockTime(t)).toBe(new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(Date.UTC(2026, 9, 28, 19, 42))));
  });

  test('the notice names the source and when RefSure tries it again, calmly; true for a capped wait too', () => {
    expect(blockedNotice({ source: 'crossref', until: UNTIL })).toEqual({
      tone: 'info',
      text: `Crossref asked RefSure to wait, so references that need it show as Can't check. RefSure will try it again after ${clockTime(UNTIL)}.`,
    });
  });

  test('the "not answering" text names each source that asked to wait, and when each is tried again', () => {
    expect(servicesDownText([], NOW)).toBe(SERVICES_DOWN_TEXT);
    expect(servicesDownText([{ source: 'crossref', until: UNTIL }], NOW)).toBe(`${DOWN} Crossref asked RefSure to wait. RefSure will try it again after ${clockTime(UNTIL)}.`);
    expect(servicesDownText([{ source: 'arxiv', until: UNTIL }, { source: 'crossref', until: LATER }], NOW)).toBe(
      `${DOWN} arXiv and Crossref asked RefSure to wait. RefSure will try Crossref again after ${clockTime(LATER)} and arXiv after ${clockTime(UNTIL)}.`,
    );
  });

  test('sources that wait until the same minute share it', () => {
    const all = (['arxiv', 'crossref', 'openreview', 'openalex'] as const).map((source) => ({ source, until: UNTIL }));
    expect(servicesDownText(all, NOW)).toBe(`${DOWN} arXiv, Crossref, OpenReview and OpenAlex asked RefSure to wait. RefSure will try them again after ${clockTime(UNTIL)}.`);
  });

  test('a wait that has ended is left out, and with none left the text is the plain one', () => {
    expect(servicesDownText([{ source: 'crossref', until: UNTIL }, { source: 'arxiv', until: LATER }], UNTIL + 1)).toBe(`${DOWN} arXiv asked RefSure to wait. RefSure will try it again after ${clockTime(LATER)}.`);
    expect(servicesDownText([{ source: 'crossref', until: UNTIL }], UNTIL)).toBe(SERVICES_DOWN_TEXT);
  });

  test('nothing accuses', () => {
    for (const t of [blockedNotice({ source: 'openalex', until: UNTIL }).text, servicesDownText([{ source: 'arxiv', until: UNTIL }], NOW)]) expect(t).not.toMatch(/fake|hallucinat|blocked you|ban/i);
  });
});

describe('in the panel', () => {
  test('while the check runs, a notice names the source and the time, in place of its "limit reached" notice', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.emit({ type: 'check:limited', tabId: 7, paperKey: p.key, source: 'crossref' });
    await h.emit(blocked('crossref'));
    await h.emit(blocked('crossref'));
    expect(banners(h)).toEqual([blockedNotice({ source: 'crossref', until: UNTIL }).text]);
  });

  test('a later block of the same source replaces the time', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.emit(blocked('crossref'));
    await h.emit(blocked('crossref', LATER));
    expect(banners(h)).toEqual([blockedNotice({ source: 'crossref', until: LATER }).text]);
  });

  test('an earlier time for the same source never replaces a later one', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.emit(blocked('crossref', LATER));
    await h.emit(blocked('crossref'));
    expect(banners(h)).toEqual([blockedNotice({ source: 'crossref', until: LATER }).text]);
  });

  test('at the end of the run it stays, and the source is not also called unreachable', async () => {
    const h = await makeHarness();
    const rs = [result({ index: 1 }), failedBy(2, ['crossref']), failedBy(3, ['arxiv'])];
    await h.emit(started(p, rs.length));
    await h.emit(blocked('crossref'));
    for (const r of rs) await h.emit(resultEvent(r));
    await h.emit(doneEvent(summaryOf(p, rs)));
    expect(banners(h)).toEqual([blockedNotice({ source: 'crossref', until: UNTIL }).text, "Couldn't reach arXiv for some references, so they show as Can't check. Re-check later to try them again."]);
  });

  test('when the run stops because nothing answers, the one banner names the source and the time, and a screen reader hears it', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    await h.emit(blocked('crossref'));
    for (const i of [1, 2, 3, 4, 5]) await h.emit(resultEvent(result({ index: i, status: 'cant_check' })));
    await h.emit(stopped);
    const expected = servicesDownText([{ source: 'crossref', until: UNTIL }]);
    expect(banners(h)).toEqual([expected]);
    expect(text(h.root.querySelector('.announcer') as Element)).toBe(expected);
    expect([...h.root.querySelectorAll('button')].filter((b) => b.textContent === 'Try again')).toHaveLength(1);
  });

  test('Try again during the wait says the same again, calmly, once the new run stops', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    await h.emit(blocked('crossref'));
    await h.emit(stopped);
    click(byText(h.root, 'button', 'Try again'));
    await flush();
    expect(h.sent).toContainEqual({ type: 'check:start', tabId: 7 });
    // The new run: the block is reported again (the refused requests carry it), and the run stops again.
    await h.emit(started(p, 40));
    expect(banners(h)).toEqual([]);
    await h.emit(blocked('crossref'));
    await h.emit(stopped);
    const expected = servicesDownText([{ source: 'crossref', until: UNTIL }]);
    expect(banners(h)).toEqual([expected]);
    expect(text(h.root.querySelector('.announcer') as Element)).toBe(expected);
  });

  test('a wait that ends while the panel is open disappears then; its time is never shown once passed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const h = await makeHarness();
      const rs = [result({ index: 1 }), failedBy(2, ['crossref'])];
      await h.emit(started(p, rs.length));
      await h.emit(blocked('crossref', Date.now() + 5 * 60_000));
      for (const r of rs) await h.emit(resultEvent(r));
      await h.emit(doneEvent(summaryOf(p, rs)));
      expect(banners(h)[0]).toMatch(/^Crossref asked RefSure to wait/);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 2000);
      // The wait is over: Crossref is now what it was, a source that did not answer for one reference.
      expect(banners(h)).toEqual(["Couldn't reach Crossref for some references, so they show as Can't check. Re-check later to try them again."]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a block for another paper is not shown, and a replayed one is shown quietly', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.emit({ ...blocked('crossref'), paperKey: 'arxiv:9999.99999' });
    expect(banners(h)).toEqual([]);
    const late = await makeHarness();
    await late.emit({ ...started(p, 40), replayed: true });
    await late.emit({ ...blocked('arxiv'), replayed: true });
    await late.emit({ ...stopped, replayed: true });
    expect(banners(late)).toEqual([servicesDownText([{ source: 'arxiv', until: UNTIL }])]);
    expect(text(late.root.querySelector('.announcer') as Element)).toBe('');
  });
});
