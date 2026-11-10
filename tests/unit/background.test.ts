import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The browser: storage is the WXT fake; the rest of what the background touches (ports, toolbar,
// side panel, tabs) is a small hand-written stand-in, since the fake does not implement those.
const mock = vi.hoisted(() => {
  type Listener = (...args: never[]) => unknown;
  const emitter = () => {
    const listeners: Listener[] = [];
    return {
      listeners,
      addListener: (listener: Listener) => void listeners.push(listener),
      removeListener: (listener: Listener) => void listeners.splice(listeners.indexOf(listener), 1),
      fire: (...args: unknown[]) => listeners.map((listener) => (listener as (...a: unknown[]) => unknown)(...args)),
    };
  };
  return {
    emitter,
    onMessage: emitter(),
    onConnect: emitter(),
    onClicked: emitter(),
    onRemoved: emitter(),
    onUpdated: emitter(),
    getPlatformInfo: vi.fn(),
    tabsGet: vi.fn(),
    tabsSendMessage: vi.fn(),
    sidePanelOpen: vi.fn(),
    sidebarOpen: vi.fn(),
    setAccessLevel: vi.fn(),
    browser: {} as Record<string, unknown>,
  };
});

vi.mock('wxt/browser', async () => {
  const { fakeBrowser } = await import('wxt/testing/fake-browser');
  Object.assign(mock.browser, {
    storage: fakeBrowser.storage,
    runtime: { id: 'ext-id', getURL: (path: string) => `chrome-extension://ext-id${path}`, onMessage: mock.onMessage, onConnect: mock.onConnect, getPlatformInfo: mock.getPlatformInfo },
    tabs: { get: mock.tabsGet, sendMessage: mock.tabsSendMessage, onRemoved: mock.onRemoved, onUpdated: mock.onUpdated },
    action: { onClicked: mock.onClicked },
    sidePanel: { open: mock.sidePanelOpen },
  });
  return { browser: mock.browser };
});

vi.mock('../../src/engine/checker', () => ({ runCheck: vi.fn() }));
vi.mock('../../src/engine/history', () => ({
  getHistoryEpoch: vi.fn(),
  saveSummary: vi.fn(),
  getLast: vi.fn(),
  clearHistory: vi.fn(),
}));
vi.mock('../../src/extract/parseHost', () => ({ parseInHost: vi.fn() }));
vi.mock('../../src/sources/arxiv', () => ({ arxiv: { search: vi.fn() } }));
vi.mock('../../src/sources/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/sources/http')>()),
  fetchText: vi.fn(),
  fetchBytes: vi.fn(),
}));

import { fakeBrowser } from 'wxt/testing/fake-browser';
import { startBackground } from '../../src/background/hub';
import { toJson, toPlainTextReport } from '../../src/core/report';
import type { CheckErrorCode } from '../../src/messaging';
import { bannerFor } from '../../src/ui/banner';
import type { CheckResult, CheckSummary, PaperInfo, RawReference, WorkRecord } from '../../src/core/types';
import { runCheck } from '../../src/engine/checker';
import { clearHistory, getHistoryEpoch, getLast, saveSummary } from '../../src/engine/history';
import { SETTINGS_KEY } from '../../src/engine/settings';
import { parseInHost } from '../../src/extract/parseHost';
import { arxiv } from '../../src/sources/arxiv';
import { fetchBytes, fetchText, SourceError } from '../../src/sources/http';
import { openalex } from '../../src/sources/openalex';

const runCheckMock = vi.mocked(runCheck);
const fetchTextMock = vi.mocked(fetchText);
const fetchBytesMock = vi.mocked(fetchBytes);
const parseMock = vi.mocked(parseInHost);
const searchMock = vi.mocked(arxiv.search);
const saveMock = vi.mocked(saveSummary);
const epochMock = vi.mocked(getHistoryEpoch);
const clearMock = vi.mocked(clearHistory);
const lastMock = vi.mocked(getLast);
const globalFetch = vi.fn();

// ---------------------------------------------------------------------------- fixtures

type Sender = Record<string, unknown>;
const PANEL: Sender = { id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' };
const contentSender = (tabId: number, url: string, frameId = 0): Sender => ({ id: 'ext-id', frameId, url, tab: { id: tabId, url } });

const ABS_URL = 'https://arxiv.org/abs/1706.03762';
const HTML_URL = 'https://arxiv.org/html/1706.03762v7';
const PDF_URL = 'https://arxiv.org/pdf/1706.03762v7';
const FORUM_URL = 'https://openreview.net/forum?id=abc123XYZ';
const TITLE = 'Attention Is All You Need';

const refs: RawReference[] = [
  { index: 1, label: '[1]', text: 'First reference.' },
  { index: 2, label: '[2]', text: 'Second reference.' },
  { index: 3, label: '[3]', text: 'Third reference.' },
];

function checkResult(index: number): CheckResult {
  return {
    index,
    label: `[${index}]`,
    citedText: `Reference ${index}.`,
    status: 'verified',
    reason: 'Matched in Crossref',
    diffs: [],
    notes: [],
    sourcesSearched: ['crossref'],
    sourcesFailed: [],
    links: [],
  };
}

function summaryFor(paper: PaperInfo, total: number): CheckSummary {
  return { paper, counts: { verified: total, details_differ: 0, wrong_id: 0, retracted: 0, not_found: 0, cant_check: 0 }, total, startedAt: 1, finishedAt: 2, beta: paper.viaPdf };
}

function arxivRecord(title: string, arxivId: string): WorkRecord {
  return { source: 'arxiv', title, authors: ['vaswani'], year: 2017, arxivId, isRetracted: false, notes: [] };
}

const tabs = new Map<number, { id: number; url?: string; title?: string }>();
const contentScripts = new Map<number, (message: Record<string, unknown>) => unknown>();
const sentToTabs: { tabId: number; message: Record<string, unknown> }[] = [];

function openTab(id: number, url: string, title = TITLE): void {
  tabs.set(id, { id, url, title });
}
/** Installs a content script in the tab that answers each message by `type` (or not at all). */
function contentScript(tabId: number, answers: Record<string, unknown>): void {
  contentScripts.set(tabId, (message) => answers[String(message['type'])]);
}


function connectPanel(sender: Sender = PANEL, name = 'refsure-panel') {
  const events: Record<string, unknown>[] = [];
  const port = {
    name,
    sender,
    postMessage: vi.fn((event: Record<string, unknown>) => void events.push(event)),
    disconnect: vi.fn(),
    onDisconnect: mock.emitter(),
    onMessage: mock.emitter(),
  };
  mock.onConnect.fire(port);
  return { port, events };
}

function send(message: unknown, sender: Sender = PANEL): Promise<{ handled: boolean; reply?: unknown }> {
  return new Promise((resolve) => {
    let handled = false;
    for (const listener of mock.onMessage.listeners) {
      if ((listener as (...a: unknown[]) => unknown)(message, sender, (reply: unknown) => resolve({ handled: true, reply })) === true) handled = true;
    }
    if (!handled) resolve({ handled: false });
  });
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const types = (events: Record<string, unknown>[]): unknown[] => events.map((e) => e['type']);
const byType = (events: Record<string, unknown>[], type: string) => events.filter((e) => e['type'] === type);

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: patch });
}

function expectNothingSent(): void {
  expect(fetchTextMock).not.toHaveBeenCalled();
  expect(fetchBytesMock).not.toHaveBeenCalled();
  expect(searchMock).not.toHaveBeenCalled();
  expect(parseMock).not.toHaveBeenCalled();
  expect(runCheckMock).not.toHaveBeenCalled();
  expect(globalFetch).not.toHaveBeenCalled();
}

/** A run that stays open until the test resolves it; rejects with the abort reason on abort, like the real engine. */
function controlledRun() {
  const control: { input?: Parameters<typeof runCheck>[0]; resolve?: (summary: CheckSummary) => void } = {};
  runCheckMock.mockImplementation(
    (input) =>
      new Promise<CheckSummary>((resolve, reject) => {
        control.input = input;
        control.resolve = resolve;
        input.signal.addEventListener('abort', () => reject(input.signal.reason as Error), { once: true });
      }),
  );
  return control;
}

