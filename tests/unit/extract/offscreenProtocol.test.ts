import { describe, expect, test } from 'vitest';
import {
  OFFSCREEN_TARGET,
  base64ToBytes,
  bytesToBase64,
  failure,
  isFromOwnBackground,
  readWireRequest,
  readWireResponse,
  toWireRequest,
} from '../../../src/extract/offscreenProtocol';
import { PdfReadError } from '../../../src/extract/readError';

describe('base64 transport', () => {
  test('every byte value survives a round trip', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test('a large buffer survives and is encoded in linear time', () => {
    const bytes = new Uint8Array(20 * 1024 * 1024).map((_, i) => (i * 31) % 251);
    const started = performance.now();
    const back = base64ToBytes(bytesToBase64(bytes));
    expect(back?.length).toBe(bytes.length);
    expect(back?.[1_000_003]).toBe(bytes[1_000_003]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test('empty input and damaged text', () => {
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
    expect(base64ToBytes('not base64 !!')).toBeUndefined();
  });
});

describe('requests', () => {
  test('an HTML request becomes a tagged message and reads back', () => {
    const wire = toWireRequest({ kind: 'arxiv-html-text', html: '<p>x</p>' });
    expect(wire).toEqual({ target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html: '<p>x</p>' });
    expect(readWireRequest(JSON.parse(JSON.stringify(wire)))).toEqual(wire);
  });

  test('a PDF request carries its bytes as text and survives JSON, which is how Chrome sends messages', () => {
    const data = Uint8Array.from([37, 80, 68, 70, 0, 255]).buffer;
    const wire = toWireRequest({ kind: 'pdf', data });
    const arrived = readWireRequest(JSON.parse(JSON.stringify(wire)));
    expect(arrived).toMatchObject({ kind: 'pdf' });
    expect(arrived?.kind === 'pdf' && base64ToBytes(arrived.dataBase64)).toEqual(new Uint8Array(data));
  });

  test.each([
    ['null', null],
    ['a string', 'parse'],
    ['an array', []],
    ['no target', { type: 'parse', kind: 'arxiv-html-text', html: '' }],
    ['another target', { target: 'someone-else', type: 'parse', kind: 'arxiv-html-text', html: '' }],
    ['another type', { target: OFFSCREEN_TARGET, type: 'fetch', kind: 'arxiv-html-text', html: '' }],
    ['unknown kind', { target: OFFSCREEN_TARGET, type: 'parse', kind: 'script', html: '' }],
    ['html that is not text', { target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html: { a: 1 } }],
    ['a pdf with no data', { target: OFFSCREEN_TARGET, type: 'parse', kind: 'pdf' }],
    ['a pdf with a buffer instead of text', { target: OFFSCREEN_TARGET, type: 'parse', kind: 'pdf', dataBase64: new ArrayBuffer(4) }],
    ['oversized html', { target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html: 'x'.repeat(10 * 1024 * 1024 + 1) }],
    ['oversized pdf data', { target: OFFSCREEN_TARGET, type: 'parse', kind: 'pdf', dataBase64: 'A'.repeat(41 * 1024 * 1024) }],
  ])('%s is dropped', (_name, message) => {
    expect(readWireRequest(message)).toBeUndefined();
  });

  test('extra fields are not passed on', () => {
    const read = readWireRequest({ target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html: 'x', url: 'https://evil.example', __proto__: { a: 1 } });
    expect(read).toEqual({ target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html: 'x' });
  });
});

describe('isFromOwnBackground', () => {
  const base = 'chrome-extension://abc/';
  test.each([
    ['our background', { id: 'abc', url: 'chrome-extension://abc/background.js' }, true],
    ['our id but no url', { id: 'abc' }, false],
    ['another extension', { id: 'xyz', url: 'chrome-extension://xyz/b.js' }, false],
    ['no id (a web page)', { url: 'https://arxiv.org/html/1' }, false],
    ['our content script (it carries a tab)', { id: 'abc', tab: { id: 1 }, url: 'https://arxiv.org/html/1' }, false],
    ['our id but a web url', { id: 'abc', url: 'https://evil.example/' }, false],
    ['a look-alike extension url', { id: 'abc', url: 'chrome-extension://abcd/x.js' }, false],
  ])('%s', (_name, sender, expected) => {
    expect(isFromOwnBackground(sender, 'abc', base)).toBe(expected);
  });
});

describe('responses', () => {
  const ok = { ok: true, refs: [{ index: 1, label: '[1]', text: 'A. Author. Title. 2020.' }, { index: 2, label: '[2]', text: 'B', blocks: ['B'], anchorId: 'bib.bib2' }], confidence: 0.9 };

  test('a good reply reads back', () => {
    expect(readWireResponse(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    const partial = { ok: true, refs: [{ index: 1, label: '[1]', text: 'A. Author. Title. 2020.', partial: true }], confidence: 0.9 };
    expect(readWireResponse(JSON.parse(JSON.stringify(partial)))).toEqual(partial);
    expect(readWireResponse({ ok: true, refs: [], confidence: 0 })).toEqual({ ok: true, refs: [], confidence: 0 });
  });

  test('an error reply is kept short', () => {
    expect(readWireResponse({ ok: false, error: 'x'.repeat(5000) })).toEqual({ ok: false, error: 'x'.repeat(200) });
    expect(failure(new Error('boom'))).toEqual({ ok: false, error: 'boom' });
    expect(failure('weird')).toEqual({ ok: false, error: 'Could not read this paper' });
  });

  test('a failure to read the paper keeps its reason, so the background can show its message', () => {
    const password = failure(new PdfReadError('This PDF is password protected', 'password'));
    expect(password).toEqual({ ok: false, error: 'This PDF is password protected', reason: 'password' });
    expect(readWireResponse(JSON.parse(JSON.stringify(password)))).toEqual(password);
    for (const reason of ['invalid', 'password', 'timeout']) expect(readWireResponse({ ok: false, error: 'x', reason })).toEqual({ ok: false, error: 'x', reason });
    // Any other error carries no reason: its text is not written to be shown.
    expect(failure(new Error('boom'))).not.toHaveProperty('reason');
    expect(readWireResponse({ ok: false, error: 'x' })).not.toHaveProperty('reason');
  });

  test.each([
    ['null', null],
    ['no ok flag', { refs: [], confidence: 0 }],
    ['refs not an array', { ok: true, refs: 'x', confidence: 0 }],
    ['confidence missing', { ok: true, refs: [] }],
    ['confidence above 1', { ok: true, refs: [], confidence: 1.5 }],
    ['confidence NaN', { ok: true, refs: [], confidence: Number.NaN }],
    ['an entry that is not an object', { ok: true, refs: ['text'], confidence: 1 }],
    ['an index out of order', { ok: true, refs: [{ index: 2, label: '[2]', text: 'x' }], confidence: 1 }],
    ['text that is not a string', { ok: true, refs: [{ index: 1, label: '[1]', text: 5 }], confidence: 1 }],
    ['text that is too long', { ok: true, refs: [{ index: 1, label: '[1]', text: 'x'.repeat(5001) }], confidence: 1 }],
    ['blocks that are not strings', { ok: true, refs: [{ index: 1, label: '[1]', text: 'x', blocks: [1] }], confidence: 1 }],
    ['an anchor that is not text', { ok: true, refs: [{ index: 1, label: '[1]', text: 'x', anchorId: {} }], confidence: 1 }],
    ['an anchor with characters a page id never has', { ok: true, refs: [{ index: 1, label: '[1]', text: 'x', anchorId: 'bib bib1"><img>' }], confidence: 1 }],
    ['an empty anchor', { ok: true, refs: [{ index: 1, label: '[1]', text: 'x', anchorId: '' }], confidence: 1 }],
    ['a partial mark that is not true', { ok: true, refs: [{ index: 1, label: '[1]', text: 'x', partial: 'yes' }], confidence: 1 }],
    ['a partial mark that is false', { ok: true, refs: [{ index: 1, label: '[1]', text: 'x', partial: false }], confidence: 1 }],
    ['too many entries', { ok: true, refs: Array.from({ length: 2001 }, (_, i) => ({ index: i + 1, label: 'l', text: 't' })), confidence: 1 }],
    ['an error that is not text', { ok: false, error: 5 }],
    ['an unknown reason', { ok: false, error: 'x', reason: 'other' }],
    ['a reason that is not text', { ok: false, error: 'x', reason: 1 }],
  ])('%s is rejected', (_name, reply) => {
    expect(readWireResponse(reply)).toBeUndefined();
  });
});
