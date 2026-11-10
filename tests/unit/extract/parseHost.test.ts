import { afterEach, describe, expect, test, vi } from 'vitest';
import { toCheckFailure } from '../../../src/background/loadPaper';
import { OFFSCREEN_TARGET, base64ToBytes, failure } from '../../../src/extract/offscreenProtocol';
import { PdfReadError } from '../../../src/extract/readError';
import { type HostDeps, createParseInHost } from '../../../src/extract/parseHost';

const RESULT = { refs: [{ index: 1, label: '[1]', text: 'A. Author. A title. 2020.' }], confidence: 0.95 };
const REPLY = { ok: true, ...RESULT };

function setup(over: Partial<HostDeps> = {}) {
  const createDocument = vi.fn(async () => undefined);
  const closeDocument = vi.fn(async () => undefined);
  const sendMessage = vi.fn((message: unknown): Promise<unknown> => Promise.resolve(message === undefined ? undefined : REPLY));
  const parseDirect = vi.fn(async () => RESULT);
  const deps: HostDeps = {
    mode: 'offscreen',
    parseDirect,
    offscreen: { createDocument, closeDocument },
    hasOffscreenDocument: async () => false,
    sendMessage,
    ...over,
  };
  return { parse: createParseInHost(deps), createDocument, closeDocument, sendMessage, parseDirect };
}

