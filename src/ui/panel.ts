// The side panel: one controller that listens to the background's port, remembers each tab's check,
// and draws only the check that belongs to the paper the active tab is showing.
//
// Rules this file keeps:
//  * It does everything through `PanelDeps`, so it never touches `browser.*` itself and is testable.
//  * It registers no listener for broadcast runtime messages. Events reach it over its port only, so a broadcast
//    meant for another page (an offscreen parse request can be tens of MB) is never seen, let alone answered.
//  * Results are shown only when their paper key matches the active tab's current paper key.
//  * A dropped port while a check runs is shown as "Check interrupted. Press Re-check to start again."; the port is
//    reconnected when the user acts (and quietly when the tab changes).
//  * All text is set with text nodes or `textContent`; the one `<textarea>` gets its text as `.value`.

import { toCsv, toJson, toPlainTextReport, type ReportOptions } from '../core/report';
import { completionMessage, countStatuses, sortProblemsFirst } from '../core/status';
import type { CheckResult, CheckSummary, PaperInfo, SourceName } from '../core/types';
import type { Settings } from '../engine/settings';
import { detectPage, type PageKind } from '../extract/pageDetect';
import { isBackgroundReply, isBackgroundToPanel, type BackgroundToPanel, type CheckErrorCode, type PanelToBackground, type PanelToContent, type StopReason } from '../messaging';
import { activeBlocks, bannerFor, blockedNotice, INTERRUPTED_TEXT, limitedNotice, renderBanner, servicesDownText, unreachableNotice, unreachableSources, type BannerAction, type SourceBlock } from './banner';
import { button, clip, el } from './dom';
import { downloadText, safeFileName } from './exportFile';
import { renderFilters, type Filter } from './filters';
import { renderRow } from './resultRow';
import { renderSettingsView, type SettingsApi } from './settingsView';
import { renderHeader } from './summary';
import { readyTitle, usableTabTitle } from './title';

export interface PortLike {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  disconnect(): void;
}

export interface ActiveTab {
  id: number;
  /** Visible only for arxiv.org and openreview.net (host permissions); undefined everywhere else. */
  url?: string | undefined;
  title?: string | undefined;
}

export interface PanelDeps {
  doc: Document;
  root: HTMLElement;
  connect(): PortLike;
  send(message: PanelToBackground): Promise<unknown>;
  sendToTab(tabId: number, message: PanelToContent): Promise<unknown>;
  activeTab(): Promise<ActiveTab | undefined>;
  settings: { get(): Promise<Settings>; update(patch: Partial<Settings>): Promise<Settings> };
  clipboard?: { writeText(text: string): Promise<void> } | undefined;
  /** Saves a text file; the default is `downloadText`. */
  download?: (filename: string, mime: string, content: string) => void;
  /** Runs `cb` soon, once per burst of events; `requestAnimationFrame` in the browser. */
  schedule: (cb: () => void) => void;
}

export interface Panel {
  start(): Promise<void>;
  /** Re-reads which tab is active; call on tab switches and page loads. */
  refreshActiveTab(): Promise<void>;
  /** Drops what was kept for a closed tab. */
  forgetTab(tabId: number): void;
}

type Phase = 'checking' | 'done' | 'error' | 'interrupted' | 'stopped';

interface RunView {
  paperKey: string | undefined;
  paper?: PaperInfo;
  total: number;
  results: Map<number, CheckResult>;
  summary?: CheckSummary;
  phase: Phase;
  error?: { code: CheckErrorCode; message: string };
  savedAt?: number;
  /**
   * A check the user just asked for here: its results and its end are ignored until a `check:started` arrives.
   * That cannot tell a replayed older `check:started` from the new one; the guard only keeps a replayed
   * result or end from landing on the placeholder first.
   */
  awaitingStart?: boolean;
  /** True when this run's `check:started` arrived live (not replayed): the run began while the panel was listening. */
  startedLive?: boolean;
  /** Sources that ran out of lookups during this run, in the order it was told. */
  limited?: SourceName[];
  /** Sources that asked RefSure to wait during this run, each with the latest time it was told. */
  blocked?: SourceBlock[];
  /** Why a stopped run stopped: the user's Stop, or the lookup services not answering. */
  stopReason?: StopReason;
  startedAt?: number;
  stoppedAt?: number;
}

