// Opens the welcome page once, when the extension is first installed (not on updates or browser updates).

import { browser } from 'wxt/browser';
import { extensionUrl } from '../extract/extensionUrl';

const WELCOME_PATH = '/welcome.html';

export function openWelcomeOnInstall(): void {
  browser.runtime.onInstalled.addListener((details: { reason: string }) => {
    if (details.reason !== 'install') return;
    void Promise.resolve(browser.tabs.create({ url: extensionUrl(WELCOME_PATH) })).catch(() => {
      // No window to open it in; the user can still use the toolbar button.
    });
  });
}
