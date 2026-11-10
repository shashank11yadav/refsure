// The side panel page (Chrome and Edge side panel, Firefox sidebar): wires the real browser to the panel
// controller in src/ui/panel.ts. No `runtime.onMessage` listener here, on purpose: the background's
// events arrive over the port, so broadcasts meant for other pages are never seen by this one.
import { browser } from 'wxt/browser';
import { getSettings, updateSettings } from '../../engine/settings';
import { PANEL_PORT_NAME } from '../../messaging';
import { createPanel } from '../../ui/panel';
import '../../ui/theme.css';
import './style.css';

const app = document.getElementById('app');

if (app !== null) {
  const panel = createPanel({
    doc: document,
    root: app,
    connect: () => browser.runtime.connect({ name: PANEL_PORT_NAME }),
    send: (message) => browser.runtime.sendMessage(message) as Promise<unknown>,
    sendToTab: (tabId, message) => browser.tabs.sendMessage(tabId, message, { frameId: 0 }) as Promise<unknown>,
    activeTab: async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return tab?.id === undefined ? undefined : { id: tab.id, url: tab.url, title: tab.title };
    },
    settings: { get: getSettings, update: updateSettings },
    clipboard: typeof navigator.clipboard === 'object' ? navigator.clipboard : undefined,
    schedule: (cb) => void window.requestAnimationFrame(() => cb()),
  });

  const refresh = (): void => void panel.refreshActiveTab();
  browser.tabs.onActivated.addListener(refresh);
  // A page finished loading, or the address changed, in the tab being looked at.
  browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.status === 'complete' || changeInfo.url !== undefined)) refresh();
  });
  browser.tabs.onRemoved.addListener((tabId) => panel.forgetTab(tabId));
  // The panel can sit hidden for a long time (Firefox keeps the sidebar page alive): look again when it is shown.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  void panel.start();
}
