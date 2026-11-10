import { beforeEach, describe, expect, test, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  dispose: vi.fn(),
  getDocument: vi.fn(),
  openPdfWorker: vi.fn(),
}));

vi.mock('../../../src/extract/pdfjsRuntime', () => ({
  DOCUMENT_OPTIONS: {},
  loadPdfjs: () => Promise.resolve({ getDocument: runtime.getDocument }),
  openPdfWorker: runtime.openPdfWorker,
}));

import { readPdfPages } from '../../../src/extract/pdfText';
import { PdfReadError } from '../../../src/extract/readError';

beforeEach(() => {
  runtime.dispose.mockReset();
  runtime.getDocument.mockReset();
  runtime.openPdfWorker.mockReset();
  runtime.openPdfWorker.mockReturnValue({ worker: {}, onError: () => undefined, dispose: runtime.dispose });
});

describe('a read that cannot start', () => {
  test('a getDocument that throws at once is a PdfReadError and its worker is released', async () => {
    runtime.getDocument.mockImplementation(() => {
      throw new TypeError('bad worker');
    });
    const error = await readPdfPages(new ArrayBuffer(8)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfReadError);
    expect((error as PdfReadError).reason).toBe('invalid');
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  test('a worker that cannot be opened is a PdfReadError', async () => {
    runtime.openPdfWorker.mockImplementation(() => {
      throw new Error('blocked');
    });
    const error = await readPdfPages(new ArrayBuffer(8)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfReadError);
    expect(runtime.getDocument).not.toHaveBeenCalled();
  });

  test('the worker is released after the task is destroyed, whatever happens to the read', async () => {
    const order: string[] = [];
    runtime.getDocument.mockReturnValue({ promise: Promise.reject(new Error('broken')), destroy: () => Promise.resolve(void order.push('task')) });
    runtime.dispose.mockImplementation(() => void order.push('worker'));
    await expect(readPdfPages(new ArrayBuffer(8))).rejects.toBeInstanceOf(PdfReadError);
    expect(order).toEqual(['task', 'worker']);
  });
});
