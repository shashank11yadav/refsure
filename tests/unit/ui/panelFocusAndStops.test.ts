import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { runtime: { id: 'ext-id', getURL: (path: string) => `chrome-extension://ext-id${path}` } } }));

import { byText, click, flush, maybeByText, text } from '../helpers/dom';
import { doneEvent, makeHarness, resultEvent, started, type Harness } from '../helpers/panelHarness';
import { paper, result, summaryOf } from '../helpers/results';

const p = paper();

async function finishedRun(h: Harness) {
  const rs = [result({ index: 1 }), result({ index: 2, status: 'not_found', reason: 'Not found' })];
  await h.emit(started(p, rs.length));
  for (const r of rs) await h.emit(resultEvent(r));
  await h.emit(doneEvent(summaryOf(p, rs)));
}

const focusedKey = (h: Harness): string | null => (h.doc.activeElement as HTMLElement | null)?.getAttribute('data-fk') ?? null;

function key(h: Harness, name: string): void {
  const target = (h.doc.activeElement ?? h.doc.body) as HTMLElement;
  target.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }) as unknown as Event);
}

describe('focus follows the main action', () => {
  test('Check references: focus moves to Stop, not to the page body', async () => {
    const h = await makeHarness();
    byText(h.root, 'button', 'Check references').focus();
    click(byText(h.root, 'button', 'Check references'));
    await flush();
    expect(focusedKey(h)).toBe('act:Stop');
  });

  test('a check that finishes while Stop has focus: focus moves to Copy report', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 1));
    byText(h.root, 'button', 'Stop').focus();
    await h.emit(resultEvent(result({ index: 1 })));
    await h.emit(doneEvent(summaryOf(p, [result({ index: 1 })])));
    expect(focusedKey(h)).toBe('act:Copy report');
  });

  test('Stop with nothing found yet: focus moves to Re-check', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 3));
    byText(h.root, 'button', 'Stop').focus();
    click(byText(h.root, 'button', 'Stop'));
    await flush();
    expect(focusedKey(h)).toBe('act:Re-check');
  });

  test('after the run stops itself (services down), focus goes to the banner\'s Try again', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    for (const i of [1, 2, 3, 4, 5]) await h.emit(resultEvent(result({ index: i, status: 'cant_check' })));
    byText(h.root, 'button', 'Stop').focus();
    await h.emit({ type: 'check:stopped', tabId: 7, paperKey: p.key, reason: 'services-down' });
    expect(focusedKey(h)).toBe('banner:Try again');
  });

  test('Stop with results: focus moves to Copy report', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 3));
    await h.emit(resultEvent(result({ index: 1 })));
    byText(h.root, 'button', 'Stop').focus();
    click(byText(h.root, 'button', 'Stop'));
    await flush();
    expect(focusedKey(h)).toBe('act:Copy report');
  });

  test('Re-check: focus moves to Stop', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    byText(h.root, 'button', 'Re-check').focus();
    click(byText(h.root, 'button', 'Re-check'));
    await flush();
    expect(focusedKey(h)).toBe('act:Stop');
  });

  test('Try again on an error banner: focus moves to Stop', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'check:error', tabId: 7, code: 'fetch-failed', message: 'It did not work', paperKey: p.key });
    byText(h.root, 'button', 'Try again').focus();
    click(byText(h.root, 'button', 'Try again'));
    await flush();
    expect(focusedKey(h)).toBe('act:Stop');
  });

  test('when nothing that could take the focus is left, the screen heading does, and it can be focused', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    // The export button is gone for good once an error replaces the results.
    byText(h.root, 'button', 'Export CSV').focus();
    await h.emit({ type: 'check:error', tabId: 7, code: 'offline', message: 'x', paperKey: p.key });
    const heading = h.root.querySelector('main h1');
    expect(heading).not.toBeNull();
    expect(h.doc.activeElement).toBe(heading);
    expect(heading?.getAttribute('tabindex')).toBe('-1');
  });

  test('focus that is not inside the panel is left alone', async () => {
    const h = await makeHarness();
    const outside = h.doc.createElement('button');
    h.doc.body.append(outside);
    outside.focus();
    await h.emit(started(p, 1));
    expect(h.doc.activeElement).toBe(outside);
  });
});

