// The background hub: toolbar click -> side panel -> check, one run per tab, and the message
// handlers that let the panel and the content scripts talk to it (SECURITY.md section 5).
//
// Rules this file keeps:
//  * Every handler starts with `isTrustedSender`; panel messages also need the side panel page itself, and
//    content messages need the arXiv HTML content script in its own tab, on the paper it names.
//  * One AbortController per tab. A new check, `page:leaving`, closing the tab, or navigating to a
//    different paper aborts the old run, and an aborted run emits nothing more. Stop ends the run but keeps
//    its rows and badges (`check:stopped`).
//  * The toolbar click always opens the panel; it starts a check only when the tab has no run for that page.
//  * A badge click on the page opens the side panel too where the browser allows it (Chrome, Edge), only for a tab
//    whose run drew badges. The click goes live to the panels that are open, and is held for the panel of that tab
//    that asks for it (badge:take) within a few seconds, once; it is never pushed to a panel that connects later.
//  * History is saved only after `runCheck` resolves, only when history is on, and with the epoch
//    read when the run started, so a "Clear history" during a run cannot be undone by it.
//  * What goes to the panel and the page is reference text, statuses and public links; never settings.

import { browser, type Browser } from 'wxt/browser';
import { runCheck, type RunSummary } from '../engine/checker';
import { clearHistory, getHistoryEpoch, getLast, saveSummary } from '../engine/history';
import { applyOpenAlexKey, getSettings, onSettingsChanged } from '../engine/settings';
import { detectPage, type PageKind } from '../extract/pageDetect';
import {
  contentSite,
  isContentToBackground,
  isPanelToBackground,
  isSidePanelPage,
  isTrustedSender,
  PANEL_PORT_NAME,
  type BackgroundReply,
  type BackgroundToContent,
  type BackgroundToPanel,
  type ContentToBackground,
  type PanelToBackground,
} from '../messaging';
import type { CheckResult } from '../core/types';
import { UrlNotAllowedError } from '../sources/http';
import { CheckFailure, loadPaper, toCheckFailure } from './loadPaper';

type Sender = Browser.runtime.MessageSender;
type Port = Browser.runtime.Port;

interface Run {
  tabId: number;
  controller: AbortController;
  /** From the tab's address, known before anything is loaded, so navigation can abort an early run. */
  paperKey: string | undefined;
  /** The kind of page the run started on: a run from an abstract page or a PDF never draws badges. */
  pageKind: PageKind | undefined;
  /** Whether results are also pushed to the page as inline badges. */
  badges: boolean;
  /** Everything sent to the panel for this run, replayed to a panel that connects later. */
  events: BackgroundToPanel[];
  /** Set when the run has ended (done, failed, or cut off): nothing more will be sent or fetched for it. */
  finished: boolean;
  /** Order in which runs finished; the newest few keep their events for replay. */
  finishedSeq: number;
}

// Chrome suspends an idle service worker after about 30 s, and a run is a long wait on the network.
// Any extension API call resets that clock, so a cheap one is made well inside it while a run is on.
const KEEPALIVE_MS = 20_000;
// A late panel is replayed the runs in progress and this many of the newest finished ones; older
// finished runs drop their events (the panel can read them back with history:get).
const MAX_REPLAYED_FINISHED = 3;

const CANT_USE_TAB = "RefSure can't use that tab any more.";
const CANT_CLEAR = "RefSure couldn't clear its saved data. Try again.";

function warn(what: string): void {
  // Fixed text only: error objects can carry addresses or keys.
  console.warn(`[RefSure] ${what}`);
}

/**
 * Chrome and Edge let content scripts read `storage.local` unless told otherwise, and a content script runs inside a
 * web page; the OpenAlex key and the check history live there. Applied at every start-up; no content script of ours
 * reads storage. Firefox has no such setting.
 */
function closeStorageToContentScripts(): void {
  const local = browser.storage.local as { setAccessLevel?: (options: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void> };
  if (typeof local.setAccessLevel !== 'function') return;
  void Promise.resolve()
    .then(() => local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }))
    .catch(() => warn('Could not close storage to content scripts'));
}

/** Chrome and Edge open the side panel for a tab, Firefox opens its sidebar. Called inside the click: it needs the gesture. */
function openPanel(tabId: number): void {
  try {
    const sidePanel = (browser as { sidePanel?: { open?: (options: { tabId: number }) => Promise<void> } }).sidePanel;
    if (typeof sidePanel?.open === 'function') {
      void Promise.resolve(sidePanel.open({ tabId })).catch(() => warn('Could not open the side panel'));
      return;
    }
    const sidebar = (browser as unknown as { sidebarAction?: { open?: () => Promise<void> } }).sidebarAction;
    if (typeof sidebar?.open === 'function') void Promise.resolve(sidebar.open()).catch(() => warn('Could not open the sidebar'));
  } catch {
    warn('Could not open the side panel');
  }
}

