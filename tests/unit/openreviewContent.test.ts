import { beforeAll, describe, expect, test, vi } from 'vitest';
import { pageText, parseHtml } from './helpers/pages';

type Sender = { id?: string; url?: string; tab?: unknown };
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

const BACKGROUND: Sender = { id: 'ext-id', url: 'chrome-extension://ext-id/background.js' };

let content: { matches: string[]; noScriptStartedPostMessage?: boolean; main: () => void };

beforeAll(async () => {
  const doc = parseHtml(pageText('openreview-public.handmade.html'));
  Object.defineProperty(doc, 'URL', { value: 'https://openreview.net/forum?id=abc123XYZ', configurable: true });
  vi.stubGlobal('document', doc);
  content = (await import('../../src/entrypoints/openreview.content')).default as unknown as typeof content;
  content.main();
});

function ask(message: unknown, sender: Sender = BACKGROUND): Promise<{ handled: boolean; reply?: unknown }> {
  return new Promise((resolve) => {
    const listener = registered[0];
    if (!listener) throw new Error('the content script registered no listener');
    const handled = listener(message, sender, (reply) => resolve({ handled: true, reply }));
    if (!handled) resolve({ handled: false });
  });
}

describe('OpenReview content script', () => {
  test('runs only on forum pages', () => {
    expect(content.matches).toEqual(['https://openreview.net/forum*']);
  });

  // WXT otherwise posts the extension id to the page's own scripts on every load.
  test('does not announce itself to the page with a window.postMessage at start-up', () => {
    expect(content.noScriptStartedPostMessage).toBe(true);
  });

  test('registers one listener and sends nothing by itself', () => {
    expect(registered).toHaveLength(1);
  });

  test('answers openreview:read from the background with what the page shows', async () => {
    const { handled, reply } = await ask({ type: 'openreview:read' });
    expect(handled).toBe(true);
    expect(reply).toEqual({ title: 'A Handmade Public Paper', forumId: 'abc123XYZ', visibility: 'public' });
  });

  test('ignores every other message, including ones meant for the arXiv script', async () => {
    for (const message of [{ type: 'refs:extract' }, { type: 'badges:clear' }, { type: 'check:start', tabId: 1 }, null, 'openreview:read', {}]) {
      expect((await ask(message)).handled).toBe(false);
    }
  });

  test('answers the extension background even when the browser reports no sender address', async () => {
    // tabs.sendMessage from a service worker or background page does not always carry a url.
    const { handled, reply } = await ask({ type: 'openreview:read' }, { id: 'ext-id' });
    expect(handled).toBe(true);
    expect(reply).toMatchObject({ visibility: 'public' });
  });

  test('ignores senders that are not this extension, or are in a tab (a web page or another script)', async () => {
    const message = { type: 'openreview:read' };
    expect((await ask(message, { id: 'other-ext', url: 'chrome-extension://other-ext/x.html' })).handled).toBe(false);
    expect((await ask(message, { id: 'other-ext' })).handled).toBe(false);
    expect((await ask(message, { url: 'chrome-extension://ext-id/x.html' })).handled).toBe(false);
    expect((await ask(message, {})).handled).toBe(false);
    expect((await ask(message, { id: 'ext-id', url: 'https://openreview.net/forum?id=abc123XYZ', tab: { id: 1 } })).handled).toBe(false);
    expect((await ask(message, { id: 'ext-id', tab: { id: 1 } })).handled).toBe(false);
  });
});
