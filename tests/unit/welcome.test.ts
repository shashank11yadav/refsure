import { beforeEach, describe, expect, test, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const listeners: ((details: { reason: string }) => void)[] = [];
  return {
    listeners,
    tabsCreate: vi.fn(),
    startBackground: vi.fn(),
    browser: {
      runtime: { id: 'ext-id', getURL: (path: string) => `chrome-extension://ext-id${path}`, onInstalled: { addListener: (l: (d: { reason: string }) => void) => void listeners.push(l) } },
      tabs: { create: undefined as unknown },
    },
  };
});
mock.browser.tabs.create = mock.tabsCreate;

vi.mock('wxt/browser', () => ({ browser: mock.browser }));
vi.mock('../../src/background/hub', () => ({ startBackground: mock.startBackground }));

import background from '../../src/entrypoints/background';

beforeEach(() => {
  mock.listeners.length = 0;
  mock.tabsCreate.mockReset().mockResolvedValue({});
  mock.startBackground.mockReset();
});

describe('background entrypoint', () => {
  test('starts the hub and registers an install listener synchronously', () => {
    background.main();
    expect(mock.startBackground).toHaveBeenCalledTimes(1);
    expect(mock.listeners).toHaveLength(1);
  });

  test('opens the welcome page on a fresh install', () => {
    background.main();
    mock.listeners[0]?.({ reason: 'install' });
    expect(mock.tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://ext-id/welcome.html' });
  });

  test.each(['update', 'chrome_update', 'browser_update', 'shared_module_update'])('does not open it on %s', (reason) => {
    background.main();
    mock.listeners[0]?.({ reason });
    expect(mock.tabsCreate).not.toHaveBeenCalled();
  });

  test('a tab that cannot be opened is not an error', async () => {
    mock.tabsCreate.mockRejectedValue(new Error('no window'));
    background.main();
    expect(() => mock.listeners[0]?.({ reason: 'install' })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
