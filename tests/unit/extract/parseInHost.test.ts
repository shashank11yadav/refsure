import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OFFSCREEN_TARGET } from '../../../src/extract/offscreenProtocol';
import { FIREFOX_PDF_WORKER } from '../../../src/config';
import { pageBytes, pageText } from '../helpers/pages';
import { FakeModuleWorker } from '../helpers/fakeModuleWorker';
import pdfWorkerUrl from '../helpers/pdfWorkerUrl';

// The exported parseInHost picks its strategy from the build target (import.meta.env.FIREFOX,
// fixed at build time). Here the flag is set per test and the module reloaded.

const sendMessage = vi.fn();
const createDocument = vi.fn<(options: unknown) => Promise<void>>(async () => undefined);
const getContexts = vi.fn<(filter: unknown) => Promise<unknown[]>>(async () => []);

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'ext-id',
      // The worker file of the Firefox build is, in Node, the legacy worker (pdf.js loads it by import).
      getURL: (path: string) => (path === `/${FIREFOX_PDF_WORKER}` ? pdfWorkerUrl : `chrome-extension://ext-id${path}`),
      sendMessage: (m: unknown) => sendMessage(m) as Promise<unknown>,
      getContexts: (f: unknown) => getContexts(f) as Promise<unknown[]>,
    },
    offscreen: { createDocument: (o: unknown) => createDocument(o), closeDocument: () => Promise.resolve() },
  },
}));

async function load() {
  vi.resetModules();
  return (await import('../../../src/extract/parseHost')).parseInHost;
}

beforeEach(() => {
  sendMessage.mockReset();
  createDocument.mockClear();
  getContexts.mockClear();
  vi.stubGlobal('DOMParser', new Window({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } }).DOMParser);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('parseInHost as built for Chrome and Edge', () => {
  test('creates the offscreen document once and messages it', async () => {
    vi.stubEnv('FIREFOX', '');
    sendMessage.mockResolvedValue({ ok: true, refs: [{ index: 1, label: '[1]', text: 'A. Author. A title. 2020.' }], confidence: 1 });
    const parseInHost = await load();
    const first = await parseInHost({ kind: 'arxiv-html-text', html: '<p>x</p>' });
    getContexts.mockResolvedValue([{}]);
    await parseInHost({ kind: 'arxiv-html-text', html: '<p>y</p>' });
    expect(first.refs).toHaveLength(1);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledWith({ url: 'offscreen.html', reasons: ['DOM_PARSER', 'WORKERS'], justification: expect.stringContaining('Parses') });
    expect(getContexts).toHaveBeenCalledWith({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: ['chrome-extension://ext-id/offscreen.html'] });
    expect(sendMessage).toHaveBeenNthCalledWith(1, { target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html: '<p>x</p>' });
  });
});

describe('parseInHost as built for Firefox', () => {
  test('parses HTML in the background page without an offscreen document', async () => {
    vi.stubEnv('FIREFOX', 'true');
    const parseInHost = await load();
    const result = await parseInHost({ kind: 'arxiv-html-text', html: pageText('arxiv-2402.03664v5.html') });
    expect(result.refs).toHaveLength(71);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
    expect(getContexts).not.toHaveBeenCalled();
  });

  test('parses a PDF in the background page with pdf.js running the worker file shipped at the fixed path', async () => {
    vi.stubEnv('FIREFOX', 'true');
    // Firefox starts the module worker itself and hands it to pdf.js (src/extract/pdfjsRuntime.ts).
    FakeModuleWorker.started = [];
    vi.stubGlobal('Worker', FakeModuleWorker);
    const parseInHost = await load();
    const result = await parseInHost({ kind: 'pdf', data: pageBytes('arxiv-2402.03664v5-numeric.pdf') });
    expect(result.refs).toHaveLength(71);
    const { GlobalWorkerOptions } = await import('pdfjs-dist');
    expect(GlobalWorkerOptions.workerSrc).toBe(pdfWorkerUrl);
    expect(FakeModuleWorker.started.map((w) => ({ url: w.url, options: w.options }))).toEqual([{ url: pdfWorkerUrl, options: { type: 'module' } }]);
    // The read's own worker, not a shared port, and it is gone once the read is over.
    expect(GlobalWorkerOptions.workerPort).toBeNull();
    expect(FakeModuleWorker.started.map((w) => w.terminated)).toEqual([true]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('two PDFs read at the same time each get their own worker and both succeed', async () => {
    vi.stubEnv('FIREFOX', 'true');
    FakeModuleWorker.started = [];
    vi.stubGlobal('Worker', FakeModuleWorker);
    const parseInHost = await load();
    const [a, b] = await Promise.all([
      parseInHost({ kind: 'pdf', data: pageBytes('arxiv-2402.03664v5-numeric.pdf') }),
      parseInHost({ kind: 'pdf', data: pageBytes('arxiv-2402.03664v5-numeric.pdf') }),
    ]);
    expect(a.refs).toHaveLength(71);
    expect(b.refs).toHaveLength(71);
    expect(FakeModuleWorker.started).toHaveLength(2);
    expect(FakeModuleWorker.started.every((w) => w.terminated)).toBe(true);
  });

  test('a read that fails does not hang a read running beside it, and releases its worker', async () => {
    vi.stubEnv('FIREFOX', 'true');
    FakeModuleWorker.started = [];
    vi.stubGlobal('Worker', FakeModuleWorker);
    const parseInHost = await load();
    const garbage = new TextEncoder().encode('this is not a pdf at all').buffer;
    const [bad, good] = await Promise.allSettled([parseInHost({ kind: 'pdf', data: garbage }), parseInHost({ kind: 'pdf', data: pageBytes('arxiv-2402.03664v5-numeric.pdf') })]);
    expect(bad.status).toBe('rejected');
    expect(good.status).toBe('fulfilled');
    expect(FakeModuleWorker.started).toHaveLength(2);
    expect(FakeModuleWorker.started.every((w) => w.terminated)).toBe(true);
  });
});