describe('a live start is announced, a replayed one is not', () => {
  const announced = (h: Harness): string => text(h.root.querySelector('.announcer') as Element);

  test('says how many references and that results arrive as they go', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    expect(announced(h)).toBe('Checking 40 references. Results appear as they arrive.');
  });

  test('one reference is not "1 references"', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 1));
    expect(announced(h)).toBe('Checking 1 reference. Results appear as they arrive.');
  });

  test('a replayed start is quiet', async () => {
    const h = await makeHarness();
    await h.emit({ ...started(p, 40), replayed: true });
    expect(announced(h)).toBe('');
  });

  test('a start for another tab is not announced here', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40, 99));
    expect(announced(h)).toBe('');
  });
});

describe('Escape', () => {
  const historyBox = (h: Harness): HTMLInputElement =>
    [...h.root.querySelectorAll('label')].find((l) => (l.textContent ?? '').includes('Keep history'))?.querySelector('input') as HTMLInputElement;

  test('Escape in Settings goes back to the results', async () => {
    const h = await makeHarness();
    click(byText(h.root, 'button', 'Settings'));
    await flush();
    expect(text(h.root)).toContain('Keep history');
    key(h, 'Escape');
    await flush();
    expect(text(h.root)).toContain('Ready to check this paper');
    expect(h.doc.activeElement).toBe(byText(h.root, 'button', 'Settings'));
  });

  test('Escape in the history confirmation cancels it, keeps history on and refocuses the checkbox', async () => {
    const h = await makeHarness();
    click(byText(h.root, 'button', 'Settings'));
    await flush();
    historyBox(h).click();
    await flush();
    expect(h.root.querySelector('.confirm')).not.toBeNull();
    byText(h.root, 'button', 'Cancel').focus();
    key(h, 'Escape');
    await flush();
    expect(h.root.querySelector('.confirm')).toBeNull();
    expect(text(h.root)).toContain('Keep history');
    expect(h.settingsNow().historyEnabled).toBe(true);
    expect(h.doc.activeElement).toBe(historyBox(h));
    expect(historyBox(h).checked).toBe(true);
  });
});

describe('the heading of each screen', () => {
  test.each([
    ['ready', { id: 7, url: 'https://arxiv.org/html/1706.03762v7', title: 'T' }],
    ['unsupported', { id: 7, url: 'https://example.com/' }],
  ])('the %s screen has exactly one h1', async (_name, tab) => {
    const h = await makeHarness({ tab });
    expect(h.root.querySelectorAll('h1')).toHaveLength(1);
    expect(h.root.querySelectorAll('h2')).toHaveLength(0);
  });

  test('so does the settings screen', async () => {
    const h = await makeHarness();
    click(byText(h.root, 'button', 'Settings'));
    await flush();
    expect(h.root.querySelectorAll('h1')).toHaveLength(1);
    expect(h.root.querySelector('h1')?.textContent).toBe('Settings');
  });

  test('and the results screen (the paper title)', async () => {
    const h = await makeHarness();
    await finishedRun(h);
    expect(h.root.querySelectorAll('h1')).toHaveLength(1);
  });
});

