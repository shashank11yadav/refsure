import { Window } from 'happy-dom';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { OFFSCREEN_TARGET, bytesToBase64 } from '../../../src/extract/offscreenProtocol';
import { pageBytes, pageText } from '../helpers/pages';

type Sender = { id?: string; tab?: unknown; url?: string };
type Listener = (message: unknown, sender: Sender, sendResponse: (reply: unknown) => void) => boolean;

const registered: Listener[] = [];
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'ext-id',
      getURL: (path: string) => `chrome-extension://ext-id${path}`,
      onMessage: { addListener: (l: Listener) => registered.push(l) },
    },
  },
}));

beforeAll(async () => {
  const window = new Window({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  vi.stubGlobal('DOMParser', window.DOMParser);
  await import('../../../src/entrypoints/offscreen/main');
});

const BACKGROUND: Sender = { id: 'ext-id', url: 'chrome-extension://ext-id/background.js' };

function ask(message: unknown, sender: Sender = BACKGROUND): Promise<{ handled: boolean; reply?: unknown }> {
  return new Promise((resolve) => {
    const listener = registered[0];
    if (!listener) throw new Error('main.ts registered no listener');
    const handled = listener(message, sender, (reply) => resolve({ handled: true, reply }));
    if (!handled) resolve({ handled: false });
  });
}

const html = (body: string) => ({ target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html: body });

describe('offscreen document message handler', () => {
  test('registers exactly one listener', () => {
    expect(registered).toHaveLength(1);
  });

  test('parses an HTML request from the background and replies with references', async () => {
    const { handled, reply } = await ask(html(pageText('arxiv-2402.03664v5.html')));
    expect(handled).toBe(true);
    expect(reply).toMatchObject({ ok: true, confidence: 1 });
    expect((reply as { refs: unknown[] }).refs).toHaveLength(71);
  });

  test('parses a PDF request sent as base64', async () => {
    const bytes = new Uint8Array(pageBytes('arxiv-2402.03664v5-numeric.pdf'));
    const { reply } = await ask({ target: OFFSCREEN_TARGET, type: 'parse', kind: 'pdf', dataBase64: bytesToBase64(bytes) });
    expect(reply).toMatchObject({ ok: true });
    expect((reply as { refs: unknown[] }).refs).toHaveLength(71);
  });

  test('a damaged or unreadable PDF gets a plain error reply, not a crash', async () => {
    const damaged = await ask({ target: OFFSCREEN_TARGET, type: 'parse', kind: 'pdf', dataBase64: '###' });
    expect(damaged.reply).toEqual({ ok: false, error: 'The PDF data was damaged in transit' });
    const notPdf = await ask({ target: OFFSCREEN_TARGET, type: 'parse', kind: 'pdf', dataBase64: bytesToBase64(new TextEncoder().encode('hello')) });
    expect(notPdf.reply).toEqual({ ok: false, error: 'This file could not be read as a PDF', reason: 'invalid' });
  });

  test.each([
    ['another extension', { id: 'other-ext', url: 'chrome-extension://other-ext/x.js' }],
    ['a web page', { url: 'https://arxiv.org/html/1706.03762' }],
    ['no sender details', {}],
    ['our id but no url', { id: 'ext-id' }],
    ['our own content script', { id: 'ext-id', tab: { id: 3 }, url: 'https://arxiv.org/html/1706.03762' }],
    ['our id but a web address', { id: 'ext-id', url: 'https://evil.example/' }],
  ])('ignores a valid request from %s', async (_name, sender) => {
    const { handled, reply } = await ask(html('<p>x</p>'), sender);
    expect(handled).toBe(false);
    expect(reply).toBeUndefined();
  });

  test.each([
    ['unknown shape', { hello: 'world' }],
    ['a string', 'parse'],
    ['wrong target', { ...html('x'), target: 'other' }],
    ['unknown kind', { target: OFFSCREEN_TARGET, type: 'parse', kind: 'run-script', code: 'alert(1)' }],
    ['non-text html', { ...html('x'), html: { toString: 'x' } }],
  ])('drops %s without replying', async (_name, message) => {
    const { handled } = await ask(message);
    expect(handled).toBe(false);
  });
});