/**
 * A badge click on the page opens the side panel too, on Chrome and Edge: a click in a content script counts as a user
 * action there, as long as `sidePanel.open` is called while its message is handled, before any await. Firefox does not
 * count a click in a web page as one for `sidebarAction.open`, so it is not asked; there, as anywhere the open is
 * refused, the click reaches the panel only if it is already open. A refusal is the expected fallback, not worth a warning.
 */
function openPanelFromPage(tabId: number): void {
  try {
    const sidePanel = (browser as { sidePanel?: { open?: (options: { tabId: number }) => Promise<void> } }).sidePanel;
    if (typeof sidePanel?.open === 'function') void Promise.resolve(sidePanel.open({ tabId })).catch(() => undefined);
  } catch {
    // An older browser without sidePanel.open: the row opens if the panel is already open.
  }
}

/** A panel opened by a badge click asks for it a moment later; a click older than this is not handed out. */
const BADGE_CLICK_FRESH_MS = 10_000;

function applyKey(key: string | undefined): void {
  try {
    applyOpenAlexKey(key);
  } catch {
    // A key the adapter rejects must never take the background down; the free budget is used instead.
    warn('The OpenAlex key was not applied');
  }
}

export function startBackground(): void {
  closeStorageToContentScripts();
  const runs = new Map<number, Run>();
  const ports = new Set<Port>();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let finishedCount = 0;
  /** The last badge click of each tab, for the panel that the click opened (badge:take). */
  const pendingBadgeClicks = new Map<number, { index: number; at: number }>();

  function updateKeepalive(): void {
    const busy = [...runs.values()].some((run) => !run.finished);
    if (busy && keepalive === undefined) {
      keepalive = setInterval(() => {
        void Promise.resolve()
          .then(() => browser.runtime.getPlatformInfo())
          .catch(() => undefined);
      }, KEEPALIVE_MS);
    } else if (!busy && keepalive !== undefined) {
      clearInterval(keepalive);
      keepalive = undefined;
    }
  }

  function pruneFinished(): void {
    const finished = [...runs.values()].filter((run) => run.finished && run.events.length > 0).sort((a, b) => b.finishedSeq - a.finishedSeq);
    for (const old of finished.slice(MAX_REPLAYED_FINISHED)) old.events = [];
  }

  // ------------------------------------------------------------------ sending

  function toPanel(event: BackgroundToPanel): void {
    for (const port of [...ports]) {
      try {
        port.postMessage(event);
      } catch {
        ports.delete(port);
      }
    }
  }

  function emit(run: Run, event: BackgroundToPanel): void {
    // A run that was replaced, cancelled or aborted is silent from then on.
    if (runs.get(run.tabId) !== run || run.controller.signal.aborted) return;
    run.events.push(event);
    toPanel(event);
  }

  function toPage(tabId: number, message: BackgroundToContent): void {
    // The page may have no content script (or have gone); nothing depends on it.
    void Promise.resolve(browser.tabs.sendMessage(tabId, message, { frameId: 0 })).catch(() => undefined);
  }

  // ------------------------------------------------------------------ runs

  function forget(tabId: number): void {
    const run = runs.get(tabId);
    if (run === undefined) return;
    runs.delete(tabId);
    run.finished = true;
    run.controller.abort();
    if (run.badges) toPage(tabId, { type: 'badges:clear' });
    updateKeepalive();
  }

  /** The user pressed Stop: the run ends, but its rows and the badges already drawn stay until a new run or a navigation. */
  function stop(tabId: number): void {
    const run = runs.get(tabId);
    if (run === undefined || run.finished) return;
    if (run.paperKey !== undefined) emit(run, { type: 'check:stopped', tabId, paperKey: run.paperKey, reason: 'user' });
    run.finished = true;
    run.finishedSeq = ++finishedCount;
    run.controller.abort();
    pruneFinished();
    updateKeepalive();
  }

  async function execute(run: Run, tab: { url: string | undefined; title: string | undefined }): Promise<void> {
    const { tabId } = run;
    const { signal } = run.controller;
    // Read now, not when the run ends: a clear in between must win over this run's save.
    const epoch = getHistoryEpoch();
    const results: CheckResult[] = [];
    try {
      let summary: RunSummary;
      try {
        const loaded = await loadPaper({ id: tabId, url: tab.url, title: tab.title }, signal);
        run.badges = loaded.badges;
        const { paper } = loaded;
        emit(run, { type: 'check:started', tabId, paper, total: loaded.refs.length });
        summary = await runCheck({
          paper,
          refs: loaded.refs,
          signal,
          onLimited: (source) => emit(run, { type: 'check:limited', tabId, paperKey: paper.key, source }),
          onBlocked: (source, until) => emit(run, { type: 'check:blocked', tabId, paperKey: paper.key, source, until }),
          onResult: (result) => {
            results.push(result);
            emit(run, { type: 'check:result', tabId, paperKey: paper.key, result });
            if (run.badges && !signal.aborted) {
              toPage(tabId, { type: 'badges:update', paperKey: paper.key, results: [{ index: result.index, status: result.status, reason: result.reason }] });
            }
          },
        });
        if (signal.aborted) return;
        if (summary.halted !== undefined) {
          // The services stopped answering: the rows found so far stand, nothing is saved, and the panel says why.
          emit(run, { type: 'check:stopped', tabId, paperKey: paper.key, reason: 'services-down' });
          return;
        }
        emit(run, { type: 'check:done', tabId, summary });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof UrlNotAllowedError) warn('A request to an address that is not allowed was blocked');
        const failure: CheckFailure = toCheckFailure(error);
        emit(run, { type: 'check:error', tabId, code: failure.code, message: failure.message, ...(run.paperKey !== undefined && { paperKey: run.paperKey }) });
        return;
      }
      // The check is over and reported. Saving it is housekeeping: whatever goes wrong here is a log
      // line, never a check:error after check:done.
      try {
        const { historyEnabled } = await getSettings();
        // A cancel that landed while settings were read counts: an aborted run is never saved.
        if (historyEnabled && !signal.aborted) await saveSummary(summary, [...results].sort((a, b) => a.index - b.index), epoch);
      } catch {
        warn('Could not save check history');
      }
    } finally {
      run.finished = true;
      run.finishedSeq = ++finishedCount;
      pruneFinished();
      updateKeepalive();
    }
  }

  /**
   * Is the tab's run the one for the page it now shows? The same paper, except that the HTML page of a paper
   * checked from its abstract page or PDF (arXiv's own link opens it in the same tab) is a new run: that run drew
   * no badges, and only a run started on the HTML page does.
   */
  function hasRunFor(tabId: number, url: string): boolean {
    const run = runs.get(tabId);
    const page = detectPage(url);
    if (run === undefined || page.paperKey === undefined || run.paperKey !== page.paperKey) return false;
    return !(page.kind === 'arxiv-html' && run.pageKind !== 'arxiv-html');
  }

  /** Starts a check on a tab, replacing any run it had. Never rejects. */
  async function startCheck(tabId: number, tab: { url: string | undefined; title: string | undefined }): Promise<void> {
    forget(tabId);
    const run: Run = {
      tabId,
      controller: new AbortController(),
      paperKey: tab.url === undefined ? undefined : detectPage(tab.url).paperKey,
      pageKind: tab.url === undefined ? undefined : detectPage(tab.url).kind,
      badges: false,
      events: [],
      finished: false,
      finishedSeq: 0,
    };
    runs.set(tabId, run);
    updateKeepalive();
    await execute(run, tab);
  }

  // ------------------------------------------------------------------ handlers

  async function handlePanel(message: PanelToBackground): Promise<BackgroundReply> {
    switch (message.type) {
      case 'check:start': {
        let tab: Browser.tabs.Tab;
        try {
          tab = await browser.tabs.get(message.tabId);
        } catch {
          return { ok: false, error: CANT_USE_TAB };
        }
        void startCheck(message.tabId, { url: tab.url, title: tab.title });
        return { ok: true };
      }
      case 'check:cancel':
        stop(message.tabId);
        return { ok: true };
      case 'history:get':
        return { ok: true, saved: (await getLast(message.paperKey)) ?? null };
      case 'badge:take': {
        const click = pendingBadgeClicks.get(message.tabId);
        pendingBadgeClicks.delete(message.tabId);
        return click !== undefined && Date.now() - click.at <= BADGE_CLICK_FRESH_MS ? { ok: true, badgeIndex: click.index } : { ok: true };
      }
      case 'history:clear':
        // Here, not in the panel: the epoch that guards saves lives in this context.
        try {
          await clearHistory();
          // The replay buffer of finished runs is a copy of their results too.
          for (const run of runs.values()) if (run.finished) run.events = [];
          return { ok: true };
        } catch {
          return { ok: false, error: CANT_CLEAR };
        }
    }
  }

  async function autoStart(tabId: number, tab: { url: string | undefined; title: string | undefined }, wants: (s: Awaited<ReturnType<typeof getSettings>>) => boolean): Promise<void> {
    try {
      if (tab.url === undefined || !wants(await getSettings())) return;
      // The same paper reloading in the same tab is not checked again.
      if (hasRunFor(tabId, tab.url)) return;
      await startCheck(tabId, tab);
    } catch {
      // Nobody is waiting on an automatic check; if it cannot even start, the user can click Check.
      warn('Auto-check could not start');
    }
  }

  function handleContent(message: ContentToBackground, sender: Sender): void {
    const tabId = sender.tab?.id;
    const url = sender.url ?? sender.tab?.url;
    if (tabId === undefined || url === undefined || contentSite(sender) !== 'arxiv-html') return;
    const paperKey = detectPage(url).paperKey;
    switch (message.type) {
      case 'content:ready':
        if (message.paperKey === paperKey) void autoStart(tabId, { url, title: sender.tab?.title }, (s) => s.autoCheckArxiv);
        return;
      case 'page:leaving':
        if (message.paperKey === paperKey && runs.get(tabId)?.paperKey === paperKey) forget(tabId);
        return;
      case 'badge:clicked': {
        // Only for the run that drew the badges on this very page: page CSS can steer a real click onto a badge.
        const run = runs.get(tabId);
        if (run?.badges === true && paperKey !== undefined && run.paperKey === paperKey) openPanelFromPage(tabId); // synchronously: it needs the click
        // Held for its own tab even when open panels get it live: the panel this click opens may be in another window
        // than the open one. Taken once (badge:take); the live copy and the held one show the same row.
        pendingBadgeClicks.set(tabId, { index: message.index, at: Date.now() });
        toPanel({ type: 'badge:clicked', tabId, index: message.index });
        return;
      }
    }
  }

  browser.runtime.onMessage.addListener((message: unknown, sender: Sender, sendResponse: (reply: BackgroundReply) => void) => {
    if (!isTrustedSender(sender)) return false;
    if (isPanelToBackground(message)) {
      // Only the side panel itself: neither a web page's script nor another page of ours (the offscreen
      // document handles untrusted files) may start checks or clear history.
      if (!isSidePanelPage(sender)) return false;
      handlePanel(message).then(sendResponse, () => sendResponse({ ok: false, error: CANT_USE_TAB }));
      return true;
    }
    if (isContentToBackground(message)) handleContent(message, sender);
    return false;
  });

  browser.runtime.onConnect.addListener((port: Port) => {
    // Only the panel, only from the side panel page. Anything else is cut off at once.
    if (port.name !== PANEL_PORT_NAME || port.sender === undefined || !isTrustedSender(port.sender) || !isSidePanelPage(port.sender)) {
      port.disconnect();
      return;
    }
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    // The panel may open after the check began (the click opens it and starts the run together).
    // A copy marked as a replay: the stored event stays as it was sent live, and the panel does not announce history.
    for (const run of runs.values()) for (const event of run.events) port.postMessage({ ...event, replayed: true });
  });

  browser.action.onClicked.addListener((tab: Browser.tabs.Tab) => {
    if (tab.id === undefined) return;
    openPanel(tab.id); // first, synchronously: the side panel needs the user's click
    // The click shows the panel. A run for this very paper (running, finished or stopped) is left alone: the panel's
    // Re-check is the way to start over. A page with no paper key still goes through, so the panel says why.
    if (tab.url !== undefined && hasRunFor(tab.id, tab.url)) return;
    void startCheck(tab.id, { url: tab.url, title: tab.title });
  });

  browser.tabs.onRemoved.addListener((tabId: number) => {
    forget(tabId);
    pendingBadgeClicks.delete(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId: number, changeInfo: { url?: string; status?: string }, tab: Browser.tabs.Tab) => {
    const run = runs.get(tabId);
    if (run !== undefined) {
      // Leaving the two sites is invisible by address: without the tabs permission the browser withholds
      // the URL of any page outside the host permissions, so a tab that starts loading with no address
      // has left. A different paper (or a page that is not one) ends the old run; the same paper does not.
      const loading = changeInfo.status === 'loading' ? (tab.url === undefined ? '' : tab.url) : undefined;
      const address = changeInfo.url ?? loading;
      if (address !== undefined && (run.paperKey === undefined || run.paperKey !== detectPage(address).paperKey)) forget(tabId);
    }
    if (changeInfo.status !== 'complete' || tab.url === undefined) return;
    const page = detectPage(tab.url);
    const target = { url: tab.url, title: tab.title };
    if (page.kind === 'arxiv-abs') void autoStart(tabId, target, (s) => s.autoCheckArxiv);
    else if (page.kind === 'openreview' && new URL(tab.url).pathname === '/forum') void autoStart(tabId, target, (s) => s.autoCheckOpenReview);
  });

  // ------------------------------------------------------------------ the user's OpenAlex key

  getSettings().then((settings) => applyKey(settings.openAlexKey), () => undefined);
  onSettingsChanged((settings) => applyKey(settings.openAlexKey));
}
