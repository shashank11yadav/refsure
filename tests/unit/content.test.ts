import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Window } from 'happy-dom';
import { trustedClick } from './helpers/dom';
import { pageText } from './helpers/pages';
import { snapshot } from './helpers/snapshot';
import { recordShadowRoots } from './helpers/shadow';

type Sender = { id?: string; url?: string; tab?: unknown };
type Listener = (message: unknown, sender: Sender, sendResponse: (reply: unknown) => void) => boolean;

const registered: Listener[] = [];
const sendMessage = vi.fn<(message: unknown) => Promise<unknown>>(() => Promise.resolve(undefined));
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'ext-id',
      getURL: (path: string) => `chrome-extension://ext-id${path}`,
      onMessage: { addListener: (l: Listener) => registered.push(l) },
      sendMessage: (message: unknown) => sendMessage(message),
    },
  },
}));

const BACKGROUND: Sender = { id: 'ext-id', url: 'chrome-extension://ext-id/background.js' };
const PAPER_KEY = 'arxiv:2402.03664';

type Script = { matches: string[]; runAt?: string; allFrames?: boolean; noScriptStartedPostMessage?: boolean; main: () => void };
let content: Script;
let win: Window;
let doc: Document;
let captured: { root: ShadowRoot }[];

// A parsed document has no address of its own; the real one is what the browser reports as document.URL.
function atAddress(page: Document, url: string): Document {
  Object.defineProperty(page, 'URL', { value: url, configurable: true });
  return page;
}

function load(): Document {
  win = new Window({ url: 'https://arxiv.org/html/2402.03664v5' });
  return atAddress(new win.DOMParser().parseFromString(pageText('arxiv-2402.03664v5.html'), 'text/html') as unknown as Document, 'https://arxiv.org/html/2402.03664v5');
}

function ask(message: unknown, sender: Sender = BACKGROUND): Promise<{ handled: boolean; reply?: unknown }> {
  return new Promise((resolve) => {
    const listener = registered[0];
    if (!listener) throw new Error('the content script registered no listener');
    const handled = listener(message, sender, (reply) => resolve({ handled: true, reply }));
    if (!handled) resolve({ handled: false });
  });
}

const flushed = () => new Promise((resolve) => setTimeout(resolve, 20));
const hosts = () => doc.querySelectorAll('refsure-badge');
const sent = () => sendMessage.mock.calls.map((call) => call[0]);

beforeAll(async () => {
  doc = load();
  captured = recordShadowRoots(win).roots;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  content = (await import('../../src/entrypoints/arxiv.content')).default as unknown as Script;
  content.main();
});

beforeEach(async () => {
  await ask({ type: 'badges:clear' });
  sendMessage.mockClear();
});

describe('arXiv content script registration', () => {
  test('runs only on arXiv HTML papers, in the top frame, once the page is idle', () => {
    expect(content.matches).toEqual(['https://arxiv.org/html/*']);
    expect(content.runAt).toBe('document_idle');
    expect(content.allFrames ?? false).toBe(false);
  });

  // WXT otherwise posts the extension id to the page's own scripts on every load.
  test('does not announce itself to the page with a window.postMessage at start-up', () => {
    expect(content.noScriptStartedPostMessage).toBe(true);
  });

  test('registers one listener', () => {
    expect(registered).toHaveLength(1);
  });
});

describe('content:ready', () => {
  test('is sent on load with the key taken from the page address', async () => {
    // A second, independent run on the same kind of page.
    sendMessage.mockClear();
    const before = registered.length;
    content.main();
    expect(registered).toHaveLength(before + 1);
    expect(sent()).toEqual([{ type: 'content:ready', paperKey: PAPER_KEY }]);
  });
});