describe('one retry button, called what it does', () => {
  test('an interrupted run has Re-check once, in the action bar', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 3));
    await h.emit(resultEvent(result({ index: 1 })));
    await h.drop();
    expect([...h.root.querySelectorAll('button')].filter((b) => b.textContent === 'Re-check')).toHaveLength(1);
    expect(h.root.querySelector('.banner button')).toBeNull();
  });

  test('error banners offer Try again, not Re-check', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'check:error', tabId: 7, code: 'visibility-unclear', message: 'x', paperKey: p.key });
    expect(maybeByText(h.root, 'button', 'Try again')).toBeDefined();
    expect(maybeByText(h.root, 'button', 'Re-check')).toBeUndefined();
    click(byText(h.root, 'button', 'Try again'));
    await flush();
    expect(h.sent).toContainEqual({ type: 'check:start', tabId: 7 });
  });
});

describe('a source that did not answer for some references', () => {
  const failedBy = (index: number, sources: ('crossref' | 'arxiv' | 'dblp')[]) => result({ index, status: 'cant_check', reason: "Couldn't search Crossref. Try again later", sourcesFailed: sources });
  const NOTICE = "Couldn't reach Crossref for some references, so they show as Can't check. Re-check later to try them again.";
  const banners = (h: Harness): string[] => [...h.root.querySelectorAll('.banner')].map((b) => text(b));

  async function run(h: Harness, rs: ReturnType<typeof result>[]) {
    await h.emit(started(p, rs.length));
    for (const r of rs) await h.emit(resultEvent(r));
    await h.emit(doneEvent(summaryOf(p, rs)));
  }

  test('one info banner, once, when the check ends with some references unchecked because a required source was down', async () => {
    const h = await makeHarness();
    await run(h, [result({ index: 1 }), result({ index: 2 }), failedBy(3, ['crossref']), failedBy(4, ['crossref'])]);
    expect(banners(h)).toEqual([NOTICE]);
    expect(h.root.querySelector('.banner')?.classList.contains('tone-info')).toBe(true);
  });

  test('not while the check is still running', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.emit(resultEvent(result({ index: 1 })));
    await h.emit(resultEvent(failedBy(2, ['crossref'])));
    expect(banners(h)).toEqual([]);
  });

  test('not when every reference failed (that is a different story), nor for DBLP, nor for a source with its own limit notice', async () => {
    const all = await makeHarness();
    await run(all, [failedBy(1, ['crossref']), failedBy(2, ['crossref'])]);
    expect(banners(all)).toEqual([]);
    const optional = await makeHarness();
    await run(optional, [result({ index: 1 }), failedBy(2, ['dblp'])]);
    expect(banners(optional)).toEqual([]);
    const limited = await makeHarness();
    await limited.emit(started(p, 3));
    await limited.emit({ type: 'check:limited', tabId: 7, paperKey: p.key, source: 'crossref' });
    for (const r of [result({ index: 1 }), failedBy(2, ['crossref'])]) await limited.emit(resultEvent(r));
    await limited.emit(doneEvent(summaryOf(p, [result({ index: 1 }), failedBy(2, ['crossref'])])));
    expect(banners(limited)).toHaveLength(1);
    expect(banners(limited)[0]).toContain("Crossref's lookup limit is reached");
  });

  test('a reference that is verified despite a failed source does not count', async () => {
    const h = await makeHarness();
    await run(h, [result({ index: 1, sourcesFailed: ['crossref'] }), result({ index: 2 })]);
    expect(banners(h)).toEqual([]);
  });

  // A saved check keeps no record of which sources were only rate-limited, so it can't tell "didn't answer" from "limited".
  test('not on a saved check read back from history', async () => {
    const rs = [result({ index: 1 }), failedBy(2, ['crossref'])];
    const h = await makeHarness({ history: { ok: true, saved: { summary: summaryOf(p, rs), results: rs } } });
    expect(text(h.root)).toContain('Saved check from');
    expect(banners(h)).toEqual([]);
  });

  test('each source gets its own', async () => {
    const h = await makeHarness();
    await run(h, [result({ index: 1 }), failedBy(2, ['crossref']), failedBy(3, ['arxiv'])]);
    expect(banners(h)).toHaveLength(2);
    expect(banners(h)[1]).toContain("Couldn't reach arXiv for some references");
  });
});

