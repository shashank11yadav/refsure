import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FIREFOX_PDF_WORKER } from '../../../src/config';
import { DOCUMENT_OPTIONS, loadPdfjs } from '../../../src/extract/pdfjsRuntime';

// The pdf.js options are a security boundary (SECURITY.md sections 3 and 6): text only,
// nothing fetched, no generated code. These pin them so a change has to be deliberate.
describe('pdf.js options', () => {
  test('nothing that reaches the network or draws is switched on', () => {
    expect(DOCUMENT_OPTIONS).toMatchObject({
      useWorkerFetch: false,
      useWasm: false,
      disableFontFace: true,
      useSystemFonts: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      enableXfa: false,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      pdfBug: false,
    });
  });

  test('no location is given for CMaps, fonts, ICC profiles, wasm or the document itself', () => {
    for (const key of ['cMapUrl', 'standardFontDataUrl', 'iccUrl', 'wasmUrl', 'url', 'httpHeaders', 'withCredentials', 'range', 'worker']) {
      expect(DOCUMENT_OPTIONS, key).not.toHaveProperty(key);
    }
  });

  test('only errors are logged', async () => {
    expect(DOCUMENT_OPTIONS.verbosity).toBe((await loadPdfjs()).VerbosityLevel.ERRORS);
  });

  test('the worker is configured, once', async () => {
    const pdfjs = await loadPdfjs();
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toMatch(/pdf\.worker\.mjs$/);
    expect(await loadPdfjs()).toBe(pdfjs);
  });
});

describe('pdf.js worker in Firefox builds', () => {
  /** Records every worker started; a stand-in for the browser's Worker (this runs in Node). */
  class RecordingWorker {
    static started: RecordingWorker[] = [];
    static failWith: Error | undefined;
    readonly listeners = new Map<string, (() => void)[]>();
    terminated = false;
    constructor(
      readonly url: string,
      readonly options: unknown,
    ) {
      if (RecordingWorker.failWith) throw RecordingWorker.failWith;
      RecordingWorker.started.push(this);
    }
    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    removeEventListener(): void {}
    postMessage(): void {}
    terminate(): void {
      this.terminated = true;
    }
    fail(): void {
      for (const listener of this.listeners.get('error') ?? []) listener();
    }
  }

  async function firefoxRuntime() {
    vi.stubEnv('FIREFOX', 'true');
    vi.doMock('wxt/browser', () => ({ browser: { runtime: { getURL: (path: string) => `moz-extension://abc${path}` } } }));
    vi.resetModules();
    return import('../../../src/extract/pdfjsRuntime');
  }

  beforeEach(async () => {
    // pdf.js is loaded by Node itself and survives resetModules, and so would the port of an earlier test.
    (await import('pdfjs-dist')).GlobalWorkerOptions.workerPort = null;
    RecordingWorker.started = [];
    RecordingWorker.failWith = undefined;
    vi.stubGlobal('Worker', RecordingWorker);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock('wxt/browser');
    vi.resetModules();
  });

  test('the worker file is a module worker inside the package, at the fixed path, never a bundled or inlined worker', async () => {
    const runtime = await firefoxRuntime();
    const pdfjs = await runtime.loadPdfjs();
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('moz-extension://abc/pdf.worker.mjs');
    expect(FIREFOX_PDF_WORKER).toBe('pdf.worker.mjs');
  });

  test('loading pdf.js starts no worker and sets no shared port', async () => {
    const runtime = await firefoxRuntime();
    const pdfjs = await runtime.loadPdfjs();
    expect(RecordingWorker.started).toHaveLength(0);
    expect(pdfjs.GlobalWorkerOptions.workerPort).toBeNull();
  });

  test('each read gets its own module worker, started by RefSure and handed to pdf.js as a ready-made worker', async () => {
    const runtime = await firefoxRuntime();
    const pdfjs = await runtime.loadPdfjs();
    const a = runtime.openPdfWorker(pdfjs);
    const b = runtime.openPdfWorker(pdfjs);
    expect(RecordingWorker.started).toHaveLength(2);
    expect(RecordingWorker.started[0]).not.toBe(RecordingWorker.started[1]);
    for (const w of RecordingWorker.started) {
      expect(w.url).toBe('moz-extension://abc/pdf.worker.mjs');
      expect(w.options).toEqual({ type: 'module' });
    }
    expect(a.worker?.port).toBe(RecordingWorker.started[0]);
    expect(b.worker?.port).toBe(RecordingWorker.started[1]);
    expect(pdfjs.GlobalWorkerOptions.workerPort).toBeNull();
  });

  test('disposing stops that read\'s worker only, and doing it twice is harmless', async () => {
    const runtime = await firefoxRuntime();
    const pdfjs = await runtime.loadPdfjs();
    const a = runtime.openPdfWorker(pdfjs);
    runtime.openPdfWorker(pdfjs);
    a.dispose();
    a.dispose();
    expect(RecordingWorker.started.map((w) => w.terminated)).toEqual([true, false]);
  });

  test('a worker that cannot be started fails closed: the read is refused rather than falling back to an in-page worker', async () => {
    const runtime = await firefoxRuntime();
    const pdfjs = await runtime.loadPdfjs();
    RecordingWorker.failWith = new Error('blocked');
    expect(() => runtime.openPdfWorker(pdfjs)).toThrow('blocked');
    // And a later read tries again.
    RecordingWorker.failWith = undefined;
    expect(runtime.openPdfWorker(pdfjs).worker).toBeDefined();
  });

  test('a browser without Workers fails closed too', async () => {
    vi.stubGlobal('Worker', undefined);
    const runtime = await firefoxRuntime();
    const pdfjs = await runtime.loadPdfjs();
    expect(() => runtime.openPdfWorker(pdfjs)).toThrow();
  });

  test('a worker script that fails reports it to the read that owns it', async () => {
    const runtime = await firefoxRuntime();
    const pdfjs = await runtime.loadPdfjs();
    const a = runtime.openPdfWorker(pdfjs);
    const b = runtime.openPdfWorker(pdfjs);
    const failed = vi.fn();
    const fine = vi.fn();
    a.onError(failed);
    b.onError(fine);
    RecordingWorker.started[0]?.fail();
    expect(failed).toHaveBeenCalledOnce();
    expect(fine).not.toHaveBeenCalled();
  });

  test('Chrome and Edge builds hand pdf.js no worker of ours', async () => {
    vi.stubEnv('FIREFOX', '');
    vi.resetModules();
    const runtime = await import('../../../src/extract/pdfjsRuntime');
    const pdfjs = await runtime.loadPdfjs();
    const handle = runtime.openPdfWorker(pdfjs);
    expect(handle.worker).toBeUndefined();
    expect(RecordingWorker.started).toHaveLength(0);
  });
});
