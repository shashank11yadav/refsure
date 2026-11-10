// The one place that touches pdf.js: how it is loaded and which of its features are on.
//
// pdf.js here only reads text out of bytes we already fetched through src/sources/http.ts.
// It is given an ArrayBuffer, never a URL, so it has nothing to fetch; its worker is a file
// inside the extension package (no CDN, no blob: or data: URL); and every option that could
// reach the network, run generated code or draw is switched off. It needs a DOM and Workers,
// so it runs in the offscreen document (Chrome, Edge) or the background page (Firefox, with its worker in a file),
// never in the Chrome service worker.
//
// Node tests resolve these imports to pdf.js's legacy build (vitest.config.ts); the production
// bundle gets pdf.js with its Node-only and network code removed (scripts/pdfjsBuild.ts).

import * as pdfjs from 'pdfjs-dist';
import { FIREFOX_PDF_WORKER } from '../config';
import { extensionUrl } from './extensionUrl';

export type PdfjsModule = typeof pdfjs;

// Options are written out one by one so a pdf.js upgrade cannot silently turn one on.
// pdf.js 6.x has no `isEvalSupported` option (its glyph and function code no longer builds
// functions from strings), so there is nothing to switch off for eval.
export const DOCUMENT_OPTIONS = {
  // Nothing is fetched: no CMap, standard-font, ICC or wasm location is given, and the worker
  // is told not to look any up. Text in fonts that need those still comes out; only glyph
  // drawing, which we never do, would suffer.
  useWorkerFetch: false,
  useWasm: false,
  // Text extraction only: no font loading, no system fonts, no canvas or image decoding.
  disableFontFace: true,
  useSystemFonts: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  maxImageSize: 1,
  enableXfa: false,
  // The whole file is already in memory; no ranged or streamed loading, no prefetch.
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  // Parsing problems degrade to partial text instead of aborting the page.
  stopAtErrors: false,
  pdfBug: false,
  // Errors only; pdf.js warnings can quote document content.
  verbosity: pdfjs.VerbosityLevel.ERRORS,
} as const;

let configured: Promise<PdfjsModule> | undefined;

async function configure(): Promise<PdfjsModule> {
  if (import.meta.env.FIREFOX) {
    // Firefox's background page gets the worker as a file at a fixed path in the package (emitted by
    // scripts/pdfjsBuild.ts): the build inlines imported assets into background scripts, and a data:
    // URL is not loadable under the extension CSP. Each read starts its own module worker from it
    // (`openPdfWorker`); the global port is never set, so nothing is shared between reads.
    pdfjs.GlobalWorkerOptions.workerSrc = extensionUrl(`/${FIREFOX_PDF_WORKER}`);
  } else {
    // Chrome and Edge: the offscreen document loads the worker from a file in the package.
    const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjs;
}

/** The worker one read uses (Firefox), and how to let go of it. */
export interface PdfWorkerHandle {
  /** Passed to `getDocument`; undefined where pdf.js starts its own worker from `workerSrc` (Chrome, Edge). */
  worker?: InstanceType<PdfjsModule['PDFWorker']>;
  /** Calls `callback` if the worker script fails. */
  onError(callback: () => void): void;
  /** Stops the worker. Safe to call more than once. */
  dispose(): void;
}

/**
 * Firefox: a new module Worker for this one read, handed to pdf.js as a ready-made PDFWorker. Left to
 * itself pdf.js starts the worker and, if that fails for any reason, quietly runs the whole PDF engine
 * inside this page instead (its "fake worker"). With a worker of our own a failed start is an error here
 * and pdf.js has no in-page fallback to reach for. The worker belongs to the read: it is never shared (a
 * shared one races the teardown of the read before it) and `dispose` terminates it however the read ends.
 * Chrome and Edge need nothing: their offscreen document lets pdf.js start the worker.
 */
export function openPdfWorker(pdfModule: PdfjsModule): PdfWorkerHandle {
  if (!import.meta.env.FIREFOX) return { onError: () => undefined, dispose: () => undefined };
  if (typeof Worker === 'undefined') throw new Error('Workers are not available');
  const raw = new Worker(extensionUrl(`/${FIREFOX_PDF_WORKER}`), { type: 'module' });
  let worker: InstanceType<PdfjsModule['PDFWorker']> | undefined;
  try {
    worker = new pdfModule.PDFWorker({ port: raw as never });
  } catch (error) {
    raw.terminate();
    throw error;
  }
  const made = worker;
  let disposed = false;
  return {
    worker: made,
    onError: (callback) => raw.addEventListener('error', callback),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        made.destroy();
      } finally {
        raw.terminate();
      }
    },
  };
}

/** pdf.js with its bundled worker set up. */
export function loadPdfjs(): Promise<PdfjsModule> {
  configured ??= configure().catch((error: unknown) => {
    configured = undefined;
    throw error;
  });
  return configured;
}