describe('a limited source', () => {
  test('the first time OpenAlex is limited an info banner says what to do, once', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.emit({ type: 'check:limited', tabId: 7, paperKey: p.key, source: 'openalex' });
    await h.emit({ type: 'check:limited', tabId: 7, paperKey: p.key, source: 'openalex' });
    const banners = [...h.root.querySelectorAll('.banner')].map((b) => text(b));
    expect(banners).toEqual(["OpenAlex's free daily search limit is used up, so some references will show as Can't check. Try again tomorrow, or add your own free OpenAlex key in Settings → Advanced."]);
    expect(h.root.querySelector('.banner')?.classList.contains('tone-info')).toBe(true);
  });

  test('another source gets a generic notice without the key hint', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.emit({ type: 'check:limited', tabId: 7, paperKey: p.key, source: 'crossref' });
    const banner = text(h.root.querySelector('.banner') as Element);
    expect(banner).toBe("Crossref's lookup limit is reached for now, so some references will show as Can't check. Try again later.");
    expect(banner).not.toMatch(/key/i);
  });

  test('a notice for another paper is not shown, and a new run starts clean', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 5));
    await h.emit({ type: 'check:limited', tabId: 7, paperKey: 'arxiv:9999.99999', source: 'openalex' });
    expect(h.root.querySelector('.banner')).toBeNull();
    await h.emit({ type: 'check:limited', tabId: 7, paperKey: p.key, source: 'openalex' });
    expect(h.root.querySelector('.banner')).not.toBeNull();
    await h.emit(started(p, 5));
    expect(h.root.querySelector('.banner')).toBeNull();
  });
});

describe('the services stop answering', () => {
  const stopped = { type: 'check:stopped', tabId: 7, paperKey: p.key, reason: 'services-down' } as const;

  test('shows the calm warning with one Try again, keeps the rows, and the run is not marked finished', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    for (const i of [1, 2, 3, 4, 5]) await h.emit(resultEvent(result({ index: i, status: 'cant_check', reason: "Couldn't search Crossref" })));
    await h.emit(stopped);
    const banner = h.root.querySelector('.banner.tone-warn .banner-text');
    expect(text(banner as Element)).toBe("The databases RefSure uses aren't answering right now. This isn't a problem with the paper. Try again in a few minutes.");
    expect([...h.root.querySelectorAll('button')].filter((b) => b.textContent === 'Try again')).toHaveLength(1);
    expect(maybeByText(h.root, 'button', 'Re-check')).toBeUndefined();
    expect(h.root.querySelectorAll('li.row')).toHaveLength(5);
    expect(h.root.querySelector('[role="progressbar"]')).toBeNull();
    expect(text(h.root)).not.toContain('Check stopped.');
  });

  test('Try again starts a new check', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    await h.emit(resultEvent(result({ index: 1, status: 'cant_check' })));
    await h.emit(stopped);
    click(byText(h.root, 'button', 'Try again'));
    await flush();
    expect(h.sent).toContainEqual({ type: 'check:start', tabId: 7 });
  });

  test('a replayed stop is shown the same way', async () => {
    const h = await makeHarness();
    await h.emit({ ...started(p, 40), replayed: true });
    await h.emit({ ...stopped, replayed: true });
    expect(text(h.root)).toContain("The databases RefSure uses aren't answering right now.");
  });

  test('the stop is announced when it is news, and only then', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    await h.emit(stopped);
    expect(text(h.root.querySelector('.announcer') as Element)).toContain("The databases RefSure uses aren't answering right now.");
    const quiet = await makeHarness();
    await quiet.emit({ ...started(p, 40), replayed: true });
    await quiet.emit({ ...stopped, replayed: true });
    expect(text(quiet.root.querySelector('.announcer') as Element)).toBe('');
  });
});