interface Active {
  tabId: number;
  paperKey: string | undefined;
  kind: PageKind;
  title: string | undefined;
}

const TOAST_MS = 4000;
const FLASH_MS = 2000;
/** How long a badge click waits for its tab and row to be known: the click may have opened the panel itself. */
const BADGE_CLICK_WAIT_MS = 10_000;
const MAX_TITLE_CHARS = 300;

export function createPanel(deps: PanelDeps): Panel {
  const { doc, root } = deps;
  const download = deps.download ?? ((name: string, mime: string, content: string) => downloadText(doc, name, mime, content));

  const views = new Map<number, RunView>();
  const historyAsked = new Set<string>();
  let active: Active | undefined;
  let port: PortLike | undefined;
  let refreshSeq = 0;
  let filter: Filter = 'all';
  const expanded = new Set<number>();
  let flashIndex: number | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let waitingBadge: { tabId: number; index: number; at: number } | undefined;
  let blockTimer: ReturnType<typeof setTimeout> | undefined;
  let screen: 'results' | 'settings' = 'results';
  let settingsEl: HTMLElement | undefined;
  let toastText = '';
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let announcement = '';
  let reportFallback: string | undefined;
  let pending = false;
  let rowCache = new Map<number, { result: CheckResult; expanded: boolean; flash: boolean; canScroll: boolean; node: HTMLLIElement }>();
  let rowCacheOwner: RunView | undefined;

  // ---------------------------------------------------------------------------- frame

  const settingsBtn = button(doc, 'Settings', () => void openSettings(), { class: 'btn quiet', 'data-fk': 'settings' });
  const announcer = el(doc, 'div', { class: 'announcer sr-only', 'aria-live': 'polite', role: 'status' });
  const toast = el(doc, 'div', { class: 'toast', role: 'status' });
  const main = el(doc, 'main', { class: 'content' });
  root.replaceChildren(el(doc, 'header', { class: 'topbar' }, el(doc, 'span', { class: 'brand' }, 'RefSure'), settingsBtn), announcer, toast, main);

  // ---------------------------------------------------------------------------- state helpers

  function currentView(): RunView | undefined {
    if (active?.paperKey === undefined) return undefined;
    const view = views.get(active.tabId);
    return view !== undefined && view.paperKey === active.paperKey ? view : undefined;
  }

  function requestRender(): void {
    if (pending) return;
    pending = true;
    deps.schedule(() => {
      pending = false;
      render();
    });
  }

  function say(message: string): void {
    toastText = message;
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastText = '';
      requestRender();
    }, TOAST_MS);
    requestRender();
  }

  // ---------------------------------------------------------------------------- the port

  function ensurePort(): void {
    if (port !== undefined) return;
    let connected: PortLike;
    try {
      connected = deps.connect();
    } catch {
      // The background is not reachable right now; acting again tries again.
      return;
    }
    port = connected;
    connected.onMessage.addListener(onPortMessage);
    connected.onDisconnect.addListener(() => {
      if (port !== connected) return;
      port = undefined;
      // Whatever was running died with the background's memory: say so instead of waiting for events.
      for (const view of views.values()) if (view.phase === 'checking') view.phase = 'interrupted';
      requestRender();
    });
  }

  function onPortMessage(raw: unknown): void {
    if (!isBackgroundToPanel(raw)) return;
    handleEvent(raw);
  }

  function handleEvent(event: BackgroundToPanel): void {
    switch (event.type) {
      case 'check:started': {
        const view: RunView = { paperKey: event.paper.key, paper: event.paper, total: event.total, results: new Map(), phase: 'checking', startedLive: event.replayed !== true, startedAt: Date.now() };
        views.set(event.tabId, view);
        historyAsked.delete(`${event.tabId}:${event.paper.key}`);
        if (event.tabId === active?.tabId) {
          filter = 'all';
          expanded.clear();
          announcement = '';
          reportFallback = undefined;
          // A start the panel watched is news for a screen reader; a replayed one is history.
          if (event.replayed !== true && event.total > 0) announcement = `Checking ${event.total} ${event.total === 1 ? 'reference' : 'references'}. Results appear as they arrive.`;
        }
        break;
      }
      case 'check:limited': {
        const view = views.get(event.tabId);
        if (view === undefined || view.phase === 'error' || view.awaitingStart === true || view.paperKey !== event.paperKey) return;
        const seen = view.limited ?? [];
        if (!seen.includes(event.source)) view.limited = [...seen, event.source];
        break;
      }
      case 'check:blocked': {
        const view = views.get(event.tabId);
        if (view === undefined || view.phase === 'error' || view.awaitingStart === true || view.paperKey !== event.paperKey) return;
        const block = { source: event.source, until: event.until };
        const seen = view.blocked ?? [];
        // A later end replaces an earlier one, never the other way round.
        view.blocked = seen.some((b) => b.source === event.source) ? seen.map((b) => (b.source === event.source && b.until < block.until ? block : b)) : [...seen, block];
        break;
      }
      case 'check:stopped': {
        const view = views.get(event.tabId);
        if (view === undefined || view.phase !== 'checking' || view.awaitingStart === true || view.paperKey !== event.paperKey) return;
        view.phase = 'stopped';
        view.stopReason = event.reason;
        view.stoppedAt = Date.now();
        if (event.reason === 'services-down' && event.replayed !== true && event.tabId === active?.tabId && view.paperKey === active.paperKey) announcement = servicesDownText(view.blocked ?? []);
        break;
      }
      case 'check:result': {
        const view = views.get(event.tabId);
        if (view === undefined || view.phase !== 'checking' || view.awaitingStart === true || view.paperKey !== event.paperKey) return;
        view.results.set(event.result.index, event.result);
        break;
      }
      case 'check:done': {
        const view = views.get(event.tabId);
        if (view === undefined || view.phase !== 'checking' || view.awaitingStart === true || view.paperKey !== event.summary.paper.key) return;
        view.phase = 'done';
        view.summary = event.summary;
        view.paper = event.summary.paper;
        // A run that was already going when the panel connected has a replayed start but a live end: that is news.
        // A finished run replayed in full is history and is shown quietly.
        const news = event.replayed !== true || view.startedLive === true;
        if (news && event.tabId === active?.tabId && view.paperKey === active.paperKey) announcement = completionMessage(event.summary.counts);
        break;
      }
      case 'check:error':
        views.set(event.tabId, { paperKey: event.paperKey, total: 0, results: new Map(), phase: 'error', error: { code: event.code, message: event.message } });
        // The banner appears silently; say it once for a screen reader, unless it is only history.
        if (event.replayed !== true && event.tabId === active?.tabId && event.paperKey !== undefined && event.paperKey === active.paperKey) {
          announcement = bannerFor(event.code, event.message).text;
        }
        break;
      case 'badge:clicked':
        // A click in another tab is not for this panel. One in its tab can arrive before the saved check is read back.
        if (active !== undefined && event.tabId !== active.tabId) return;
        waitingBadge = { tabId: event.tabId, index: event.index, at: Date.now() };
        showWaitingRow();
        return;
    }
    requestRender();
  }

  /** Shows the row of a recent badge click once its tab is the active one and the row is there. */
  function showWaitingRow(): void {
    const waiting = waitingBadge;
    if (waiting === undefined) return;
    if (Date.now() - waiting.at > BADGE_CLICK_WAIT_MS) {
      waitingBadge = undefined;
      return;
    }
    if (waiting.tabId !== active?.tabId || currentView()?.results.has(waiting.index) !== true) return;
    waitingBadge = undefined;
    showRow(waiting.index);
  }

  /** A badge on the page was clicked: open that row, make sure a filter is not hiding it, and outline it briefly. */
  function showRow(index: number): void {
    const view = currentView();
    const row = view?.results.get(index);
    if (view === undefined || row === undefined) return;
    expanded.add(index);
    if (filter !== 'all' && row.status !== filter) filter = 'all';
    flashIndex = index;
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashIndex = undefined;
      requestRender();
    }, FLASH_MS);
    screen = 'results';
    settingsEl = undefined;
    render();
    const node = main.querySelector<HTMLElement>(`li.row[data-index="${index}"]`);
    const reduced = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }

  // ---------------------------------------------------------------------------- active tab

  async function refreshActiveTab(): Promise<void> {
    const seq = ++refreshSeq;
    let tab: ActiveTab | undefined;
    try {
      tab = await deps.activeTab();
    } catch {
      tab = undefined;
    }
    // A newer question was asked while this one was being answered: its answer is the current one.
    if (seq !== refreshSeq) return;
    const previous = active;
    if (tab === undefined) {
      active = undefined;
    } else {
      const page = tab.url === undefined ? undefined : detectPage(tab.url);
      active = { tabId: tab.id, paperKey: page?.paperKey, kind: page?.kind ?? 'unsupported', title: tab.title };
    }
    // Leaving a paper ends its run in the background without a word, so a run still "checking" for another
    // paper than the one in this tab is dead: forget it, or it would come back frozen on returning.
    if (active !== undefined) {
      const view = views.get(active.tabId);
      if (view?.phase === 'checking' && view.paperKey !== active.paperKey) views.delete(active.tabId);
    }
    if (previous?.tabId !== active?.tabId || previous?.paperKey !== active?.paperKey) {
      filter = 'all';
      expanded.clear();
      reportFallback = undefined;
      announcement = '';
    }
    ensurePort();
    render();
    showWaitingRow();
    if (active?.paperKey !== undefined && currentView() === undefined) void loadHistory(active.tabId, active.paperKey);
  }

  async function loadHistory(tabId: number, paperKey: string): Promise<void> {
    const asked = `${tabId}:${paperKey}`;
    if (historyAsked.has(asked)) return;
    historyAsked.add(asked);
    let reply: unknown;
    try {
      reply = await deps.send({ type: 'history:get', paperKey });
    } catch {
      return;
    }
    if (!isBackgroundReply(reply) || !reply.ok || reply.saved === undefined || reply.saved === null) return;
    const { summary, results } = reply.saved;
    // The tab may have moved on, or a live run may have started, while the answer was on its way.
    if (summary.paper.key !== paperKey || active?.tabId !== tabId || active.paperKey !== paperKey || currentView() !== undefined) return;
    views.set(tabId, {
      paperKey,
      paper: summary.paper,
      total: summary.total,
      results: new Map(results.map((r) => [r.index, r])),
      summary,
      phase: 'done',
      savedAt: summary.finishedAt ?? summary.startedAt,
    });
    requestRender();
    showWaitingRow();
  }

  // ---------------------------------------------------------------------------- commands

  async function startCheck(): Promise<void> {
    if (active?.paperKey === undefined) return;
    const { tabId, paperKey } = active;
    ensurePort();
    views.set(tabId, { paperKey, total: 0, results: new Map(), phase: 'checking', awaitingStart: true });
    filter = 'all';
    expanded.clear();
    announcement = '';
    reportFallback = undefined;
    screen = 'results';
    settingsEl = undefined;
    render();
    let reply: unknown;
    try {
      reply = await deps.send({ type: 'check:start', tabId });
    } catch {
      reply = undefined;
    }
    if (isBackgroundReply(reply) && reply.ok) return;
    const message = isBackgroundReply(reply) && !reply.ok ? reply.error : '';
    views.set(tabId, { paperKey, total: 0, results: new Map(), phase: 'error', error: { code: 'fetch-failed', message } });
    requestRender();
  }

  function stopCheck(): void {
    const view = currentView();
    if (active === undefined || view === undefined) return;
    void deps.send({ type: 'check:cancel', tabId: active.tabId }).catch(() => undefined);
    // The background says nothing more about a cancelled run, so the panel records it itself.
    if (view.phase === 'checking') {
      view.phase = 'stopped';
      view.stopReason = 'user';
      view.stoppedAt = Date.now();
    }
    requestRender();
  }

  function selectRow(index: number): void {
    if (active === undefined) return;
    void Promise.resolve(deps.sendToTab(active.tabId, { type: 'ref:scrollTo', index })).catch(() => undefined);
  }

  function toggleRow(index: number): void {
    if (!expanded.delete(index)) expanded.add(index);
    requestRender();
  }

  /** What can be saved or copied: a finished check, or what a stopped one found, marked as partial. */
  function finished(): { summary: CheckSummary; results: CheckResult[]; partial?: { stoppedAfter: number; total: number } } | undefined {
    const view = currentView();
    if (view === undefined) return undefined;
    const results = [...view.results.values()];
    if (view.phase === 'done' && view.summary !== undefined) return { summary: view.summary, results };
    // A run that was cut off (by Stop, by the services, or by the background going away) can still be saved as partial.
    if ((view.phase !== 'stopped' && view.phase !== 'interrupted') || view.paper === undefined || results.length === 0) return undefined;
    const summary: CheckSummary = {
      paper: view.paper,
      counts: countStatuses(results),
      total: view.total,
      startedAt: view.startedAt ?? Date.now(),
      finishedAt: view.stoppedAt ?? Date.now(),
      beta: view.paper.viaPdf,
    };
    return { summary, results, partial: { stoppedAfter: results.length, total: view.total } };
  }

  function reportOptions(partial: { stoppedAfter: number; total: number } | undefined): ReportOptions {
    return partial === undefined ? {} : { stoppedAfter: { checked: partial.stoppedAfter, total: partial.total } };
  }

  async function copyReport(): Promise<void> {
    const done = finished();
    if (done === undefined) return;
    const report = toPlainTextReport(done.summary, done.results, reportOptions(done.partial));
    try {
      if (deps.clipboard === undefined) throw new Error('no clipboard');
      await deps.clipboard.writeText(report);
      reportFallback = undefined;
      say('Report copied.');
    } catch {
      // The clipboard can be refused (no permission, no focus): show the text to copy by hand.
      reportFallback = report;
      render();
      const box = main.querySelector<HTMLTextAreaElement>('textarea.report-box');
      box?.focus();
      box?.select();
    }
  }

  function exportAs(kind: 'csv' | 'json'): void {
    const done = finished();
    if (done === undefined) return;
    const name = safeFileName(done.partial === undefined ? done.summary.paper.key : `${done.summary.paper.key}-partial`, kind);
    if (kind === 'csv') download(name, 'text/csv', toCsv(done.results));
    else download(name, 'application/json', toJson(done.summary, done.results, reportOptions(done.partial)));
    say(`${kind === 'csv' ? 'CSV' : 'JSON'} file saved.`);
  }

  const settingsApi: SettingsApi = {
    get: () => deps.settings.get(),
    update: (patch) => deps.settings.update(patch),
    clearHistory: async () => {
      try {
        const reply = await deps.send({ type: 'history:clear' });
        if (!isBackgroundReply(reply) || !reply.ok) return false;
      } catch {
        return false;
      }
      // What the panel still holds of finished checks is a copy of what was just deleted.
      for (const [tabId, view] of [...views]) if (view.phase !== 'checking') views.delete(tabId);
      historyAsked.clear();
      requestRender();
      return true;
    },
  };

  async function openSettings(): Promise<void> {
    let settings: Settings;
    try {
      settings = await deps.settings.get();
    } catch {
      say("Couldn't read the settings. Try again.");
      return;
    }
    settingsEl = renderSettingsView(doc, {
      settings,
      api: settingsApi,
      notify: say,
      onBack: () => {
        screen = 'results';
        settingsEl = undefined;
        render();
        settingsBtn.focus();
      },
    });
    screen = 'settings';
    render();
    settingsEl.querySelector<HTMLElement>('.back')?.focus();
  }

  // ---------------------------------------------------------------------------- drawing

  /** A handle on the focused control, so a redraw can put the focus back on its replacement. */
  function focusKey(): string | undefined {
    const focused = doc.activeElement as HTMLElement | null;
    if (focused === null || !root.contains(focused)) return undefined;
    const fk = focused.getAttribute('data-fk');
    if (fk !== null) return fk;
    const row = focused.closest('li.row');
    return row === null ? undefined : `row:${row.getAttribute('data-index')}:${focused.getAttribute('class') ?? focused.tagName}`;
  }

  /** Where the focus goes when its control is gone: the nearest control that now does that job. */
  function fallbackKeys(key: string): string[] {
    if (key === 'check' || key === 'act:Re-check' || key.startsWith('banner:')) return ['act:Stop'];
    // After the run gave up by itself the obvious next step is the banner's Try again.
    if (key === 'act:Stop') return currentView()?.stopReason === 'services-down' ? ['banner:Try again', 'act:Copy report', 'act:Re-check'] : ['act:Copy report', 'act:Re-check'];
    return [];
  }

  function focusByKey(key: string): boolean {
    const node = [...root.querySelectorAll<HTMLElement>('[data-fk]')].find((candidate) => candidate.getAttribute('data-fk') === key);
    node?.focus();
    return node !== undefined;
  }

  function restoreFocus(key: string | undefined): void {
    if (key === undefined) return;
    if (focusByKey(key)) return;
    const [, index, cls] = key.split(':');
    if (key.startsWith('row:') && index !== undefined) {
      const row = root.querySelector(`li.row[data-index="${index}"]`);
      const same = [...(row?.querySelectorAll<HTMLElement>('button, a') ?? [])].find((node) => (node.getAttribute('class') ?? node.tagName) === cls);
      if (same !== undefined) {
        same.focus();
        return;
      }
    }
    if (fallbackKeys(key).some(focusByKey)) return;
    // Nothing that did this job is left: the heading of what is on screen, so the next Tab starts from there.
    const heading = main.querySelector<HTMLElement>('h1');
    if (heading !== null) {
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    }
  }

  function render(): void {
    const key = focusKey();
    // Written only when it changed: rewriting a live region makes a screen reader say it again.
    if (toast.textContent !== toastText) toast.textContent = toastText;
    if (announcer.textContent !== announcement) announcer.textContent = announcement;
    settingsBtn.hidden = screen === 'settings';
    if (screen === 'settings' && settingsEl !== undefined) {
      // The settings view keeps its own state (a key being typed): events must not rebuild it.
      if (settingsEl.parentNode !== main) main.replaceChildren(settingsEl);
      return;
    }
    main.replaceChildren(...mainNodes());
    restoreFocus(key);
  }

  function mainNodes(): Node[] {
    if (active?.paperKey === undefined) return [unsupportedState()];
    const view = currentView();
    if (view === undefined) return [readyState()];
    const { phase } = view;
    if (phase === 'error') return [errorState(view)];
    return resultsState(view, phase);
  }

  function unsupportedState(): HTMLElement {
    return el(
      doc,
      'section',
      { class: 'state' },
      el(doc, 'h1', {}, 'RefSure works on arXiv and OpenReview papers'),
      el(doc, 'p', {}, 'Open a paper, then click the RefSure button in your toolbar. RefSure checks each reference against public databases and shows which ones need a look.'),
      el(doc, 'ul', { class: 'examples' }, el(doc, 'li', {}, 'An arXiv paper: arxiv.org/abs/…, with its HTML or PDF version'), el(doc, 'li', {}, 'A public OpenReview paper: openreview.net/forum?id=…')),
    );
  }

  function readyState(): HTMLElement {
    const title = readyTitle(active?.title, active?.paperKey);
    return el(
      doc,
      'section',
      { class: 'state' },
      el(doc, 'h1', {}, 'Ready to check this paper'),
      title !== undefined && el(doc, 'p', { class: 'ready-title' }, clip(title, MAX_TITLE_CHARS)),
      el(doc, 'p', {}, 'RefSure looks up each reference in public scholarly databases and shows which ones need a look. A full paper usually takes one to two minutes; results appear as they arrive.'),
      button(doc, 'Check references', () => void startCheck(), { class: 'btn primary check-btn', 'data-fk': 'check' }),
      el(doc, 'p', { class: 'small' }, "Only this paper's reference details are sent, and only to Crossref, OpenAlex, arXiv, OpenReview and DBLP. Nothing about you is sent, apart from your own OpenAlex key if you added one, which goes only to OpenAlex."),
    );
  }

  /** The retry on a banner. The action bar's own button is Re-check; a banner never repeats it. */
  function tryAgainAction(): BannerAction {
    return { label: 'Try again', onClick: () => void startCheck() };
  }

  function errorState(view: RunView): HTMLElement {
    const error = view.error;
    if (error === undefined) return el(doc, 'div');
    const content = bannerFor(error.code, error.message);
    // The title names the screen for a screen reader and gives focus somewhere to land.
    return el(doc, 'section', { class: 'state' }, el(doc, 'h1', { class: 'paper-title' }, clip(readyTitle(active?.title, active?.paperKey) ?? 'This paper', MAX_TITLE_CHARS)), renderBanner(doc, content, content.retry ? [tryAgainAction()] : []));
  }

  function actionsBar(view: RunView): HTMLElement {
    const bar = el(doc, 'div', { class: 'actions' });
    const add = (label: string, onClick: () => void, primary = false): void => {
      bar.append(button(doc, label, onClick, { class: primary ? 'btn primary' : 'btn', 'data-fk': `act:${label}` }));
    };
    if (view.phase === 'checking') add('Stop', stopCheck);
    else {
      if (finished() !== undefined) {
        add('Copy report', () => void copyReport());
        add('Export CSV', () => exportAs('csv'));
        add('Export JSON', () => exportAs('json'));
      }
      // When the services stopped answering the banner already offers Try again; one retry button is enough.
      if (view.stopReason !== 'services-down' || view.phase !== 'stopped') add('Re-check', () => void startCheck());
    }
    return bar;
  }

  /** The paper's title. A PDF is named by its id only ("arXiv:1706.03762"); a real title from the tab reads better. */
  function headerTitle(view: RunView): string {
    const own = (view.paper?.title ?? '').trim();
    if (own !== '' && !/^arXiv:\S+$/.test(own)) return own;
    return usableTabTitle(active?.title) ?? (own !== '' ? own : (active?.title ?? '').trim());
  }

  /** The results of a run. An error has a screen of its own (errorState), so the phase here is never 'error'. */
  function resultsState(view: RunView, phase: Exclude<Phase, 'error'>): Node[] {
    const nodes: Node[] = [];
    const results = [...view.results.values()];
    const counts = view.phase === 'done' && view.summary !== undefined ? view.summary.counts : countStatuses(results);
    const title = clip(headerTitle(view), MAX_TITLE_CHARS) || 'This paper';
    nodes.push(
      renderHeader(doc, {
        ...(view.paper !== undefined && { paper: view.paper }),
        title,
        phase,
        done: results.length,
        total: view.total,
        counts,
        beta: view.summary?.beta === true || view.paper?.viaPdf === true,
        ...(view.savedAt !== undefined && { savedAt: view.savedAt }),
      }),
    );
    if (view.phase === 'interrupted') nodes.push(renderBanner(doc, { tone: 'warn', text: INTERRUPTED_TEXT }, []));
    const servicesDown = view.phase === 'stopped' && view.stopReason === 'services-down';
    // Only waits still to come: the notices change when the next one ends, so a time that has passed is never shown.
    const blocked = activeBlocks(view.blocked ?? []);
    const blockedSources = blocked.map((b) => b.source);
    redrawWhenAWaitEnds(blocked);
    if (servicesDown) nodes.push(renderBanner(doc, { tone: 'warn', text: servicesDownText(blocked) }, [tryAgainAction()]));
    else if (view.phase === 'stopped') nodes.push(renderBanner(doc, { tone: 'info', text: 'Check stopped. These are the results found so far.' }, []));
    // A source that asked to wait says until when instead of "limit reached"; a services-down stop says it in its banner.
    for (const source of view.limited ?? []) if (!blockedSources.includes(source)) nodes.push(renderBanner(doc, limitedNotice(source), []));
    if (!servicesDown) for (const block of blocked) nodes.push(renderBanner(doc, blockedNotice(block), []));
    // Once the run is over: while it is on, a source that failed for the first references may still answer later ones.
    // A services-down stop already says so, and a saved check read back from history has no such notice to show.
    if (view.phase !== 'checking' && view.savedAt === undefined && !servicesDown) {
      for (const source of unreachableSources(results, [...(view.limited ?? []), ...blockedSources])) nodes.push(renderBanner(doc, unreachableNotice(source), []));
    }
    nodes.push(actionsBar(view));
    if (reportFallback !== undefined) nodes.push(reportBox(reportFallback));

    if (results.length > 0) {
      const listCounts = countStatuses(results);
      if (filter !== 'all' && listCounts[filter] === 0) filter = 'all';
      nodes.push(renderFilters(doc, listCounts, filter, (next) => {
        filter = next;
        requestRender();
      }));
      nodes.push(list(view, results));
    } else if (view.phase === 'done') {
      nodes.push(el(doc, 'p', { class: 'empty' }, 'No references to show.'));
    }
    return nodes;
  }

  function redrawWhenAWaitEnds(blocked: readonly SourceBlock[]): void {
    if (blockTimer !== undefined) clearTimeout(blockTimer);
    blockTimer = undefined;
    if (blocked.length === 0) return;
    const next = Math.min(...blocked.map((b) => b.until));
    blockTimer = setTimeout(() => {
      blockTimer = undefined;
      requestRender();
    }, Math.max(0, next - Date.now()) + 1000);
  }

  function reportBox(report: string): HTMLElement {
    const box = el(doc, 'textarea', { class: 'report-box', readonly: true, rows: '8', 'aria-label': 'Report text, ready to copy' });
    box.value = report;
    return el(doc, 'div', { class: 'report-fallback' }, el(doc, 'p', { class: 'help' }, "Couldn't copy automatically. Select the text below and copy it."), box);
  }

  function list(view: RunView, results: CheckResult[]): HTMLElement {
    if (rowCacheOwner !== view) {
      rowCache = new Map();
      rowCacheOwner = view;
    }
    const canScroll = active?.kind === 'arxiv-html' && view.paper?.viaPdf !== true;
    const shown = sortProblemsFirst(filter === 'all' ? results : results.filter((r) => r.status === filter));
    const rows = shown.map((r) => {
      const isOpen = expanded.has(r.index);
      const flash = flashIndex === r.index;
      const cached = rowCache.get(r.index);
      if (cached !== undefined && cached.result === r && cached.expanded === isOpen && cached.flash === flash && cached.canScroll === canScroll) return cached.node;
      const node = renderRow(doc, r, { expanded: isOpen, canScroll, flash, onToggle: toggleRow, onSelect: selectRow });
      rowCache.set(r.index, { result: r, expanded: isOpen, flash, canScroll, node });
      return node;
    });
    return el(doc, 'ol', { class: 'rows', 'aria-label': 'References, problems first' }, ...rows);
  }

  // ---------------------------------------------------------------------------- start

  async function start(): Promise<void> {
    ensurePort();
    await refreshActiveTab();
    await takeBadgeClick();
  }

  /** A badge click in this tab may be what opened the panel: the background keeps it for the panel that asks. */
  async function takeBadgeClick(): Promise<void> {
    if (active === undefined) return;
    const { tabId } = active;
    let reply: unknown;
    try {
      reply = await deps.send({ type: 'badge:take', tabId });
    } catch {
      return;
    }
    if (!isBackgroundReply(reply) || !reply.ok || reply.badgeIndex === undefined) return;
    waitingBadge = { tabId, index: reply.badgeIndex, at: Date.now() };
    showWaitingRow();
  }

  return {
    start,
    refreshActiveTab,
    forgetTab(tabId: number): void {
      views.delete(tabId);
    },
  };
}
