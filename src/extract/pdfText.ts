// Reading positioned text runs for each page of a PDF with pdf.js.

import { PARSE_TIMEOUT_MS } from './offscreenProtocol';
import { DOCUMENT_OPTIONS, loadPdfjs, openPdfWorker, type PdfWorkerHandle } from './pdfjsRuntime';
import type { PageText, TextRun } from './pdfLayout';
import { PdfReadError } from './readError';

const MAX_PAGES = 120;
const MAX_RUNS_PER_PAGE = 100_000;
const TIMEOUT_MS = PARSE_TIMEOUT_MS;

function describeFailure(error: unknown, timedOut: boolean): PdfReadError {
  if (timedOut) return new PdfReadError('Reading this PDF took too long', 'timeout');
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  if (name === 'PasswordException') return new PdfReadError('This PDF is password protected', 'password');
  return new PdfReadError('This file could not be read as a PDF', 'invalid');
}

function isRotated(transform: number[]): boolean {
  // [a, b, c, d, e, f]: b is non-zero when the text runs up or down the page (margin stamps, rotated tables).
  return Math.abs(transform[1] ?? 0) > 0.2 * Math.abs(transform[0] ?? 1);
}

/**
 * The text of the last pages of a PDF (where the reference list is), in page order.
 * Rotated text is dropped. The bytes are copied first: pdf.js hands its input to the
 * worker, which would otherwise empty the caller's buffer.
 */
export async function readPdfPages(data: ArrayBuffer): Promise<PageText[]> {
  // A reader that cannot start (no worker) is a failure to read this file, said plainly.
  const cannotStart = (): PdfReadError => new PdfReadError('The PDF reader could not start', 'invalid');
  const pdfjs = await loadPdfjs().catch(() => {
    throw cannotStart();
  });
  let handle: PdfWorkerHandle;
  try {
    handle = openPdfWorker(pdfjs);
  } catch {
    throw cannotStart();
  }
  // getDocument can throw at once (bad options, an unusable worker); that is a failed read too.
  let task: ReturnType<typeof pdfjs.getDocument>;
  try {
    task = pdfjs.getDocument({ ...DOCUMENT_OPTIONS, data: new Uint8Array(data.slice(0)), ...(handle.worker !== undefined && { worker: handle.worker }) });
  } catch (error) {
    handle.dispose();
    throw describeFailure(error, false);
  }
  let workerFailed = false;
  handle.onError(() => {
    workerFailed = true;
    void task.destroy();
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void task.destroy();
  }, TIMEOUT_MS);
  try {
    const doc = await task.promise;
    const pages: PageText[] = [];
    for (let n = Math.max(1, doc.numPages - MAX_PAGES + 1); n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
      const content = await page.getTextContent();
      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!('str' in item) || item.str === '' || isRotated(item.transform) || runs.length >= MAX_RUNS_PER_PAGE) continue;
        runs.push({ str: item.str, x: (item.transform[4] ?? 0) - x0, y: (item.transform[5] ?? 0) - y0, width: item.width, height: item.height });
      }
      pages.push({ width: x1 - x0, height: y1 - y0, runs });
      page.cleanup();
    }
    return pages;
  } catch (error) {
    if (workerFailed) throw new PdfReadError('The PDF reader stopped unexpectedly', 'invalid');
    throw describeFailure(error, timedOut);
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => undefined);
    // After the task: it may still be talking to the worker while it is torn down.
    handle.dispose();
  }
}