beforeEach(() => {
  fakeBrowser.reset();
  // The fake has no storage access levels (Chrome and Edge do): a stand-in that records the call.
  Object.assign(fakeBrowser.storage.local, { setAccessLevel: mock.setAccessLevel });
  for (const e of [mock.onMessage, mock.onConnect, mock.onClicked, mock.onRemoved, mock.onUpdated]) e.listeners.length = 0;
  tabs.clear();
  contentScripts.clear();
  sentToTabs.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal('fetch', globalFetch);
  mock.browser['sidePanel'] = { open: mock.sidePanelOpen };
  delete mock.browser['sidebarAction'];
  mock.sidePanelOpen.mockResolvedValue(undefined);
  mock.setAccessLevel.mockResolvedValue(undefined);
  mock.getPlatformInfo.mockResolvedValue({ os: 'mac' });
  mock.tabsGet.mockImplementation((id: number) => {
    const tab = tabs.get(id);
    return tab === undefined ? Promise.reject(new Error('No tab')) : Promise.resolve(tab);
  });
  mock.tabsSendMessage.mockImplementation((tabId: number, message: Record<string, unknown>) => {
    sentToTabs.push({ tabId, message });
    const script = contentScripts.get(tabId);
    return script === undefined ? Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')) : Promise.resolve(script(message));
  });
  runCheckMock.mockImplementation(({ paper, refs: given, onResult }) => {
    for (const r of given) onResult(checkResult(r.index));
    return Promise.resolve(summaryFor(paper, given.length));
  });
  fetchTextMock.mockResolvedValue('<html>paper</html>');
  fetchBytesMock.mockResolvedValue(new ArrayBuffer(8));
  parseMock.mockResolvedValue({ refs, confidence: 1 });
  searchMock.mockResolvedValue([]);
  saveMock.mockResolvedValue(undefined);
  epochMock.mockReturnValue(0);
  clearMock.mockResolvedValue(undefined);
  lastMock.mockResolvedValue(undefined);
  startBackground();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------- toolbar

describe('toolbar click', () => {
  test('opens the side panel synchronously inside the click, then checks the page', async () => {
    openTab(1, ABS_URL);
    const panel = connectPanel();
    mock.onClicked.fire(tabs.get(1));
    // Before any await: the user-gesture requirement.
    expect(mock.sidePanelOpen).toHaveBeenCalledWith({ tabId: 1 });
    await settle();
    expect(types(panel.events)).toEqual(['check:started', 'check:result', 'check:result', 'check:result', 'check:done']);
  });

  test('Firefox: opens the sidebar in the click instead', async () => {
    delete mock.browser['sidePanel'];
    mock.browser['sidebarAction'] = { open: mock.sidebarOpen };
    openTab(1, ABS_URL);
    mock.onClicked.fire(tabs.get(1));
    expect(mock.sidebarOpen).toHaveBeenCalledTimes(1);
    expect(mock.sidePanelOpen).not.toHaveBeenCalled();
    await settle();
    expect(runCheckMock).toHaveBeenCalled();
  });

  test('a panel that opens late still sees the whole check (events are replayed)', async () => {
    openTab(1, ABS_URL);
    mock.onClicked.fire(tabs.get(1));
    await settle();
    const late = connectPanel();
    expect(types(late.events)).toEqual(['check:started', 'check:result', 'check:result', 'check:result', 'check:done']);
    // Every event of a new port's initial replay says so; the panel must not announce them as news.
    for (const event of late.events) expect(event['replayed'], String(event['type'])).toBe(true);
  });

  test('live events never carry the replayed flag, even while an older run is replayed to a late panel', async () => {
    openTab(1, ABS_URL);
    const early = connectPanel();
    mock.onClicked.fire(tabs.get(1));
    await settle();
    expect(early.events.length).toBeGreaterThan(0);
    for (const event of early.events) expect('replayed' in event, String(event['type'])).toBe(false);
    // The replay copies are marked; the stored events are not changed, so a third panel and a live port see the same.
    const late = connectPanel();
    for (const event of late.events) expect(event['replayed']).toBe(true);
    for (const event of early.events) expect('replayed' in event).toBe(false);
  });

  describe('a second click', () => {
    test('while the paper is being checked, only shows the panel: the run is not restarted', async () => {
      const control = controlledRun();
      openTab(1, ABS_URL);
      const panel = connectPanel();
      mock.onClicked.fire(tabs.get(1));
      await settle();
      const first = control.input;
      mock.sidePanelOpen.mockClear();
      mock.onClicked.fire(tabs.get(1));
      await settle();
      expect(mock.sidePanelOpen).toHaveBeenCalledWith({ tabId: 1 });
      expect(runCheckMock).toHaveBeenCalledTimes(1);
      expect(first?.signal.aborted).toBe(false);
      expect(byType(panel.events, 'check:started')).toHaveLength(1);
    });

    test('after the paper was checked, shows the panel and keeps the badges', async () => {
      openTab(5, HTML_URL);
      contentScript(5, { 'refs:extract': { refs, title: TITLE } });
      mock.onClicked.fire(tabs.get(5));
      await settle();
      expect(runCheckMock).toHaveBeenCalledTimes(1);
      sentToTabs.length = 0;
      mock.onClicked.fire(tabs.get(5));
      await settle();
      expect(runCheckMock).toHaveBeenCalledTimes(1);
      expect(sentToTabs.map((m) => m.message['type'])).not.toContain('badges:clear');
    });

    test('on another paper in the same tab, starts a check for it', async () => {
      openTab(1, ABS_URL);
      mock.onClicked.fire(tabs.get(1));
      await settle();
      openTab(1, 'https://arxiv.org/abs/2106.09685');
      mock.onClicked.fire(tabs.get(1));
      await settle();
      expect(runCheckMock).toHaveBeenCalledTimes(2);
    });

    // A run read from the abstract page or the PDF has no badges; the HTML page of the same paper does.
    test.each([
      ['abstract page', ABS_URL],
      ['PDF', PDF_URL],
    ])('a run from the %s, then the HTML page of the same paper in the same tab: the click starts a check that draws badges', async (_name, firstUrl) => {
      openTab(5, firstUrl);
      mock.onClicked.fire(tabs.get(5));
      await settle();
      expect(runCheckMock).toHaveBeenCalledTimes(1);
      expect(sentToTabs.map((m) => m.message['type'])).not.toContain('badges:update');
      // arXiv's own "HTML (experimental)" link opens in the same tab.
      openTab(5, HTML_URL);
      contentScript(5, { 'refs:extract': { refs, title: TITLE } });
      mock.onClicked.fire(tabs.get(5));
      await settle();
      expect(runCheckMock).toHaveBeenCalledTimes(2);
      expect(sentToTabs.filter((m) => m.message['type'] === 'badges:update')).toHaveLength(3);
      // From then on the run has badges, so another click leaves it alone.
      mock.onClicked.fire(tabs.get(5));
      await settle();
      expect(runCheckMock).toHaveBeenCalledTimes(2);
    });

    test('a run still reading the HTML page is not restarted by a click', async () => {
      const control = controlledRun();
      openTab(5, HTML_URL);
      contentScript(5, { 'refs:extract': { refs, title: TITLE } });
      mock.onClicked.fire(tabs.get(5));
      await settle();
      mock.onClicked.fire(tabs.get(5));
      await settle();
      expect(runCheckMock).toHaveBeenCalledTimes(1);
      expect(control.input?.signal.aborted).toBe(false);
    });

    test('after a failed run for the same paper, shows the panel (its Try again is the way to retry)', async () => {
      runCheckMock.mockRejectedValue(new SourceError('offline', 'crossref', 'offline'));
      openTab(1, ABS_URL);
      const panel = connectPanel();
      mock.onClicked.fire(tabs.get(1));
      await settle();
      mock.onClicked.fire(tabs.get(1));
      await settle();
      expect(runCheckMock).toHaveBeenCalledTimes(1);
      expect(byType(panel.events, 'check:error')).toHaveLength(1);
    });
  });

  test('an unsupported page gets a calm error and nothing is fetched', async () => {
    openTab(1, 'https://example.com/paper');
    const panel = connectPanel();
    mock.onClicked.fire(tabs.get(1));
    await settle();
    expect(panel.events).toHaveLength(1);
    expect(panel.events[0]).toMatchObject({ type: 'check:error', tabId: 1, code: 'unsupported' });
    expectNothingSent();
  });

  test('a page whose address the browser does not show is unsupported too', async () => {
    tabs.set(1, { id: 1 });
    const panel = connectPanel();
    mock.onClicked.fire(tabs.get(1));
    await settle();
    expect(panel.events[0]).toMatchObject({ code: 'unsupported' });
  });

  test('a failure to open the panel does not stop the check', async () => {
    mock.sidePanelOpen.mockRejectedValue(new Error('no gesture'));
    openTab(1, ABS_URL);
    mock.onClicked.fire(tabs.get(1));
    await settle();
    expect(runCheckMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------- arXiv

describe('arXiv abstract page', () => {
  test('reads the HTML version, checks it and reports progress', async () => {
    openTab(1, ABS_URL, '[1706.03762] Attention Is All You Need');
    const panel = connectPanel();
    expect((await send({ type: 'check:start', tabId: 1 })).reply).toEqual({ ok: true });
    await settle();
    expect(fetchTextMock).toHaveBeenCalledWith('https://arxiv.org/html/1706.03762', expect.objectContaining({ source: 'page', kind: 'html' }));
    expect(parseMock).toHaveBeenCalledWith({ kind: 'arxiv-html-text', html: '<html>paper</html>' });
    const paper: PaperInfo = { key: 'arxiv:1706.03762', title: TITLE, url: ABS_URL, origin: 'arxiv-abs', viaPdf: false };
    expect(runCheckMock.mock.calls[0]?.[0]).toMatchObject({ paper, refs });
    expect(panel.events[0]).toEqual({ type: 'check:started', tabId: 1, paper, total: 3 });
    expect(byType(panel.events, 'check:result')).toHaveLength(3);
    expect(byType(panel.events, 'check:result')[0]).toMatchObject({ tabId: 1, paperKey: 'arxiv:1706.03762', result: { index: 1 } });
    expect(panel.events.at(-1)).toMatchObject({ type: 'check:done', tabId: 1, summary: { total: 3 } });
    // No content script on an abstract page, so no badge traffic.
    expect(sentToTabs).toEqual([]);
  });

  test('no HTML version (404) falls back to the PDF and marks the paper as read from a PDF', async () => {
    fetchTextMock.mockRejectedValue(new SourceError('not_found_http', 'page', 'HTTP 404'));
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(fetchBytesMock).toHaveBeenCalledWith('https://arxiv.org/pdf/1706.03762', expect.objectContaining({ source: 'page' }));
    expect(parseMock).toHaveBeenLastCalledWith({ kind: 'pdf', data: expect.any(ArrayBuffer) });
    expect(panel.events[0]).toMatchObject({ type: 'check:started', paper: { origin: 'arxiv-abs', viaPdf: true } });
  });

  test('an HTML version with no bibliography also tries the PDF', async () => {
    parseMock.mockResolvedValueOnce({ refs: [], confidence: 0 });
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(fetchBytesMock).toHaveBeenCalled();
    expect(panel.events[0]).toMatchObject({ type: 'check:started', paper: { viaPdf: true } });
  });

  test('no references anywhere is reported, and nothing is checked', async () => {
    parseMock.mockResolvedValue({ refs: [], confidence: 0 });
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(panel.events).toHaveLength(1);
    expect(panel.events[0]).toMatchObject({ type: 'check:error', code: 'no-references' });
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  test('offline is reported as offline, other fetch failures as fetch-failed', async () => {
    fetchTextMock.mockRejectedValue(new SourceError('offline', 'page', 'offline'));
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(panel.events[0]).toMatchObject({ type: 'check:error', code: 'offline' });

    fetchTextMock.mockRejectedValue(new SourceError('timeout', 'page', 'timeout'));
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(panel.events.at(-1)).toMatchObject({ type: 'check:error', code: 'fetch-failed', message: "RefSure couldn't read this paper's references." });

    parseMock.mockRejectedValue(new Error('boom with https://secret.example/?key=abc'));
    fetchTextMock.mockResolvedValue('x');
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    const last = panel.events.at(-1);
    expect(last).toMatchObject({ type: 'check:error', code: 'fetch-failed' });
    // An unexpected error's own text is never passed on.
    expect(JSON.stringify(last)).not.toContain('secret.example');
  });
});

describe('arXiv HTML page', () => {
  test('asks the content script for the references, with no fetch, and pushes badges', async () => {
    openTab(5, HTML_URL);
    contentScript(5, { 'refs:extract': { refs, title: TITLE } });
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 5 });
    await settle();
    expect(sentToTabs[0]).toEqual({ tabId: 5, message: { type: 'refs:extract' } });
    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
    expect(runCheckMock.mock.calls[0]?.[0]).toMatchObject({ paper: { key: 'arxiv:1706.03762', origin: 'arxiv-html', viaPdf: false, title: TITLE }, refs });
    const badges = sentToTabs.filter((s) => s.message['type'] === 'badges:update');
    expect(badges).toHaveLength(3);
    // Only index, status and reason go to the page.
    expect(badges[0]?.message).toEqual({ type: 'badges:update', paperKey: 'arxiv:1706.03762', results: [{ index: 1, status: 'verified', reason: 'Matched in Crossref' }] });
    expect(types(panel.events).at(-1)).toBe('check:done');
  });

  test('a page without the content script (opened before install) is read from its HTML instead', async () => {
    openTab(5, HTML_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 5 });
    await settle();
    expect(fetchTextMock).toHaveBeenCalledWith('https://arxiv.org/html/1706.03762v7', expect.anything());
    expect(panel.events[0]).toMatchObject({ type: 'check:started', paper: { origin: 'arxiv-html' } });
    expect(sentToTabs.filter((s) => s.message['type'] === 'badges:update')).toEqual([]);
  });

  test('a content script that never answers is given up on', async () => {
    vi.useFakeTimers();
    openTab(5, HTML_URL);
    contentScripts.set(5, () => new Promise(() => undefined));
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 5 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchTextMock).toHaveBeenCalled();
    expect(types(panel.events)).toContain('check:started');
  });

  test('an empty or malformed reply is not trusted', async () => {
    openTab(5, HTML_URL);
    contentScript(5, { 'refs:extract': { refs: 'lots' } });
    connectPanel();
    await send({ type: 'check:start', tabId: 5 });
    await settle();
    // Fell back to the page's HTML rather than using the bad reply.
    expect(fetchTextMock).toHaveBeenCalled();
  });

  test('a content script that finds no references is reported as such', async () => {
    openTab(5, HTML_URL);
    contentScript(5, { 'refs:extract': { refs: [] } });
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 5 });
    await settle();
    expect(panel.events[0]).toMatchObject({ type: 'check:error', code: 'no-references' });
    expect(fetchTextMock).not.toHaveBeenCalled();
  });
});

describe('arXiv PDF page', () => {
  test('downloads and reads the PDF', async () => {
    openTab(7, PDF_URL, 'https://arxiv.org/pdf/1706.03762v7');
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 7 });
    await settle();
    expect(fetchBytesMock).toHaveBeenCalledWith('https://arxiv.org/pdf/1706.03762v7', expect.objectContaining({ source: 'page' }));
    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(panel.events[0]).toMatchObject({ type: 'check:started', paper: { key: 'arxiv:1706.03762', origin: 'arxiv-pdf', viaPdf: true, title: 'arXiv:1706.03762v7' } });
  });
});

// ---------------------------------------------------------------------------- OpenReview

describe('OpenReview', () => {
  const forumTab = (): void => openTab(9, FORUM_URL, 'Attention Is All You Need | OpenReview');

  test('a confidential submission is not checked, and nothing is sent anywhere', async () => {
    forumTab();
    contentScript(9, { 'openreview:read': { visibility: 'confidential', forumId: 'abc123XYZ' } });
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    expect(panel.events).toHaveLength(1);
    expect(panel.events[0]).toMatchObject({ type: 'check:error', tabId: 9, code: 'confidential' });
    expectNothingSent();
  });

  test('an unclear visibility is not checked either, and its message says so plainly', async () => {
    forumTab();
    contentScript(9, { 'openreview:read': { visibility: 'unclear', forumId: 'abc123XYZ' } });
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    expect(panel.events[0]).toMatchObject({ type: 'check:error', code: 'visibility-unclear' });
    // The panel words the notice from the code alone.
    expect(bannerFor('visibility-unclear').text).toMatch(/couldn't confirm.*public/i);
    expectNothingSent();
  });

  test.each([
    ['no title', { visibility: 'public', forumId: 'abc123XYZ' }],
    ['a blank title', { visibility: 'public', title: '  \n ', forumId: 'abc123XYZ' }],
    ['only the site name', { visibility: 'public', title: ' | OpenReview', forumId: 'abc123XYZ' }],
  ])('a public paper with %s says the title could not be read, not that there is no arXiv version', async (_name, answer) => {
    forumTab();
    contentScript(9, { 'openreview:read': answer });
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    expect(panel.events).toHaveLength(1);
    const error = panel.events[0] as { code: CheckErrorCode; message: string };
    expect(error).toMatchObject({ type: 'check:error', code: 'fetch-failed' });
    expect(bannerFor(error.code, error.message).text).toBe("RefSure couldn't read this paper's title, so it couldn't look for its arXiv version.");
    expectNothingSent();
  });

  test.each([
    ['no content script', undefined],
    ['a malformed reply', { visibility: 'sure' }],
    ['a reply about a different forum', { visibility: 'public', title: TITLE, forumId: 'someoneElse' }],
  ])('fails closed on %s', async (_name, answer) => {
    vi.useFakeTimers(); // a missing script is retried once after a short wait
    forumTab();
    if (answer !== undefined) contentScript(9, { 'openreview:read': answer });
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(panel.events[0]).toMatchObject({ type: 'check:error', code: 'visibility-unclear' });
    expectNothingSent();
  });

  test('a public paper with no arXiv version is not checked', async () => {
    forumTab();
    contentScript(9, { 'openreview:read': { visibility: 'public', title: 'A Completely Different Paper About Soil', forumId: 'abc123XYZ' } });
    searchMock.mockResolvedValue([arxivRecord(TITLE, '1706.03762')]);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(panel.events).toHaveLength(1);
    expect(panel.events[0]).toMatchObject({ type: 'check:error', code: 'no-arxiv-version' });
    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(fetchBytesMock).not.toHaveBeenCalled();
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  test('a title shared by two different arXiv papers is ambiguous: no version is picked', async () => {
    forumTab();
    contentScript(9, { 'openreview:read': { visibility: 'public', title: TITLE, forumId: 'abc123XYZ' } });
    searchMock.mockResolvedValue([arxivRecord(TITLE, '1706.03762'), arxivRecord(TITLE, '2001.00001')]);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    expect(panel.events).toHaveLength(1);
    expect(panel.events[0]).toMatchObject({ type: 'check:error', code: 'no-arxiv-version' });
    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(fetchBytesMock).not.toHaveBeenCalled();
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  test('the same arXiv paper listed twice is still one paper', async () => {
    forumTab();
    contentScript(9, { 'openreview:read': { visibility: 'public', title: TITLE, forumId: 'abc123XYZ' } });
    searchMock.mockResolvedValue([arxivRecord(TITLE, '1706.03762'), arxivRecord(TITLE, '1706.03762v5')]);
    connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    expect(runCheckMock).toHaveBeenCalled();
  });

  test('a public paper with a matching arXiv version is checked through it', async () => {
    forumTab();
    contentScript(9, { 'openreview:read': { visibility: 'public', title: TITLE, forumId: 'abc123XYZ' } });
    searchMock.mockResolvedValue([arxivRecord('Something Unrelated About Birds', '2001.00001'), arxivRecord(TITLE, '1706.03762')]);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    // Only the title of a paper the page shows as public is searched for.
    expect(searchMock.mock.calls[0]?.[0]).toMatchObject({ title: TITLE });
    expect(fetchTextMock).toHaveBeenCalledWith('https://arxiv.org/html/1706.03762', expect.anything());
    const paper: PaperInfo = { key: 'openreview:abc123XYZ', title: TITLE, url: FORUM_URL, origin: 'openreview', viaPdf: false, viaArxivVersion: '1706.03762' };
    expect(runCheckMock.mock.calls[0]?.[0]).toMatchObject({ paper, refs });
    expect(panel.events[0]).toEqual({ type: 'check:started', tabId: 9, paper, total: 3 });
    // No badges: the OpenReview page has no inline badge support.
    expect(sentToTabs.filter((s) => s.message['type'] === 'badges:update')).toEqual([]);
  });

  test('the arXiv version read from its PDF is marked viaPdf', async () => {
    forumTab();
    contentScript(9, { 'openreview:read': { visibility: 'public', title: TITLE, forumId: 'abc123XYZ' } });
    searchMock.mockResolvedValue([arxivRecord(TITLE, '1706.03762')]);
    fetchTextMock.mockRejectedValue(new SourceError('not_found_http', 'page', 'HTTP 404'));
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    expect(panel.events[0]).toMatchObject({ paper: { origin: 'openreview', viaPdf: true, viaArxivVersion: '1706.03762' } });
  });

  test('an arXiv search that fails offline is reported as offline', async () => {
    forumTab();
    contentScript(9, { 'openreview:read': { visibility: 'public', title: TITLE, forumId: 'abc123XYZ' } });
    searchMock.mockRejectedValue(new SourceError('offline', 'arxiv', 'offline'));
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    expect(panel.events[0]).toMatchObject({ code: 'offline' });
  });

  test('the PDF viewer address cannot host the reader: the user is told to open the forum page, with no fetch', async () => {
    openTab(9, 'https://openreview.net/pdf?id=abc123XYZ');
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await settle();
    expect(panel.events[0]).toMatchObject({ type: 'check:error', code: 'open-forum-page' });
    expect(sentToTabs).toEqual([]);
    expectNothingSent();
  });
});

// ---------------------------------------------------------------------------- the paper's address

describe("the paper's address", () => {
  // What a tab's address may carry beyond the paper: where the reader came from, a comment they opened, tracking.
  const PRIVATE = ['referrer', 'Reviewer', 'Console', 'noteId', 'note-42', 'utm_', 'context=', '#discussion', '#S', '#page'];

  /** The paper as the panel, history, Copy report and JSON export receive it. */
  async function everywhere(panel: { events: Record<string, unknown>[] }): Promise<string[]> {
    await settle();
    const started = panel.events[0] as { paper: PaperInfo };
    const [summary, results] = saveMock.mock.calls[0] ?? [];
    expect(summary).toBeDefined();
    const saved = summary as CheckSummary;
    return [
      JSON.stringify(started.paper),
      JSON.stringify(saved.paper),
      toPlainTextReport(saved, results as CheckResult[]),
      toJson(saved, results as CheckResult[]),
    ];
  }

  test('an OpenReview forum opened from a venue console keeps only the forum id', async () => {
    openTab(9, 'https://openreview.net/forum?id=abc123XYZ&referrer=%5BReviewer%20Console%5D(%2Fgroup%3Fid%3DVenue%2FReviewers)&noteId=note-42#discussion', 'Attention Is All You Need | OpenReview');
    contentScript(9, { 'openreview:read': { visibility: 'public', title: TITLE, forumId: 'abc123XYZ' } });
    searchMock.mockResolvedValue([arxivRecord(TITLE, '1706.03762')]);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    for (const text of await everywhere(panel)) {
      expect(text).toContain(FORUM_URL);
      for (const word of PRIVATE) expect(text, word).not.toContain(word);
    }
    expect((panel.events[0] as { paper: PaperInfo }).paper.url).toBe(FORUM_URL);
  });

  test.each([
    ['abstract', 'https://arxiv.org/abs/1706.03762v7?context=cs.CL&utm_source=feed#S1', 'https://arxiv.org/abs/1706.03762v7'],
    ['HTML', 'https://arxiv.org/html/1706.03762v7/?utm_source=feed#S3', 'https://arxiv.org/html/1706.03762v7'],
    ['PDF', 'https://arxiv.org/pdf/1706.03762v7.pdf?context=cs.CL#page=3', 'https://arxiv.org/pdf/1706.03762v7'],
  ])('an arXiv %s page keeps only the paper id', async (_kind, tabUrl, expected) => {
    openTab(1, tabUrl);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    for (const text of await everywhere(panel)) {
      expect(text).toContain(expected);
      for (const word of PRIVATE) expect(text, word).not.toContain(word);
    }
    expect((panel.events[0] as { paper: PaperInfo }).paper.url).toBe(expected);
  });
});

// ---------------------------------------------------------------------------- history

describe('history', () => {
  test('saves the summary after a run resolves, with the epoch read when it started and results in order', async () => {
    epochMock.mockReturnValueOnce(7).mockReturnValue(8);
    runCheckMock.mockImplementation(({ paper, refs: given, onResult }) => {
      for (const r of [...given].reverse()) onResult(checkResult(r.index));
      return Promise.resolve(summaryFor(paper, given.length));
    });
    openTab(1, ABS_URL);
    connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(saveMock).toHaveBeenCalledTimes(1);
    const [summary, results, epoch] = saveMock.mock.calls[0] ?? [];
    expect(summary).toMatchObject({ total: 3 });
    expect((results as CheckResult[]).map((r) => r.index)).toEqual([1, 2, 3]);
    expect(epoch).toBe(7);
  });

  test('is called only after runCheck resolves', async () => {
    const control = controlledRun();
    openTab(1, ABS_URL);
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(runCheckMock).toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    const { paper } = control.input as { paper: PaperInfo };
    control.resolve?.(summaryFor(paper, 3));
    await settle();
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  test('is never called after an abort or an error, or when history is off', async () => {
    const control = controlledRun();
    openTab(1, ABS_URL);
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    await send({ type: 'check:cancel', tabId: 1 });
    await settle();
    expect(saveMock).not.toHaveBeenCalled();

    runCheckMock.mockRejectedValue(new Error('engine bug'));
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(panel.events.at(-1)).toMatchObject({ type: 'check:error', code: 'fetch-failed' });
    expect(saveMock).not.toHaveBeenCalled();
    expect(control.input).toBeDefined();

    runCheckMock.mockImplementation(({ paper, refs: given }) => Promise.resolve(summaryFor(paper, given.length)));
    await setSettings({ historyEnabled: false });
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(3);
    expect(saveMock).not.toHaveBeenCalled();
  });

  test('history:clear runs clearHistory in the background and answers ok, or the failure', async () => {
    expect(await send({ type: 'history:clear' })).toEqual({ handled: true, reply: { ok: true } });
    expect(clearMock).toHaveBeenCalledTimes(1);
    clearMock.mockRejectedValue(new Error('storage broke'));
    const failed = await send({ type: 'history:clear' });
    expect(failed.reply).toMatchObject({ ok: false });
    expect(JSON.stringify(failed.reply)).not.toContain('storage broke');
  });

  test('panel commands and the panel port are refused from the offscreen document', async () => {
    openTab(1, ABS_URL);
    const offscreen: Sender = { id: 'ext-id', url: 'chrome-extension://ext-id/offscreen.html' };
    for (const message of [{ type: 'check:start', tabId: 1 }, { type: 'check:cancel', tabId: 1 }, { type: 'history:get', paperKey: 'arxiv:1706.03762' }, { type: 'history:clear' }]) {
      expect((await send(message, offscreen)).handled, JSON.stringify(message)).toBe(false);
    }
    await settle();
    expect(runCheckMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
    expect(lastMock).not.toHaveBeenCalled();
    expect(connectPanel(offscreen).port.disconnect).toHaveBeenCalled();
  });

  test('the side panel page is accepted with a query or fragment, other extension pages are not', async () => {
    expect((await send({ type: 'history:clear' }, { id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html?tab=1#x' })).handled).toBe(true);
    for (const url of ['chrome-extension://ext-id/options.html', 'chrome-extension://ext-id/sidepanel.html/../offscreen.html', 'chrome-extension://ext-id/background.js']) {
      expect((await send({ type: 'history:clear' }, { id: 'ext-id', url })).handled, url).toBe(false);
    }
    expect(connectPanel({ id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' }).port.disconnect).not.toHaveBeenCalled();
  });

  test('history:get returns the last saved check, or null', async () => {
    const paper: PaperInfo = { key: 'arxiv:1706.03762', title: TITLE, url: ABS_URL, origin: 'arxiv-abs', viaPdf: false };
    lastMock.mockResolvedValueOnce({ summary: summaryFor(paper, 1), results: [checkResult(1)] });
    const hit = await send({ type: 'history:get', paperKey: 'arxiv:1706.03762' });
    expect(lastMock).toHaveBeenCalledWith('arxiv:1706.03762');
    expect(hit.reply).toMatchObject({ ok: true, saved: { summary: { total: 1 }, results: [{ index: 1 }] } });
    expect((await send({ type: 'history:get', paperKey: 'arxiv:9999.99999' })).reply).toEqual({ ok: true, saved: null });
  });
});

// ---------------------------------------------------------------------------- cancellation

describe('cancellation', () => {
  async function startRun(tabId = 1, url = ABS_URL) {
    const control = controlledRun();
    openTab(tabId, url);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId });
    await settle();
    expect(control.input).toBeDefined();
    return { control, panel, signal: (control.input as { signal: AbortSignal }).signal };
  }

  test('a second check on the same tab aborts the first', async () => {
    const { control, signal } = await startRun();
    const first = control.input;
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(signal.aborted).toBe(true);
    expect(control.input).not.toBe(first);
    expect((control.input as { signal: AbortSignal }).signal.aborted).toBe(false);
  });

  test('results of an aborted run never reach the panel', async () => {
    const { control, panel } = await startRun();
    control.input?.onResult(checkResult(1));
    expect(byType(panel.events, 'check:result')).toHaveLength(1);
    await send({ type: 'check:cancel', tabId: 1 });
    control.input?.onResult(checkResult(2));
    await settle();
    expect(byType(panel.events, 'check:result')).toHaveLength(1);
    expect(types(panel.events)).not.toContain('check:error');
    expect(types(panel.events)).not.toContain('check:done');
  });

  test('Stop ends the run, tells the panel, and keeps the badges already drawn', async () => {
    contentScript(5, { 'refs:extract': { refs, title: TITLE } });
    const { control, panel, signal } = await startRun(5, HTML_URL);
    control.input?.onResult(checkResult(1));
    expect(sentToTabs.map((m) => m.message['type'])).toContain('badges:update');
    sentToTabs.length = 0;
    await send({ type: 'check:cancel', tabId: 5 });
    expect(signal.aborted).toBe(true);
    expect(byType(panel.events, 'check:stopped')).toEqual([{ type: 'check:stopped', tabId: 5, paperKey: 'arxiv:1706.03762', reason: 'user' }]);
    expect(sentToTabs.map((m) => m.message['type'])).not.toContain('badges:clear');
    // A late panel is told the run was stopped rather than left waiting for more.
    const late = connectPanel();
    expect(types(late.events)).toEqual(['check:started', 'check:result', 'check:stopped']);
  });

  test('a run stopped by the user is not started again by a toolbar click, but a new run clears its badges', async () => {
    contentScript(5, { 'refs:extract': { refs, title: TITLE } });
    const { control } = await startRun(5, HTML_URL);
    control.input?.onResult(checkResult(1));
    await send({ type: 'check:cancel', tabId: 5 });
    mock.onClicked.fire(tabs.get(5));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
    sentToTabs.length = 0;
    await send({ type: 'check:start', tabId: 5 });
    await settle();
    expect(sentToTabs.map((m) => m.message['type'])).toContain('badges:clear');
  });

  test('Stop on a run that already ended does nothing', async () => {
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    await send({ type: 'check:cancel', tabId: 1 });
    expect(byType(panel.events, 'check:stopped')).toHaveLength(0);
  });

  test('page:leaving from the page aborts the run', async () => {
    const { control, panel, signal } = await startRun(5, HTML_URL);
    control.input?.onResult(checkResult(1));
    const before = byType(panel.events, 'check:result').length;
    const answer = await send({ type: 'page:leaving', paperKey: 'arxiv:1706.03762' }, contentSender(5, HTML_URL));
    expect(answer.handled).toBe(false);
    expect(signal.aborted).toBe(true);
    control.input?.onResult(checkResult(2));
    await settle();
    expect(byType(panel.events, 'check:result')).toHaveLength(before);
  });

  test('page:leaving for another paper does not abort', async () => {
    const { signal } = await startRun(5, HTML_URL);
    await send({ type: 'page:leaving', paperKey: 'arxiv:2001.00001' }, contentSender(5, HTML_URL));
    expect(signal.aborted).toBe(false);
  });

  test('closing the tab aborts the run', async () => {
    const { signal, control, panel } = await startRun(1);
    mock.onRemoved.fire(1, { windowId: 1, isWindowClosing: false });
    expect(signal.aborted).toBe(true);
    control.input?.onResult(checkResult(1));
    await settle();
    expect(byType(panel.events, 'check:result')).toHaveLength(0);
  });

  test('closing another tab does not', async () => {
    const { signal } = await startRun(1);
    mock.onRemoved.fire(2, { windowId: 1, isWindowClosing: false });
    expect(signal.aborted).toBe(false);
  });

  test('navigating to a different paper aborts; staying on the same paper does not', async () => {
    const { signal } = await startRun(1);
    mock.onUpdated.fire(1, { url: HTML_URL }, tabs.get(1));
    expect(signal.aborted).toBe(false);
    mock.onUpdated.fire(1, { status: 'loading' }, tabs.get(1));
    expect(signal.aborted).toBe(false);
    mock.onUpdated.fire(1, { url: 'https://arxiv.org/abs/2001.00001' }, tabs.get(1));
    expect(signal.aborted).toBe(true);
  });

  test('leaving the allowed sites aborts the run: the browser then shows no address at all, only a loading tab', async () => {
    const { signal, control, panel } = await startRun(1);
    // Without the tabs permission, an address outside the host permissions is withheld from the extension.
    mock.onUpdated.fire(1, { status: 'loading' }, { id: 1 });
    expect(signal.aborted).toBe(true);
    control.input?.onResult(checkResult(1));
    await settle();
    expect(byType(panel.events, 'check:result')).toHaveLength(0);
  });

  test('a tab that is loading an allowed address of another paper aborts; the same paper does not', async () => {
    const { signal } = await startRun(1);
    mock.onUpdated.fire(1, { status: 'loading' }, { id: 1, url: HTML_URL });
    expect(signal.aborted).toBe(false);
    mock.onUpdated.fire(1, { status: 'loading' }, { id: 1, url: 'https://arxiv.org/abs/2001.00001' });
    expect(signal.aborted).toBe(true);
  });

  test('a tab with no run is untouched by loading events', async () => {
    const { signal } = await startRun(1);
    mock.onUpdated.fire(2, { status: 'loading' }, { id: 2 });
    expect(signal.aborted).toBe(false);
  });

  test('after leaving, coming back to the paper can be auto-checked again', async () => {
    await setSettings({ autoCheckArxiv: true });
    openTab(1, ABS_URL);
    mock.onUpdated.fire(1, { status: 'complete' }, tabs.get(1));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
    mock.onUpdated.fire(1, { status: 'complete' }, tabs.get(1));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
    mock.onUpdated.fire(1, { status: 'loading' }, { id: 1 });
    mock.onUpdated.fire(1, { status: 'loading' }, tabs.get(1));
    mock.onUpdated.fire(1, { status: 'complete' }, tabs.get(1));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(2);
  });

  test('a navigation event that carries the address still aborts for a different paper or a non-paper', async () => {
    const { signal } = await startRun(1);
    mock.onUpdated.fire(1, { url: 'https://example.com/' }, tabs.get(1));
    expect(signal.aborted).toBe(true);
  });

  test('runs on different tabs are independent', async () => {
    const control = controlledRun();
    openTab(1, ABS_URL);
    openTab(2, 'https://arxiv.org/abs/2001.00001');
    connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    const first = control.input?.signal;
    await send({ type: 'check:start', tabId: 2 });
    await settle();
    expect(first?.aborted).toBe(false);
    mock.onRemoved.fire(2, { windowId: 1, isWindowClosing: false });
    expect(first?.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------- security

describe('who may talk to the background', () => {
  test('a port with the wrong name is rejected', () => {
    const wrong = connectPanel(PANEL, 'something-else');
    expect(wrong.port.disconnect).toHaveBeenCalled();
    const right = connectPanel();
    expect(right.port.disconnect).not.toHaveBeenCalled();
  });

  test('a port from a web page or another extension is rejected, even with the right name', () => {
    expect(connectPanel(contentSender(5, HTML_URL)).port.disconnect).toHaveBeenCalled();
    expect(connectPanel({ id: 'other-ext', url: 'chrome-extension://other-ext/p.html' }).port.disconnect).toHaveBeenCalled();
    expect(connectPanel({ id: 'ext-id' }).port.disconnect).toHaveBeenCalled();
    const noSender = { name: 'refsure-panel', disconnect: vi.fn(), postMessage: vi.fn(), onDisconnect: mock.emitter(), onMessage: mock.emitter() };
    mock.onConnect.fire(noSender);
    expect(noSender.disconnect).toHaveBeenCalled();
  });

  test('events only go to ports that are still connected', async () => {
    openTab(1, ABS_URL);
    const gone = connectPanel();
    gone.port.onDisconnect.fire();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(gone.port.postMessage).not.toHaveBeenCalled();
  });

  test('panel messages from another extension are ignored', async () => {
    openTab(1, ABS_URL);
    const answer = await send({ type: 'check:start', tabId: 1 }, { id: 'other-ext', url: 'chrome-extension://other-ext/p.html' });
    expect(answer.handled).toBe(false);
    await settle();
    expectNothingSent();
  });

  test('a content script cannot start a check, clear history or read it', async () => {
    openTab(5, HTML_URL);
    for (const message of [{ type: 'check:start', tabId: 5 }, { type: 'history:clear' }, { type: 'history:get', paperKey: 'arxiv:1706.03762' }, { type: 'check:cancel', tabId: 5 }]) {
      expect((await send(message, contentSender(5, HTML_URL))).handled).toBe(false);
    }
    await settle();
    expectNothingSent();
    expect(clearMock).not.toHaveBeenCalled();
    expect(lastMock).not.toHaveBeenCalled();
  });

  test('content messages are accepted only from the arXiv HTML content script in its own tab', async () => {
    await setSettings({ autoCheckArxiv: true });
    openTab(5, HTML_URL);
    contentScript(5, { 'refs:extract': { refs } });
    const ready = { type: 'content:ready', paperKey: 'arxiv:1706.03762' };
    // An abstract page, a sub-frame, the OpenReview forum, an unrelated site, another extension, and a wrong paper key.
    for (const sender of [
      contentSender(5, ABS_URL),
      contentSender(5, HTML_URL, 2),
      contentSender(5, FORUM_URL),
      contentSender(5, 'https://example.com/'),
      { ...contentSender(5, HTML_URL), id: 'other-ext' },
      PANEL,
    ]) {
      await send(ready, sender);
    }
    await send({ type: 'content:ready', paperKey: 'arxiv:2001.00001' }, contentSender(5, HTML_URL));
    await settle();
    expect(runCheckMock).not.toHaveBeenCalled();
    await send(ready, contentSender(5, HTML_URL));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
  });

  test('unknown or malformed messages are dropped without an answer', async () => {
    for (const message of [undefined, null, 'check:start', 3, { type: 'nope' }, { type: 'check:start', tabId: '1' }, { type: 'check:start' }]) {
      expect((await send(message)).handled).toBe(false);
    }
    await settle();
    expectNothingSent();
  });

  test('check:start for a tab that is gone answers with an error and does nothing', async () => {
    expect(await send({ type: 'check:start', tabId: 99 })).toEqual({ handled: true, reply: { ok: false, error: expect.any(String) } });
    await settle();
    expectNothingSent();
  });

  test('a badge click in the page is forwarded to the panel, once validated', async () => {
    const control = controlledRun();
    openTab(5, HTML_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 5 });
    await settle();
    expect(control.input).toBeDefined();
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect(panel.events.at(-1)).toEqual({ type: 'badge:clicked', tabId: 5, index: 4 });
    await send({ type: 'badge:clicked', index: 'x' }, contentSender(5, HTML_URL));
    await send({ type: 'badge:clicked', index: 5 }, PANEL);
    expect(byType(panel.events, 'badge:clicked')).toHaveLength(1);
  });

  test('what the panel is sent carries no settings or key', async () => {
    await setSettings({ openAlexKey: 'sk-secret-key-123456' });
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(JSON.stringify(panel.events)).not.toContain('sk-secret-key-123456');
  });
});

// Chrome and Edge let a click in a content script open the side panel, if sidePanel.open is
// called while the background handles that click's message, before any await. Firefox does not count a click in a web
// page as a user action for sidebarAction.open, so there the row opens only if the panel is already open.
describe('a badge click opens the panel', () => {
  /** The tab shows the arXiv HTML paper with a run that drew badges (still going: the run is the tab's current one). */
  async function runWithBadges(tabId = 5): Promise<void> {
    controlledRun();
    openTab(tabId, HTML_URL);
    contentScript(tabId, { 'refs:extract': { refs } });
    await send({ type: 'check:start', tabId });
    await settle();
    mock.sidePanelOpen.mockClear();
  }

  test('Chrome and Edge: the side panel of that tab is opened synchronously, while the click message is handled', async () => {
    await runWithBadges();
    // Not awaited: the call must already have happened when the listener returns.
    void send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect(mock.sidePanelOpen).toHaveBeenCalledTimes(1);
    expect(mock.sidePanelOpen).toHaveBeenCalledWith({ tabId: 5 });
  });

  // Page CSS can steer a real click onto a badge; the panel opens only for a tab whose run drew badges.
  test('only for a tab whose current run drew badges: not with no run, not for a run from the abstract page', async () => {
    openTab(5, HTML_URL);
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect(mock.sidePanelOpen).not.toHaveBeenCalled();
    controlledRun();
    openTab(6, ABS_URL);
    await send({ type: 'check:start', tabId: 6 });
    await settle();
    openTab(6, HTML_URL); // the same paper's HTML page, in the same tab, with no run of its own yet
    mock.sidePanelOpen.mockClear();
    await send({ type: 'badge:clicked', index: 4 }, contentSender(6, HTML_URL));
    expect(mock.sidePanelOpen).not.toHaveBeenCalled();
  });

  test('a refused open (no gesture, an old browser) is quiet and the click still reaches an open panel', async () => {
    await runWithBadges();
    mock.sidePanelOpen.mockRejectedValue(new Error('sidePanel.open() may only be called in response to a user gesture.'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const panel = connectPanel();
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    await settle();
    expect(panel.events.at(-1)).toEqual({ type: 'badge:clicked', tabId: 5, index: 4 });
    expect(warn).not.toHaveBeenCalled();
  });

  test('Firefox: the sidebar is not asked to open (it would be refused), and an open sidebar still gets the click', async () => {
    delete mock.browser['sidePanel'];
    mock.browser['sidebarAction'] = { open: mock.sidebarOpen };
    await runWithBadges();
    const panel = connectPanel();
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect(mock.sidebarOpen).not.toHaveBeenCalled();
    expect(panel.events.at(-1)).toEqual({ type: 'badge:clicked', tabId: 5, index: 4 });
  });

  test('only the arXiv HTML content script in its own tab can open it', async () => {
    await runWithBadges();
    await send({ type: 'badge:clicked', index: 4 }, PANEL);
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL, 3));
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, ABS_URL));
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, 'https://evil.example/html/1706.03762v7'));
    expect(mock.sidePanelOpen).not.toHaveBeenCalled();
  });

  // A click goes to one panel, once: live to a panel that is open, else to the panel of that tab that asks.
  test('with no panel open, the panel the click opened asks for it by its tab and gets it once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await runWithBadges();
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    vi.advanceTimersByTime(2000);
    const opened = connectPanel();
    expect(byType(opened.events, 'badge:clicked')).toEqual([]);
    expect(await send({ type: 'badge:take', tabId: 5 })).toEqual({ handled: true, reply: { ok: true, badgeIndex: 4 } });
    expect(await send({ type: 'badge:take', tabId: 5 })).toEqual({ handled: true, reply: { ok: true } });
  });

  test('a click older than a few seconds is not handed out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await runWithBadges();
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    vi.advanceTimersByTime(30_000);
    expect(await send({ type: 'badge:take', tabId: 5 })).toEqual({ handled: true, reply: { ok: true } });
  });

  test('a click delivered live to an open panel is not pushed to the next panel that connects', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await runWithBadges();
    const open = connectPanel();
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect(byType(open.events, 'badge:clicked')).toEqual([{ type: 'badge:clicked', tabId: 5, index: 4 }]);
    // The user closes the panel and opens it again three seconds later, or opens one in another window.
    vi.advanceTimersByTime(3000);
    const reopened = connectPanel();
    expect(byType(reopened.events, 'badge:clicked')).toEqual([]);
    // Held for its own tab as well, and taken once.
    expect(await send({ type: 'badge:take', tabId: 5 })).toEqual({ handled: true, reply: { ok: true, badgeIndex: 4 } });
    expect(await send({ type: 'badge:take', tabId: 5 })).toEqual({ handled: true, reply: { ok: true } });
  });

  test('a click in tab 5 is not handed to the panel of tab 6', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await runWithBadges();
    openTab(6, ABS_URL);
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    vi.advanceTimersByTime(500);
    const other = connectPanel();
    expect(byType(other.events, 'badge:clicked')).toEqual([]);
    expect(await send({ type: 'badge:take', tabId: 6 })).toEqual({ handled: true, reply: { ok: true } });
    expect(await send({ type: 'badge:take', tabId: 5 })).toEqual({ handled: true, reply: { ok: true, badgeIndex: 4 } });
  });

  test('only the side panel page may ask', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await runWithBadges();
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect(await send({ type: 'badge:take', tabId: 5 }, contentSender(5, HTML_URL))).toEqual({ handled: false });
    expect(await send({ type: 'badge:take', tabId: 5 }, { id: 'ext-id', url: 'chrome-extension://ext-id/offscreen.html' })).toEqual({ handled: false });
    expect(await send({ type: 'badge:take', tabId: 5 })).toEqual({ handled: true, reply: { ok: true, badgeIndex: 4 } });
  });
});

// ---------------------------------------------------------------------------- auto-check

describe('auto-check', () => {
  test('content:ready on an arXiv HTML page starts a check when the setting is on', async () => {
    await setSettings({ autoCheckArxiv: true });
    openTab(5, HTML_URL);
    contentScript(5, { 'refs:extract': { refs } });
    connectPanel();
    await send({ type: 'content:ready', paperKey: 'arxiv:1706.03762' }, contentSender(5, HTML_URL));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
    expect(mock.sidePanelOpen).not.toHaveBeenCalled();
  });

  test('content:ready on the HTML page of a paper already checked from its abstract page starts a check for the badges', async () => {
    await setSettings({ autoCheckArxiv: true });
    openTab(5, ABS_URL);
    mock.onClicked.fire(tabs.get(5));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
    openTab(5, HTML_URL);
    contentScript(5, { 'refs:extract': { refs } });
    await send({ type: 'content:ready', paperKey: 'arxiv:1706.03762' }, contentSender(5, HTML_URL));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(2);
    // And a reload of the HTML page does not start a third.
    await send({ type: 'content:ready', paperKey: 'arxiv:1706.03762' }, contentSender(5, HTML_URL));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(2);
  });

  test('with auto-check off, the HTML page of a paper already checked from its abstract page waits for a click', async () => {
    openTab(5, ABS_URL);
    mock.onClicked.fire(tabs.get(5));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
    openTab(5, HTML_URL);
    contentScript(5, { 'refs:extract': { refs } });
    await send({ type: 'content:ready', paperKey: 'arxiv:1706.03762' }, contentSender(5, HTML_URL));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
  });

  test('and not when it is off (the default)', async () => {
    openTab(5, HTML_URL);
    contentScript(5, { 'refs:extract': { refs } });
    await send({ type: 'content:ready', paperKey: 'arxiv:1706.03762' }, contentSender(5, HTML_URL));
    await settle();
    expectNothingSent();
  });

  test('a page that finishes loading on an arXiv abstract page starts one only with autoCheckArxiv on', async () => {
    openTab(1, ABS_URL);
    mock.onUpdated.fire(1, { status: 'complete' }, tabs.get(1));
    await settle();
    expect(runCheckMock).not.toHaveBeenCalled();
    await setSettings({ autoCheckArxiv: true });
    mock.onUpdated.fire(1, { status: 'complete' }, tabs.get(1));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
    // The same paper loading again in the same tab is not checked twice.
    mock.onUpdated.fire(1, { status: 'complete' }, tabs.get(1));
    await settle();
    expect(runCheckMock).toHaveBeenCalledTimes(1);
  });

  test('an OpenReview forum page needs autoCheckOpenReview, not autoCheckArxiv', async () => {
    openTab(9, FORUM_URL);
    contentScript(9, { 'openreview:read': { visibility: 'confidential', forumId: 'abc123XYZ' } });
    const panel = connectPanel();
    await setSettings({ autoCheckArxiv: true });
    mock.onUpdated.fire(9, { status: 'complete' }, tabs.get(9));
    await settle();
    expect(panel.events).toEqual([]);
    await setSettings({ autoCheckOpenReview: true });
    mock.onUpdated.fire(9, { status: 'complete' }, tabs.get(9));
    await settle();
    expect(panel.events[0]).toMatchObject({ code: 'confidential' });
  });

  test('other pages are left alone, and an arXiv PDF is never auto-checked', async () => {
    await setSettings({ autoCheckArxiv: true, autoCheckOpenReview: true });
    openTab(1, 'https://example.com/');
    openTab(2, PDF_URL);
    mock.onUpdated.fire(1, { status: 'complete' }, tabs.get(1));
    mock.onUpdated.fire(2, { status: 'complete' }, tabs.get(2));
    await settle();
    expectNothingSent();
  });
});

// ---------------------------------------------------------------------------- keepalive

describe('service worker keepalive', () => {
  test('pings the platform about every 20 s while a run is in progress, and stops when it ends', async () => {
    vi.useFakeTimers();
    const control = controlledRun();
    openTab(1, ABS_URL);
    mock.onClicked.fire(tabs.get(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(control.input).toBeDefined();
    expect(mock.getPlatformInfo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mock.getPlatformInfo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mock.getPlatformInfo).toHaveBeenCalledTimes(2);
    control.resolve?.(summaryFor((control.input as { paper: PaperInfo }).paper, 3));
    await vi.advanceTimersByTimeAsync(0);
    mock.getPlatformInfo.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mock.getPlatformInfo).not.toHaveBeenCalled();
  });

  test('stops when the run is cancelled, when the tab closes, and after an error', async () => {
    vi.useFakeTimers();
    controlledRun();
    openTab(1, ABS_URL);
    mock.onClicked.fire(tabs.get(1));
    await vi.advanceTimersByTimeAsync(0);
    await send({ type: 'check:cancel', tabId: 1 });
    mock.getPlatformInfo.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.getPlatformInfo).not.toHaveBeenCalled();

    // A toolbar click on a stopped paper only shows the panel, so the second run is started the way Re-check does.
    await send({ type: 'check:start', tabId: 1 });
    await vi.advanceTimersByTimeAsync(0);
    mock.onRemoved.fire(1, { windowId: 1, isWindowClosing: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.getPlatformInfo).not.toHaveBeenCalled();

    runCheckMock.mockRejectedValue(new Error('engine bug'));
    mock.onClicked.fire(tabs.get(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.getPlatformInfo).not.toHaveBeenCalled();
  });

  test('one timer serves several runs, and keeps going until the last one ends', async () => {
    vi.useFakeTimers();
    const control = controlledRun();
    openTab(1, ABS_URL);
    openTab(2, 'https://arxiv.org/abs/2001.00001');
    mock.onClicked.fire(tabs.get(1));
    await vi.advanceTimersByTimeAsync(0);
    mock.onClicked.fire(tabs.get(2));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mock.getPlatformInfo).toHaveBeenCalledTimes(1);
    mock.onRemoved.fire(1, { windowId: 1, isWindowClosing: false });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mock.getPlatformInfo).toHaveBeenCalledTimes(2);
    expect(control.input).toBeDefined();
  });

  test('a ping that fails is ignored', async () => {
    vi.useFakeTimers();
    mock.getPlatformInfo.mockRejectedValue(new Error('gone'));
    controlledRun();
    openTab(1, ABS_URL);
    mock.onClicked.fire(tabs.get(1));
    await vi.advanceTimersByTimeAsync(0);
    await expect(vi.advanceTimersByTimeAsync(40_000)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------- error handling details

describe('limits and a run that gives up', () => {
  test('a source that runs out of budget is reported once to the panel, and replayed to a late one', async () => {
    const control = controlledRun();
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    control.input?.onLimited?.('openalex');
    expect(byType(panel.events, 'check:limited')).toEqual([{ type: 'check:limited', tabId: 1, paperKey: 'arxiv:1706.03762', source: 'openalex' }]);
    const late = connectPanel();
    expect(byType(late.events, 'check:limited')).toEqual([{ type: 'check:limited', tabId: 1, paperKey: 'arxiv:1706.03762', source: 'openalex', replayed: true }]);
  });

  test('a source that asked to be left alone until a time is reported with that time, and replayed to a late panel', async () => {
    const control = controlledRun();
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    const until = Date.UTC(2026, 9, 28, 19, 42);
    control.input?.onBlocked?.('crossref', until);
    expect(byType(panel.events, 'check:blocked')).toEqual([{ type: 'check:blocked', tabId: 1, paperKey: 'arxiv:1706.03762', source: 'crossref', until }]);
    const late = connectPanel();
    expect(byType(late.events, 'check:blocked')).toEqual([{ type: 'check:blocked', tabId: 1, paperKey: 'arxiv:1706.03762', source: 'crossref', until, replayed: true }]);
  });

  test('a run that gave up because the services stopped answering ends with check:stopped, not check:done, and is not saved', async () => {
    await setSettings({ historyEnabled: true });
    runCheckMock.mockImplementation(({ paper, refs: given, onResult }) => {
      onResult({ ...checkResult(given[0]?.index ?? 1), status: 'cant_check' });
      return Promise.resolve({ ...summaryFor(paper, given.length), halted: 'services-down' as const });
    });
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(types(panel.events)).toEqual(['check:started', 'check:result', 'check:stopped']);
    expect(byType(panel.events, 'check:stopped')[0]).toMatchObject({ reason: 'services-down', paperKey: 'arxiv:1706.03762' });
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe('check:error messages', () => {
  // Every notice but a failed read is worded by the panel from its code, so no other message is sent.
  test.each([
    ['unsupported', () => openTab(1, 'https://example.org/paper')],
    ['open-forum-page', () => openTab(1, 'https://openreview.net/pdf?id=abc123XYZ')],
    ['confidential', () => {
      openTab(1, FORUM_URL);
      contentScript(1, { 'openreview:read': { visibility: 'confidential', forumId: 'abc123XYZ' } });
    }],
    ['no-arxiv-version', () => {
      openTab(1, FORUM_URL);
      contentScript(1, { 'openreview:read': { visibility: 'public', title: TITLE, forumId: 'abc123XYZ' } });
    }],
    ['no-references', () => {
      openTab(1, ABS_URL);
      parseMock.mockResolvedValue({ refs: [], confidence: 0 });
    }],
    ['offline', () => {
      openTab(1, ABS_URL);
      fetchTextMock.mockRejectedValue(new SourceError('offline', 'page', 'offline'));
    }],
  ])('%s carries its code and no message of its own', async (code, arrange) => {
    arrange();
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(panel.events[0]).toEqual({ type: 'check:error', tabId: 1, code, message: '', ...(code !== 'unsupported' && { paperKey: expect.any(String) }) });
  });
});

describe('check:error details', () => {
  test('carries the paper key whenever it is known', async () => {
    openTab(9, FORUM_URL);
    contentScript(9, { 'openreview:read': { visibility: 'confidential', forumId: 'abc123XYZ' } });
    openTab(1, ABS_URL);
    parseMock.mockResolvedValue({ refs: [], confidence: 0 });
    openTab(2, 'https://example.com/');
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await send({ type: 'check:start', tabId: 1 });
    await send({ type: 'check:start', tabId: 2 });
    await settle();
    const errors = byType(panel.events, 'check:error');
    expect(errors.find((e) => e['tabId'] === 9)).toMatchObject({ code: 'confidential', paperKey: 'openreview:abc123XYZ' });
    expect(errors.find((e) => e['tabId'] === 1)).toMatchObject({ code: 'no-references', paperKey: 'arxiv:1706.03762' });
    expect(errors.find((e) => e['tabId'] === 2)).not.toHaveProperty('paperKey');
  });

  test('a failure after check:done (reading settings to save history) never becomes a check:error', async () => {
    const control = controlledRun();
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage gone'));
    control.resolve?.(summaryFor((control.input as { paper: PaperInfo }).paper, 3));
    await settle();
    expect(types(panel.events)).toContain('check:done');
    expect(types(panel.events)).not.toContain('check:error');
    expect(saveMock).not.toHaveBeenCalled();
  });

  test('a save that fails after check:done is not reported either', async () => {
    saveMock.mockRejectedValue(new Error('quota'));
    openTab(1, ABS_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 1 });
    await settle();
    expect(types(panel.events).at(-1)).toBe('check:done');
    expect(types(panel.events)).not.toContain('check:error');
  });
});

describe('auto-check failures', () => {
  test('a storage failure while deciding on an auto-check is swallowed, not an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    openTab(5, HTML_URL);
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage gone'));
    await send({ type: 'content:ready', paperKey: 'arxiv:1706.03762' }, contentSender(5, HTML_URL));
    mock.onUpdated.fire(1, { status: 'complete' }, { id: 1, url: ABS_URL });
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('OpenReview content script not ready yet', () => {
  const NO_RECEIVER = new Error('Could not establish connection. Receiving end does not exist.');
  const reads = () => sentToTabs.filter((s) => s.message['type'] === 'openreview:read');

  test('one retry after about half a second when the script was not there yet', async () => {
    vi.useFakeTimers();
    openTab(9, FORUM_URL);
    contentScript(9, { 'openreview:read': { visibility: 'confidential', forumId: 'abc123XYZ' } });
    mock.tabsSendMessage.mockImplementationOnce(() => Promise.reject(NO_RECEIVER));
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await vi.advanceTimersByTimeAsync(100);
    expect(panel.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(panel.events[0]).toMatchObject({ code: 'confidential' });
  });

  test('still failing closed when the script never turns up (two tries, then visibility-unclear)', async () => {
    vi.useFakeTimers();
    openTab(9, FORUM_URL);
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads()).toHaveLength(2);
    expect(panel.events[0]).toMatchObject({ code: 'visibility-unclear' });
    expectNothingSent();
  });

  test('no retry for any other failure', async () => {
    vi.useFakeTimers();
    openTab(9, FORUM_URL);
    mock.tabsSendMessage.mockImplementation((tabId: number, message: Record<string, unknown>) => {
      sentToTabs.push({ tabId, message });
      return Promise.reject(new Error('Extension context invalidated.'));
    });
    const panel = connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads()).toHaveLength(1);
    expect(panel.events[0]).toMatchObject({ code: 'visibility-unclear' });
  });

  test('a retry that is aborted by a cancel stops there', async () => {
    vi.useFakeTimers();
    openTab(9, FORUM_URL);
    connectPanel();
    await send({ type: 'check:start', tabId: 9 });
    await vi.advanceTimersByTimeAsync(100);
    await send({ type: 'check:cancel', tabId: 9 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------- replay

describe('replay to a panel that connects late', () => {
  async function finishOn(tabId: number): Promise<void> {
    openTab(tabId, `https://arxiv.org/abs/2001.0000${tabId}`);
    await send({ type: 'check:start', tabId });
    await settle();
  }

  test('gets runs in progress and the most recent finished runs, not every finished run since startup', async () => {
    for (const id of [1, 2, 3, 4, 5]) await finishOn(id);
    const control = controlledRun();
    openTab(6, 'https://arxiv.org/abs/2001.00006');
    await send({ type: 'check:start', tabId: 6 });
    await settle();
    expect(control.input).toBeDefined();
    const late = connectPanel();
    const started = byType(late.events, 'check:started').map((e) => e['tabId']);
    expect(started.sort()).toEqual([3, 4, 5, 6]);
    // Whole runs are replayed, never a run cut in half.
    expect(byType(late.events, 'check:done').map((e) => e['tabId']).sort()).toEqual([3, 4, 5]);
  });

  test('history:clear also empties the replay buffer of finished runs (L4a)', async () => {
    await finishOn(1);
    const before = connectPanel();
    expect(byType(before.events, 'check:done')).toHaveLength(1);
    expect((await send({ type: 'history:clear' })).reply).toEqual({ ok: true });
    const after = connectPanel();
    expect(after.events).toEqual([]);
  });

  test('a failed history:clear leaves the replay buffer alone (L4a)', async () => {
    await finishOn(1);
    clearMock.mockRejectedValue(new Error('storage broke'));
    expect((await send({ type: 'history:clear' })).reply).toMatchObject({ ok: false });
    expect(byType(connectPanel().events, 'check:done')).toHaveLength(1);
  });

  test('history:clear keeps the events of a run still in progress (L4a)', async () => {
    const control = controlledRun();
    openTab(6, 'https://arxiv.org/abs/2001.00006');
    await send({ type: 'check:start', tabId: 6 });
    await settle();
    expect(control.input).toBeDefined();
    await send({ type: 'history:clear' });
    expect(byType(connectPanel().events, 'check:started')).toHaveLength(1);
  });

  test('a pruned run is still known to the hub, so its paper is not auto-checked again', async () => {
    await setSettings({ autoCheckArxiv: true });
    for (const id of [1, 2, 3, 4]) await finishOn(id);
    runCheckMock.mockClear();
    mock.onUpdated.fire(1, { status: 'complete' }, tabs.get(1));
    await settle();
    expect(runCheckMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------- OpenAlex key

describe('OpenAlex key', () => {
  test('is applied from settings at startup', async () => {
    const spy = vi.spyOn(openalex, 'setApiKey').mockImplementation(() => undefined);
    await setSettings({ openAlexKey: 'abcdefgh12345678' });
    startBackground();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('abcdefgh12345678'));
  });

  test('is applied again whenever settings change', async () => {
    const spy = vi.spyOn(openalex, 'setApiKey').mockImplementation(() => undefined);
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { openAlexKey: 'zzzzzzzz99999999' } });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('zzzzzzzz99999999'));
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: {} });
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith(undefined));
  });

  test('a key the adapter rejects (RangeError) never crashes the background and leaves the key cleared', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const spy = vi.spyOn(openalex, 'setApiKey').mockImplementation((key) => {
      if (key !== undefined) throw new RangeError('API key too short');
    });
    await setSettings({ openAlexKey: 'abcdefgh' });
    expect(() => startBackground()).not.toThrow();
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith(undefined));
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { openAlexKey: 'abcdefghi' } });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('abcdefghi'));
    await settle();
    expect(spy).toHaveBeenLastCalledWith(undefined);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
    // The background still answers.
    expect((await send({ type: 'history:clear' })).reply).toEqual({ ok: true });
  });

  test('the key is never logged', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(openalex, 'setApiKey').mockImplementation(() => {
      throw new RangeError('too short');
    });
    await setSettings({ openAlexKey: 'abcdefgh' });
    startBackground();
    await settle();
    expect(JSON.stringify([...log.mock.calls, ...err.mock.calls])).not.toContain('abcdefgh');
  });
});


// The same hand-off with no run in the tab: a click is held for its own tab even when delivered live, and taken once.
describe('badge click hand-off without a run', () => {
  test('a click delivered live is never pushed to the next panel that connects; its tab can take it once', async () => {
    vi.useFakeTimers();
    openTab(5, HTML_URL);
    const open = connectPanel();
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect(byType(open.events, 'badge:clicked')).toEqual([{ type: 'badge:clicked', tabId: 5, index: 4 }]);
    vi.advanceTimersByTime(3000);
    const reopened = connectPanel();
    expect(byType(reopened.events, 'badge:clicked')).toEqual([]);
    expect((await send({ type: 'badge:take', tabId: 5 })).reply).toEqual({ ok: true, badgeIndex: 4 });
    expect((await send({ type: 'badge:take', tabId: 5 })).reply).toEqual({ ok: true });
  });

  test('a held click in tab 5 is not handed to a panel for tab 6, and only once to tab 5', async () => {
    vi.useFakeTimers();
    openTab(5, HTML_URL);
    openTab(6, ABS_URL);
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect((await send({ type: 'badge:take', tabId: 6 })).reply).toEqual({ ok: true });
    expect((await send({ type: 'badge:take', tabId: 5 })).reply).toEqual({ ok: true, badgeIndex: 4 });
    expect((await send({ type: 'badge:take', tabId: 5 })).reply).toEqual({ ok: true });
  });

  test('badge:take only from the side panel page; content scripts and subframes are ignored', async () => {
    openTab(5, HTML_URL);
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect(await send({ type: 'badge:take', tabId: 5 }, contentSender(5, HTML_URL))).toEqual({ handled: false });
    expect(await send({ type: 'badge:take', tabId: 5 }, contentSender(5, HTML_URL, 3))).toEqual({ handled: false });
    expect((await send({ type: 'badge:take', tabId: 5 })).reply).toEqual({ ok: true, badgeIndex: 4 });
  });

  test('with a panel open in another window, the panel the click opens still gets the row', async () => {
    openTab(5, HTML_URL);
    connectPanel(); // a panel open in another window, showing another tab
    await send({ type: 'badge:clicked', index: 4 }, contentSender(5, HTML_URL));
    expect((await send({ type: 'badge:take', tabId: 5 })).reply).toEqual({ ok: true, badgeIndex: 4 });
  });
});

// ---------------------------------------------------------------------------- storage

describe('who may read storage', () => {
  test('on Chrome and Edge, storage is closed to content scripts at start-up (the OpenAlex key and history live there)', () => {
    expect(mock.setAccessLevel).toHaveBeenCalledTimes(1);
    expect(mock.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  test('a browser without access levels (Firefox) starts the same', async () => {
    Reflect.deleteProperty(fakeBrowser.storage.local, 'setAccessLevel');
    mock.onMessage.listeners.length = 0;
    expect(() => startBackground()).not.toThrow();
    expect(mock.onMessage.listeners.length).toBeGreaterThan(0);
    openTab(1, ABS_URL);
    expect((await send({ type: 'check:start', tabId: 1 })).reply).toEqual({ ok: true });
  });

  test('a refusal to set the access level does not stop the background', async () => {
    const refused = vi.fn(() => Promise.reject(new Error('not supported')));
    const throws = vi.fn(() => {
      throw new Error('not supported');
    });
    for (const setAccessLevel of [refused, throws]) {
      Object.assign(fakeBrowser.storage.local, { setAccessLevel });
      mock.onMessage.listeners.length = 0;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(() => startBackground()).not.toThrow();
      await settle();
      expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
      expect(warn).toHaveBeenCalled();
      openTab(1, ABS_URL);
      expect((await send({ type: 'check:start', tabId: 1 })).reply).toEqual({ ok: true });
    }
  });
});