describe('refs:extract', () => {
  test('answers with the references and the title the page shows', async () => {
    const { handled, reply } = await ask({ type: 'refs:extract' });
    expect(handled).toBe(true);
    const r = reply as { refs: { index: number; label: string; anchorId?: string }[]; title?: string };
    expect(r.refs.length).toBeGreaterThan(20);
    expect(r.refs[0]).toMatchObject({ index: 1 });
    expect(typeof r.title).toBe('string');
    expect(r.title?.length ?? 0).toBeGreaterThan(0);
  });

  test('sends nothing by itself while answering', async () => {
    await ask({ type: 'refs:extract' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('badges', () => {
  test('badges:update puts a closed-shadow badge at the end of each matching reference', async () => {
    const { reply } = await ask({ type: 'refs:extract' });
    const refs = (reply as { refs: { index: number; anchorId?: string }[] }).refs;
    const before = snapshot(doc.documentElement);
    const imagesBefore = doc.querySelectorAll('img').length;
    const { handled } = await ask({
      type: 'badges:update',
      paperKey: PAPER_KEY,
      results: [
        { index: 1, status: 'verified', reason: 'Found in Crossref.' },
        { index: 3, status: 'retracted', reason: '<img src=x onerror=alert(1)>' },
      ],
    });
    expect(handled).toBe(false);
    await flushed();
    expect(hosts()).toHaveLength(2);
    for (const [index, id] of [[1, refs[0]?.anchorId], [3, refs[2]?.anchorId]] as const) {
      const li = doc.getElementById(id ?? '');
      expect(li?.lastElementChild?.tagName.toLowerCase(), `ref ${index}`).toBe('refsure-badge');
    }
    expect(doc.querySelectorAll('img')).toHaveLength(imagesBefore);
    expect(snapshot(doc.documentElement, ['refsure-badge'])).toBe(before);
    expect(captured.every(({ root }) => root.host.shadowRoot === null)).toBe(true);
    // Page scripts can see the hosts but not the verdicts.
    for (const host of hosts()) expect(host.getAttributeNames()).toEqual([]);
    expect(snapshot(doc.documentElement)).not.toMatch(/data-status|data-highlight/);
  });

  test('badges:update for another paper is ignored', async () => {
    await ask({ type: 'refs:extract' });
    await ask({ type: 'badges:update', paperKey: 'arxiv:2106.09685', results: [{ index: 1, status: 'verified', reason: 'x' }] });
    await ask({ type: 'badges:update', paperKey: 'openreview:abc', results: [{ index: 1, status: 'verified', reason: 'x' }] });
    await flushed();
    expect(hosts()).toHaveLength(0);
  });

  test('badges:clear removes every host', async () => {
    await ask({ type: 'refs:extract' });
    await ask({
      type: 'badges:update',
      paperKey: PAPER_KEY,
      results: [
        { index: 1, status: 'verified', reason: 'a' },
        { index: 2, status: 'not_found', reason: 'b' },
      ],
    });
    await flushed();
    expect(hosts()).toHaveLength(2);
    await ask({ type: 'badges:clear' });
    expect(hosts()).toHaveLength(0);
  });

  test('a badge click is reported to the background as badge:clicked', async () => {
    await ask({ type: 'refs:extract' });
    await ask({ type: 'badges:update', paperKey: PAPER_KEY, results: [{ index: 2, status: 'verified', reason: 'a' }] });
    await flushed();
    const root = captured.find((c) => c.root.host.isConnected)?.root;
    const button = root?.querySelector('button') as HTMLElement;
    button.click(); // a click a script makes is ignored
    expect(sent()).toEqual([]);
    trustedClick(button);
    expect(sent()).toEqual([{ type: 'badge:clicked', index: 2 }]);
  });

  test('a result with an unknown status or an invalid index refuses the whole message', async () => {
    await ask({ type: 'refs:extract' });
    await ask({ type: 'badges:update', paperKey: PAPER_KEY, results: [{ index: 1, status: 'bogus', reason: 'x' }] });
    await ask({ type: 'badges:update', paperKey: PAPER_KEY, results: [{ index: -1, status: 'verified', reason: 'x' }] });
    await flushed();
    expect(hosts()).toHaveLength(0);
  });
});

describe('badges: extra fields', () => {
  test('a result with fields beyond index, status and reason is drawn from those three only', async () => {
    await ask({ type: 'refs:extract' });
    await ask({ type: 'badges:update', paperKey: PAPER_KEY, results: [{ index: 1, status: 'verified', reason: 'kept', secret: 'dropped', links: ['https://evil.example/'] }] });
    await flushed();
    expect(hosts()).toHaveLength(1);
    const root = captured.find((c) => c.root.host.isConnected)?.root;
    expect(root?.querySelector('.tip')?.textContent).toBe('kept');
    expect(root?.querySelector('a')).toBeNull();
    expect(snapshot(doc.documentElement)).not.toMatch(/dropped|evil\.example/);
  });
});

describe('ref:scrollTo', () => {
  test('scrolls to the reference and highlights it', async () => {
    const { reply } = await ask({ type: 'refs:extract' });
    const refs = (reply as { refs: { anchorId?: string }[] }).refs;
    await ask({ type: 'badges:update', paperKey: PAPER_KEY, results: [{ index: 2, status: 'verified', reason: 'a' }] });
    await flushed();
    const li = doc.getElementById(refs[1]?.anchorId ?? '') as HTMLElement;
    const scroll = vi.fn();
    li.scrollIntoView = scroll;
    const { handled } = await ask({ type: 'ref:scrollTo', index: 2 });
    expect(handled).toBe(false);
    expect(scroll).toHaveBeenCalledOnce();
    const host = li.querySelector('refsure-badge');
    expect(host?.getAttributeNames()).toEqual([]);
    expect(captured.find((c) => c.root.host === host)?.root.querySelector('[data-highlight]')).not.toBeNull();
  });
});

describe('who may talk to it', () => {
  test('ignores messages from web pages, other extensions and tabs', async () => {
    await ask({ type: 'refs:extract' });
    const update = { type: 'badges:update', paperKey: PAPER_KEY, results: [{ index: 1, status: 'verified', reason: 'x' }] };
    for (const sender of [
      { id: 'other-ext', url: 'chrome-extension://other-ext/x.html' },
      { id: 'ext-id', tab: { id: 1 }, url: 'https://arxiv.org/html/2402.03664v5' },
      { id: 'ext-id', tab: { id: 1 } },
      {},
      { url: 'chrome-extension://ext-id/x.html' },
    ]) {
      expect((await ask({ type: 'refs:extract' }, sender)).handled).toBe(false);
      expect((await ask(update, sender)).handled).toBe(false);
      expect((await ask({ type: 'ref:scrollTo', index: 1 }, sender)).handled).toBe(false);
      expect((await ask({ type: 'badges:clear' }, sender)).handled).toBe(false);
    }
    await flushed();
    expect(hosts()).toHaveLength(0);
  });

  test('ignores unknown and malformed messages, and the OpenReview request', async () => {
    for (const message of [{ type: 'openreview:read' }, { type: 'check:start', tabId: 1 }, { type: 'ref:scrollTo', index: -1 }, { type: 'ref:scrollTo' }, null, 'refs:extract', {}]) {
      expect((await ask(message)).handled).toBe(false);
    }
  });

  test('does not listen to window.postMessage', async () => {
    const listen = vi.spyOn(win, 'addEventListener');
    content.main();
    const seen = listen.mock.calls.map((call) => call[0]);
    expect(seen).toContain('pagehide');
    expect(seen).not.toContain('message');
  });
});

describe('leaving the page', () => {
  test('pagehide sends page:leaving with the page\'s key', () => {
    const event = new win.Event('pagehide');
    Object.defineProperty(event, 'isTrusted', { value: true });
    win.dispatchEvent(event);
    expect(sent()).toContainEqual({ type: 'page:leaving', paperKey: PAPER_KEY });
  });

  // A page script can dispatch these itself; only the browser's own events may end the user's check.
  test('a pagehide or pageshow made by a script on the page is ignored', async () => {
    await ask({ type: 'refs:extract' });
    await ask({ type: 'badges:update', paperKey: PAPER_KEY, results: [{ index: 1, status: 'verified', reason: 'a' }] });
    await flushed();
    for (const type of ['pagehide', 'pageshow']) {
      const event = new win.Event(type);
      Object.defineProperty(event, 'persisted', { value: true });
      expect((event as unknown as { isTrusted?: boolean }).isTrusted).toBeFalsy();
      win.dispatchEvent(event);
    }
    expect(sent()).toEqual([]);
    expect(hosts()).toHaveLength(1);
  });
});

// The back/forward cache keeps the whole page, badges included, and brings it back untouched: the
// verdicts on it may be stale by then, and the background has forgotten the run.
describe('back/forward cache', () => {
  const pageEvent = (type: 'pagehide' | 'pageshow', persisted: boolean) => {
    const event = new win.Event(type);
    Object.defineProperty(event, 'persisted', { value: persisted });
    Object.defineProperty(event, 'isTrusted', { value: true });
    win.dispatchEvent(event);
  };

  async function withBadges(): Promise<void> {
    await ask({ type: 'refs:extract' });
    await ask({ type: 'badges:update', paperKey: PAPER_KEY, results: [{ index: 1, status: 'verified', reason: 'a' }] });
    await flushed();
    expect(hosts()).toHaveLength(1);
  }

  test('a page going into the cache loses its badges', async () => {
    await withBadges();
    pageEvent('pagehide', true);
    expect(hosts()).toHaveLength(0);
    expect(sent()).toContainEqual({ type: 'page:leaving', paperKey: PAPER_KEY });
  });

  test('a page that is really going away keeps nothing to clear and still reports leaving', async () => {
    await withBadges();
    pageEvent('pagehide', false);
    expect(sent()).toContainEqual({ type: 'page:leaving', paperKey: PAPER_KEY });
    expect(hosts()).toHaveLength(1);
  });

  test('a page restored from the cache announces itself again, with the key from its address', async () => {
    pageEvent('pageshow', true);
    // (Earlier tests ran the script more than once on this window, so there may be several listeners.)
    expect(sent()).toContainEqual({ type: 'content:ready', paperKey: PAPER_KEY });
    expect(sent().every((m) => JSON.stringify(m) === JSON.stringify({ type: 'content:ready', paperKey: PAPER_KEY }))).toBe(true);
  });

  test('an ordinary page show announces nothing (the load already did)', () => {
    pageEvent('pageshow', false);
    expect(sent()).toEqual([]);
  });
});

describe('a page that is not an arXiv HTML paper', () => {
  test('does nothing: no listener, no messages', async () => {
    const other = new Window({ url: 'https://arxiv.org/abs/1706.03762' });
    const otherDoc = atAddress(new other.DOMParser().parseFromString('<html><body></body></html>', 'text/html') as unknown as Document, 'https://arxiv.org/abs/1706.03762');
    vi.stubGlobal('document', otherDoc);
    vi.stubGlobal('window', other);
    const before = registered.length;
    sendMessage.mockClear();
    content.main();
    expect(registered).toHaveLength(before);
    expect(sendMessage).not.toHaveBeenCalled();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
  });
});