describe('an interrupted run can be exported like a stopped one', () => {
  test('offers the report and exports, marked partial, for the rows it still shows', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    for (const i of [1, 2, 3]) await h.emit(resultEvent(result({ index: i })));
    await h.drop();
    for (const label of ['Copy report', 'Export CSV', 'Export JSON', 'Re-check']) expect(maybeByText(h.root, 'button', label), label).toBeDefined();
    click(byText(h.root, 'button', 'Copy report'));
    await flush();
    expect(h.copied[0]).toContain('Stopped after 3 of 40 references');
    click(byText(h.root, 'button', 'Export JSON'));
    expect(h.downloads[0]?.name).toBe('refsure-arxiv-1706.03762-partial.json');
  });

  test('with nothing found yet there is still nothing to save', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    await h.drop();
    expect(maybeByText(h.root, 'button', 'Copy report')).toBeUndefined();
  });
});

describe('a stopped run can be exported, marked as partial', () => {
  async function stoppedRun(h: Harness) {
    await h.emit(started(p, 40));
    for (const i of [1, 2, 3, 4, 5]) await h.emit(resultEvent(result({ index: i })));
    click(byText(h.root, 'button', 'Stop'));
    await flush();
  }

  test('offers Copy report, Export CSV and Export JSON, plus Re-check', async () => {
    const h = await makeHarness();
    await stoppedRun(h);
    for (const label of ['Copy report', 'Export CSV', 'Export JSON', 'Re-check']) expect(maybeByText(h.root, 'button', label), label).toBeDefined();
  });

  test('with nothing found yet there is nothing to save', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    click(byText(h.root, 'button', 'Stop'));
    await flush();
    expect(maybeByText(h.root, 'button', 'Copy report')).toBeUndefined();
    expect(maybeByText(h.root, 'button', 'Re-check')).toBeDefined();
  });

  test('the copied report says "Stopped after 5 of 40 references" in its header', async () => {
    const h = await makeHarness();
    await stoppedRun(h);
    click(byText(h.root, 'button', 'Copy report'));
    await flush();
    const lines = (h.copied[0] ?? '').split('\n');
    expect(lines[0]).toMatch(/^RefSure check — /);
    expect(lines.slice(0, 5)).toContain('Stopped after 5 of 40 references');
    expect(h.copied[0]).toContain('[1] Verified');
  });

  test('the files are named and marked partial', async () => {
    const h = await makeHarness();
    await stoppedRun(h);
    click(byText(h.root, 'button', 'Export CSV'));
    click(byText(h.root, 'button', 'Export JSON'));
    expect(h.downloads[0]?.name).toBe('refsure-arxiv-1706.03762-partial.csv');
    expect(h.downloads[1]?.name).toBe('refsure-arxiv-1706.03762-partial.json');
    // The report builder's own field (src/core/report.ts), the same one the copied report's header line uses.
    const json = JSON.parse(h.downloads[1]?.content ?? '') as { stoppedAfter?: unknown; results: unknown[]; total: number };
    expect(json.stoppedAfter).toEqual({ checked: 5, total: 40 });
    expect(json.results).toHaveLength(5);
  });

  test('a stop reported by the background counts the same', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    await h.emit(resultEvent(result({ index: 1 })));
    await h.emit({ type: 'check:stopped', tabId: 7, paperKey: p.key, reason: 'user' });
    expect(text(h.root)).toContain('Check stopped');
    expect(maybeByText(h.root, 'button', 'Export CSV')).toBeDefined();
  });

  test('a services-down stop can be exported too', async () => {
    const h = await makeHarness();
    await h.emit(started(p, 40));
    await h.emit(resultEvent(result({ index: 1, status: 'cant_check' })));
    await h.emit({ type: 'check:stopped', tabId: 7, paperKey: p.key, reason: 'services-down' });
    expect(maybeByText(h.root, 'button', 'Copy report')).toBeDefined();
  });
});