describe('parseInHost on Chrome and Edge (offscreen document)', () => {
  test('creates the offscreen document with the right reasons and a justification, then sends the request', async () => {
    const { parse, createDocument, sendMessage, parseDirect } = setup();
    const result = await parse({ kind: 'arxiv-html-text', html: '<p>paper</p>' });
    expect(result).toEqual(RESULT);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER', 'WORKERS'],
      justification: expect.stringMatching(/parses.*paper/i),
    });
    expect(sendMessage).toHaveBeenCalledWith({ target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html: '<p>paper</p>' });
    expect(parseDirect).not.toHaveBeenCalled();
  });

  test('PDF bytes are sent as base64 text', async () => {
    const { parse, sendMessage } = setup();
    const data = Uint8Array.from([37, 80, 68, 70, 45, 1, 2, 3]).buffer;
    await parse({ kind: 'pdf', data });
    const message = sendMessage.mock.calls[0]?.[0] as { kind: string; dataBase64: string };
    expect(message.kind).toBe('pdf');
    expect(typeof message.dataBase64).toBe('string');
    expect(base64ToBytes(message.dataBase64)).toEqual(new Uint8Array(data));
  });

  test('an existing offscreen document is reused', async () => {
    const { parse, createDocument } = setup({ hasOffscreenDocument: async () => true });
    await parse({ kind: 'arxiv-html-text', html: 'x' });
    expect(createDocument).not.toHaveBeenCalled();
  });

  test('simultaneous requests share one creation', async () => {
    let release: () => void = () => undefined;
    const createDocument = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { parse } = setup({ offscreen: { createDocument, closeDocument: async () => undefined } });
    const all = Promise.all([parse({ kind: 'arxiv-html-text', html: 'a' }), parse({ kind: 'arxiv-html-text', html: 'b' }), parse({ kind: 'arxiv-html-text', html: 'c' })]);
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalled());
    release();
    await all;
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  test('"only a single offscreen document" is not an error, other failures are, and the next call retries', async () => {
    const createDocument = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Only a single offscreen document may be created.'))
      .mockRejectedValueOnce(new Error('Extension context invalidated'))
      .mockResolvedValue(undefined);
    const { parse } = setup({ offscreen: { createDocument, closeDocument: async () => undefined } });
    await expect(parse({ kind: 'arxiv-html-text', html: 'x' })).resolves.toEqual(RESULT);
    await expect(parse({ kind: 'arxiv-html-text', html: 'x' })).rejects.toThrow('Extension context invalidated');
    await expect(parse({ kind: 'arxiv-html-text', html: 'x' })).resolves.toEqual(RESULT);
    expect(createDocument).toHaveBeenCalledTimes(3);
  });

  test('a reply that fails the shape check is refused', async () => {
    const { parse } = setup({ sendMessage: async () => ({ ok: true, refs: [{ index: 9, label: 'x', text: 'y' }], confidence: 1 }) });
    await expect(parse({ kind: 'arxiv-html-text', html: 'x' })).rejects.toThrow('unexpected reply');
    const none = setup({ sendMessage: async () => undefined });
    await expect(none.parse({ kind: 'arxiv-html-text', html: 'x' })).rejects.toThrow('unexpected reply');
  });

  test('an error reply becomes a thrown error with its message', async () => {
    const { parse } = setup({ sendMessage: async () => ({ ok: false, error: 'Something went wrong' }) });
    const error = await parse({ kind: 'pdf', data: new ArrayBuffer(8) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PdfReadError);
    expect((error as Error).message).toBe('Something went wrong');
  });

  test.each([
    ['password', 'This PDF is password protected'],
    ['timeout', 'Reading this PDF took too long'],
    ['invalid', 'This file could not be read as a PDF'],
  ] as const)('a paper the offscreen document could not read (%s) is still a PdfReadError, and its message is shown', async (reason, message) => {
    // The reply as it crosses the extension message channel: JSON, so the error's class is lost on the way.
    const { parse } = setup({ sendMessage: async () => JSON.parse(JSON.stringify(failure(new PdfReadError(message, reason)))) as unknown });
    const error = await parse({ kind: 'pdf', data: new ArrayBuffer(8) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfReadError);
    expect(error).toMatchObject({ message, reason });
    expect(toCheckFailure(error)).toMatchObject({ code: 'fetch-failed', message });
  });

  test('without offscreen support it fails clearly instead of parsing somewhere unsafe', async () => {
    const { parse, parseDirect } = setup({ offscreen: undefined });
    await expect(parse({ kind: 'arxiv-html-text', html: 'x' })).rejects.toThrow('not available');
    expect(parseDirect).not.toHaveBeenCalled();
  });

  test('oversized input is refused before anything is sent', async () => {
    const { parse, sendMessage, createDocument } = setup();
    await expect(parse({ kind: 'pdf', data: new ArrayBuffer(30 * 1024 * 1024 + 1) })).rejects.toThrow('too large');
    await expect(parse({ kind: 'arxiv-html-text', html: 'x'.repeat(10 * 1024 * 1024 + 1) })).rejects.toThrow('too large');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
  });
});

describe('parseInHost on Firefox (background page)', () => {
  test('parses in place and never touches an offscreen document or messaging', async () => {
    const { parse, parseDirect, createDocument, sendMessage } = setup({ mode: 'direct' });
    const request = { kind: 'pdf', data: new ArrayBuffer(8) } as const;
    expect(await parse(request)).toEqual(RESULT);
    expect(parseDirect).toHaveBeenCalledWith(request);
    expect(createDocument).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('size limits apply here too', async () => {
    const { parse, parseDirect } = setup({ mode: 'direct' });
    await expect(parse({ kind: 'pdf', data: new ArrayBuffer(30 * 1024 * 1024 + 1) })).rejects.toThrow('too large');
    expect(parseDirect).not.toHaveBeenCalled();
  });
});

describe('parseInHost timeouts and idle close (offscreen mode)', () => {
  afterEach(() => vi.useRealTimers());
  const REPLY_LIMIT = 65_000; // the parse limit (60 s) plus 5 s
  const IDLE = 60_000;
  const html = { kind: 'arxiv-html-text', html: '<p>x</p>' } as const;

  test('a reply that never comes rejects with a timeout, closes the offscreen document, and the next call recreates it', async () => {
    vi.useFakeTimers();
    let open = false;
    const createDocument = vi.fn(async () => void (open = true));
    const closeDocument = vi.fn(async () => void (open = false));
    const sendMessage = vi.fn().mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValue(REPLY);
    const { parse } = setup({ offscreen: { createDocument, closeDocument }, hasOffscreenDocument: async () => open, sendMessage });

    const first = parse(html);
    const outcome = first.then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REPLY_LIMIT - 1);
    expect(closeDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(PdfReadError);
    expect((error as PdfReadError).reason).toBe('timeout');
    expect(closeDocument).toHaveBeenCalledTimes(1);

    await expect(parse(html)).resolves.toEqual(RESULT);
    expect(createDocument).toHaveBeenCalledTimes(2);
  });

  test('a reply that arrives in time cancels the timeout', async () => {
    vi.useFakeTimers();
    const { parse, closeDocument } = setup({ sendMessage: async () => REPLY });
    await parse(html);
    await vi.advanceTimersByTimeAsync(REPLY_LIMIT - 1);
    // Only the idle close may have fired by now, never a timeout close of an answered request.
    expect(closeDocument.mock.calls.length).toBeLessThanOrEqual(1);
  });

  test('the offscreen document is closed 60 s after the last request', async () => {
    vi.useFakeTimers();
    const { parse, closeDocument } = setup();
    await parse(html);
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(closeDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  test('a new request restarts the idle wait', async () => {
    vi.useFakeTimers();
    const { parse, closeDocument } = setup();
    await parse(html);
    await vi.advanceTimersByTimeAsync(40_000);
    await parse(html);
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(closeDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  test('a request in flight keeps the document open; the wait starts when the last one ends', async () => {
    vi.useFakeTimers();
    let release: (v: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => (release = resolve));
    const sendMessage = vi.fn().mockReturnValueOnce(slow).mockResolvedValue(REPLY);
    const { parse, closeDocument } = setup({ sendMessage });
    const long = parse(html);
    await parse(html);
    await vi.advanceTimersByTimeAsync(IDLE + 2000); // past the idle wait, short of the reply limit
    expect(closeDocument).not.toHaveBeenCalled();
    release(REPLY);
    await long;
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  test('a failed request also starts the idle wait, and a failing close is ignored', async () => {
    vi.useFakeTimers();
    const closeDocument = vi.fn(async () => {
      throw new Error('No current offscreen document.');
    });
    const { parse } = setup({ sendMessage: async () => ({ ok: false, error: 'bad pdf' }), offscreen: { createDocument: async () => undefined, closeDocument } });
    await expect(parse(html)).rejects.toThrow('bad pdf');
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  test('direct mode (Firefox) leaves no timer behind once answered and closes nothing', async () => {
    vi.useFakeTimers();
    const { parse, closeDocument } = setup({ mode: 'direct' });
    await parse(html);
    expect(vi.getTimerCount()).toBe(0);
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test('direct mode (Firefox) gives up on a parse that never answers, at the same limit as the offscreen path', async () => {
    vi.useFakeTimers();
    const parseDirect = vi.fn(() => new Promise<never>(() => undefined));
    const { parse, closeDocument } = setup({ mode: 'direct', parseDirect });
    const outcome = parse(html).then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REPLY_LIMIT - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(PdfReadError);
    expect((error as PdfReadError).reason).toBe('timeout');
    expect((error as PdfReadError).message).toBe('Reading this paper took too long');
    expect(vi.getTimerCount()).toBe(0);
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test('direct mode (Firefox): a parse that fails is passed on and its timer cleared', async () => {
    vi.useFakeTimers();
    const { parse } = setup({ mode: 'direct', parseDirect: vi.fn(() => Promise.reject(new PdfReadError('This PDF is password protected', 'password'))) });
    await expect(parse(html)).rejects.toMatchObject({ reason: 'password' });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a request that arrives while the document is closing waits for the close, then recreates it', async () => {
    vi.useFakeTimers();
    let open = false;
    let finishClose: () => void = () => undefined;
    const order: string[] = [];
    const createDocument = vi.fn(async () => {
      order.push('create');
      open = true;
    });
    const closeDocument = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push('close-start');
          finishClose = () => {
            open = false;
            order.push('close-done');
            resolve();
          };
        }),
    );
    const sendMessage = vi.fn(async () => {
      order.push('send');
      return REPLY;
    });
    const { parse } = setup({ offscreen: { createDocument, closeDocument }, hasOffscreenDocument: async () => open, sendMessage });
    await parse(html);
    await vi.advanceTimersByTimeAsync(IDLE); // idle close begins and does not finish
    expect(order).toEqual(['create', 'send', 'close-start']);

    const second = parse(html);
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(['create', 'send', 'close-start']); // nothing is sent to the closing document
    finishClose();
    await second;
    expect(order).toEqual(['create', 'send', 'close-start', 'close-done', 'create', 'send']);
  });

  test('createDocument that never finishes times out, and the next call tries again', async () => {
    vi.useFakeTimers();
    const createDocument = vi.fn<() => Promise<void>>().mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValue(undefined);
    const { parse } = setup({ offscreen: { createDocument, closeDocument: async () => undefined } });
    const outcome = parse(html).then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(PdfReadError);
    expect((error as PdfReadError).reason).toBe('timeout');
    await expect(parse(html)).resolves.toEqual(RESULT);
    expect(createDocument).toHaveBeenCalledTimes(2);
  });

  test('when one reply times out, every request in flight rejects with the same timeout error and the document is closed once', async () => {
    vi.useFakeTimers();
    const closeDocument = vi.fn(async () => undefined);
    const sendMessage = vi.fn((): Promise<unknown> => new Promise(() => undefined));
    const { parse } = setup({ offscreen: { createDocument: async () => undefined, closeDocument }, sendMessage });
    const settle = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e);
    const first = settle(parse(html));
    await vi.advanceTimersByTimeAsync(10_000);
    const second = settle(parse(html));
    await vi.advanceTimersByTimeAsync(REPLY_LIMIT - 10_000);
    const errors = [await first, await second];
    for (const error of errors) {
      expect(error).toBeInstanceOf(PdfReadError);
      expect((error as PdfReadError).reason).toBe('timeout');
      expect((error as PdfReadError).message).toBe('Reading this paper took too long');
    }
    expect(closeDocument).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REPLY_LIMIT);
    expect(closeDocument).toHaveBeenCalledTimes(2); // only the idle close that follows
  });

  test('a close that fails after a timeout does not hide the timeout error', async () => {
    vi.useFakeTimers();
    const closeDocument = vi.fn(async () => {
      throw new Error('No current offscreen document.');
    });
    const { parse } = setup({ offscreen: { createDocument: async () => undefined, closeDocument }, sendMessage: () => new Promise(() => undefined) });
    const outcome = parse(html).then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REPLY_LIMIT);
    expect(((await outcome) as PdfReadError).reason).toBe('timeout');
  });
});
