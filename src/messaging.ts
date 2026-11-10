// The message protocol between the parts of the extension (SECURITY.md section 5).
//
// Four parties: the side panel, the background, and two content scripts (arXiv HTML pages,
// OpenReview forum pages). Every message is a plain object with a `type`; every receiver
// checks who sent it (`isTrustedSender`, `isExtensionPage`, `contentSite`) and then validates
// the message against the unions below before using any field. Anything that does not
// validate is dropped without an answer. Nothing here carries a secret: results and badge
// updates hold reference text, statuses and public links only.

import { browser, type Browser } from 'wxt/browser';
import { API } from './config';
import { isRecord } from './core/coerce';
import { arxivUrl, doiUrl, openreviewUrl } from './core/identifiers';
import { STATUSES as STATUS_LIST } from './core/status';
import type { CheckResult, CheckSummary, PaperInfo, RawReference, SourceName, Status } from './core/types';
import type { OpenReviewPageInfo } from './extract/openreviewPage';
import { detectPage } from './extract/pageDetect';

/** The panel connects a port with exactly this name to receive the check's events. */
export const PANEL_PORT_NAME = 'refsure-panel';

export type CheckErrorCode =
  | 'unsupported'
  | 'confidential'
  | 'visibility-unclear'
  | 'no-arxiv-version'
  | 'open-forum-page'
  | 'no-references'
  | 'offline'
  | 'fetch-failed';

export type StopReason = 'user' | 'services-down';

const STOP_REASONS: ReadonlySet<string> = new Set<StopReason>(['user', 'services-down']);
const ERROR_CODES: ReadonlySet<string> = new Set<CheckErrorCode>([
  'unsupported',
  'confidential',
  'visibility-unclear',
  'no-arxiv-version',
  'open-forum-page',
  'no-references',
  'offline',
  'fetch-failed',
]);
const STATUSES: ReadonlySet<string> = new Set<Status>(STATUS_LIST);
const ORIGINS: ReadonlySet<string> = new Set<PaperInfo['origin']>(['arxiv-html', 'arxiv-abs', 'arxiv-pdf', 'openreview']);
const SOURCES: ReadonlySet<string> = new Set(['crossref', 'openalex', 'arxiv', 'openreview', 'dblp']);

// ---------------------------------------------------------------------------- message types

/** Side panel to background, sent with `runtime.sendMessage`; the background answers with a `BackgroundReply`. */
export type PanelToBackground =
  | { type: 'check:start'; tabId: number }
  | { type: 'check:cancel'; tabId: number }
  | { type: 'history:get'; paperKey: string }
  | { type: 'history:clear' }
  /** The panel, once it knows its tab: a badge click there that opened it, if any (answered with `badgeIndex`, once). */
  | { type: 'badge:take'; tabId: number };

/**
 * Background to side panel, over the port named `PANEL_PORT_NAME`.
 *
 * Panel contract: a port disconnect while a check is running means the run was interrupted (the
 * background was suspended or restarted, and its in-memory run is gone). The panel then shows
 * "Check interrupted. Press Re-check to start again." instead of waiting for events that will not come. A panel that
 * (re)connects is replayed the runs in progress and the most recent finished ones; every event of that
 * replay carries `replayed: true` and live events never do, so the panel can tell news (announce it) from
 * history (show it quietly).
 */
export type BackgroundToPanel =
  | { type: 'check:started'; tabId: number; paper: PaperInfo; total: number; replayed?: true }
  | { type: 'check:result'; tabId: number; paperKey: string; result: CheckResult; replayed?: true }
  | { type: 'check:done'; tabId: number; summary: CheckSummary; replayed?: true }
  | { type: 'check:error'; tabId: number; code: CheckErrorCode; message: string; paperKey?: string; replayed?: true }
  /** A lookup service ran out of budget or asked to be left alone during the run; sent once per source and run. */
  | { type: 'check:limited'; tabId: number; paperKey: string; source: SourceName; replayed?: true }
  /**
   * A lookup service asked, with a Retry-After, not to be contacted until `until` (ms since the epoch, at most an hour
   * ahead when sent). Sent once per source and block during a run.
   */
  | { type: 'check:blocked'; tabId: number; paperKey: string; source: SourceName; until: number; replayed?: true }
  /** The run ended early: the user pressed Stop, or the services stopped answering. The results sent so far stand. */
  | { type: 'check:stopped'; tabId: number; paperKey: string; reason: StopReason; replayed?: true }
  /** A badge on the page was clicked: the panel should show that row. */
  | { type: 'badge:clicked'; tabId: number; index: number };

export type SavedCheck = { summary: CheckSummary; results: CheckResult[] };

/** The answer to a `PanelToBackground` message. `saved` appears only for `history:get`, `badgeIndex` only for `badge:take`. */
export type BackgroundReply = { ok: true; saved?: SavedCheck | null; badgeIndex?: number } | { ok: false; error: string };

export type BadgeUpdate = Pick<CheckResult, 'index' | 'status' | 'reason'>;

/** Background to a content script, with `tabs.sendMessage`. */
export type BackgroundToContent =
  /** arXiv HTML script: answer with a `RefsExtractReply`. */
  | { type: 'refs:extract' }
  /** OpenReview script: answer with an `OpenReviewPageInfo`. */
  | { type: 'openreview:read' }
  | { type: 'badges:update'; paperKey: string; results: BadgeUpdate[] }
  | { type: 'badges:clear' };

/** The side panel to a content script (tab-addressed). */
export type PanelToContent = { type: 'ref:scrollTo'; index: number };

/** Content script to background. The arXiv HTML script sends all three; the OpenReview script none. */
export type ContentToBackground =
  | { type: 'content:ready'; paperKey: string }
  | { type: 'page:leaving'; paperKey: string }
  | { type: 'badge:clicked'; index: number };

export interface RefsExtractReply {
  refs: RawReference[];
  /** The paper's title as the page shows it, when the script can read one. */
  title?: string;
}

// ---------------------------------------------------------------------------- validators

const MAX_KEY_CHARS = 300;
const MAX_TEXT_CHARS = 5000;
const MAX_REFS = 3000;
const MAX_REF_TEXT_CHARS = 20_000;
const MAX_ITEMS = 3000;

const isString = (v: unknown, max = MAX_TEXT_CHARS): v is string => typeof v === 'string' && v.length <= max;
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isCount = isIndex;
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY_CHARS;
const isOptional = <T>(v: unknown, check: (x: unknown) => x is T): boolean => v === undefined || check(v);
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= MAX_ITEMS && v.every((s) => isString(s));
}

function isHttpsUrl(v: unknown): v is string {
  if (!isString(v, 2048)) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

export function isPanelToBackground(x: unknown): x is PanelToBackground {
  if (!isRecord(x)) return false;
  switch (x['type']) {
    case 'check:start':
    case 'check:cancel':
    case 'badge:take':
      return isIndex(x['tabId']);
    case 'history:get':
      return isKey(x['paperKey']);
    case 'history:clear':
      return true;
    default:
      return false;
  }
}

function isPaperInfo(x: unknown): x is PaperInfo {
  return (
    isRecord(x) &&
    isKey(x['key']) &&
    isString(x['title']) &&
    isHttpsUrl(x['url']) &&
    typeof x['origin'] === 'string' &&
    ORIGINS.has(x['origin']) &&
    typeof x['viaPdf'] === 'boolean' &&
    isOptional(x['viaArxivVersion'], (v): v is string => isString(v, 100))
  );
}

const DOI_LINK_BASE = 'https://doi.org/';
const ARXIV_LINK_BASE = `${API.arxivSite}/abs/`;
const OPENREVIEW_LINK_BASE = `${API.openreviewSite}/forum?id=`;

/**
 * True only for an address the identifiers module would have built: a DOI, arXiv or OpenReview link.
 * The identifier is taken out of the address, validated, and the link rebuilt from it; anything that
 * does not rebuild to the very same string (extra path, query, fragment, odd escapes) is refused.
 */
function isBuiltLink(url: string): boolean {
  try {
    if (url.startsWith(DOI_LINK_BASE)) return doiUrl(url.slice(DOI_LINK_BASE.length).split('/').map(decodeURIComponent).join('/')) === url;
    if (url.startsWith(ARXIV_LINK_BASE)) return arxivUrl(url.slice(ARXIV_LINK_BASE.length)) === url;
    if (url.startsWith(OPENREVIEW_LINK_BASE)) return openreviewUrl(url.slice(OPENREVIEW_LINK_BASE.length)) === url;
  } catch {
    // An invalid identifier or a malformed escape: not one of ours.
  }
  return false;
}

function isLink(x: unknown): boolean {
  return isRecord(x) && isString(x['label']) && isString(x['url'], 2048) && isBuiltLink(x['url']);
}

function isDiff(x: unknown): boolean {
  return isRecord(x) && ['title', 'authors', 'year', 'identifier'].includes(String(x['field'])) && isString(x['cited']) && isString(x['actual']);
}

function isSourceList(x: unknown): boolean {
  return Array.isArray(x) && x.length <= SOURCES.size && x.every((s) => typeof s === 'string' && SOURCES.has(s));
}

export function isCheckResult(x: unknown): x is CheckResult {
  return (
    isRecord(x) &&
    isIndex(x['index']) &&
    isString(x['label']) &&
    isString(x['citedText'], MAX_REF_TEXT_CHARS) &&
    typeof x['status'] === 'string' &&
    STATUSES.has(x['status']) &&
    isString(x['reason']) &&
    isOptional(x['match'], isRecord) &&
    Array.isArray(x['diffs']) &&
    x['diffs'].length <= MAX_ITEMS &&
    x['diffs'].every(isDiff) &&
    isStringArray(x['notes']) &&
    isSourceList(x['sourcesSearched']) &&
    isSourceList(x['sourcesFailed']) &&
    Array.isArray(x['links']) &&
    x['links'].length <= MAX_ITEMS &&
    x['links'].every(isLink)
  );
}

function isCounts(x: unknown): boolean {
  return isRecord(x) && [...STATUSES].every((status) => isCount(x[status]));
}

function isCheckSummary(x: unknown): x is CheckSummary {
  return (
    isRecord(x) &&
    isPaperInfo(x['paper']) &&
    isCounts(x['counts']) &&
    isCount(x['total']) &&
    typeof x['startedAt'] === 'number' &&
    isOptional(x['finishedAt'], (v): v is number => typeof v === 'number') &&
    typeof x['beta'] === 'boolean'
  );
}

export function isBackgroundToPanel(x: unknown): x is BackgroundToPanel {
  if (!isRecord(x) || !isIndex(x['tabId'])) return false;
  const replayOk = isOptional(x['replayed'], (v): v is true => v === true);
  switch (x['type']) {
    case 'check:started':
      return replayOk && isPaperInfo(x['paper']) && isCount(x['total']);
    case 'check:result':
      return replayOk && isKey(x['paperKey']) && isCheckResult(x['result']);
    case 'check:done':
      return replayOk && isCheckSummary(x['summary']);
    case 'check:error':
      return replayOk && typeof x['code'] === 'string' && ERROR_CODES.has(x['code']) && isString(x['message']) && isOptional(x['paperKey'], isKey);
    case 'check:limited':
      return replayOk && isKey(x['paperKey']) && typeof x['source'] === 'string' && SOURCES.has(x['source']);
    case 'check:blocked':
      return replayOk && isKey(x['paperKey']) && typeof x['source'] === 'string' && SOURCES.has(x['source']) && isCount(x['until']);
    case 'check:stopped':
      return replayOk && isKey(x['paperKey']) && typeof x['reason'] === 'string' && STOP_REASONS.has(x['reason']);
    case 'badge:clicked':
      return isIndex(x['index']);
    default:
      return false;
  }
}

export function isBackgroundReply(x: unknown): x is BackgroundReply {
  if (!isRecord(x)) return false;
  if (x['ok'] === false) return isString(x['error']);
  if (x['ok'] !== true) return false;
  if (!isOptional(x['badgeIndex'], isIndex)) return false;
  const saved = x['saved'];
  if (saved === undefined || saved === null) return true;
  return isRecord(saved) && isCheckSummary(saved['summary']) && Array.isArray(saved['results']) && saved['results'].length <= MAX_REFS && saved['results'].every(isCheckResult);
}

function isBadgeUpdate(x: unknown): x is BadgeUpdate {
  return isRecord(x) && isIndex(x['index']) && typeof x['status'] === 'string' && STATUSES.has(x['status']) && isString(x['reason']);
}

export function isBackgroundToContent(x: unknown): x is BackgroundToContent {
  if (!isRecord(x)) return false;
  switch (x['type']) {
    case 'refs:extract':
    case 'openreview:read':
    case 'badges:clear':
      return true;
    case 'badges:update':
      return isKey(x['paperKey']) && Array.isArray(x['results']) && x['results'].length <= MAX_REFS && x['results'].every(isBadgeUpdate);
    default:
      return false;
  }
}

export function isPanelToContent(x: unknown): x is PanelToContent {
  return isRecord(x) && x['type'] === 'ref:scrollTo' && isIndex(x['index']);
}

export function isContentToBackground(x: unknown): x is ContentToBackground {
  if (!isRecord(x)) return false;
  switch (x['type']) {
    case 'content:ready':
    case 'page:leaving':
      return isKey(x['paperKey']);
    case 'badge:clicked':
      return isIndex(x['index']);
    default:
      return false;
  }
}

function isRawReference(x: unknown): x is RawReference {
  return (
    isRecord(x) &&
    isIndex(x['index']) &&
    isString(x['label'], 200) &&
    isString(x['text'], MAX_REF_TEXT_CHARS) &&
    isOptional(x['blocks'], (v): v is string[] => Array.isArray(v) && v.length <= 200 && v.every((b) => isString(b, MAX_REF_TEXT_CHARS))) &&
    isOptional(x['anchorId'], (v): v is string => isString(v, 200)) &&
    isOptional(x['partial'], (v): v is true => v === true)
  );
}

export function isRefsExtractReply(x: unknown): x is RefsExtractReply {
  return isRecord(x) && Array.isArray(x['refs']) && x['refs'].length <= MAX_REFS && x['refs'].every(isRawReference) && isOptional(x['title'], (v): v is string => isString(v, 1000));
}

export function isOpenReviewReadReply(x: unknown): x is OpenReviewPageInfo {
  return (
    isRecord(x) &&
    (x['visibility'] === 'public' || x['visibility'] === 'confidential' || x['visibility'] === 'unclear') &&
    isOptional(x['title'], (v): v is string => isString(v, 1000)) &&
    isOptional(x['forumId'], (v): v is string => isString(v, 100))
  );
}

// ---------------------------------------------------------------------------- who sent it

type Sender = Browser.runtime.MessageSender;

const ARXIV_ORIGIN = new URL(API.arxivSite).origin;
const OPENREVIEW_ORIGIN = new URL(API.openreviewSite).origin;

function parseHttps(url: string | undefined): URL | undefined {
  if (url === undefined || url.length > 2048) return undefined;
  try {
    const parsed = new URL(url);
    // Credentials in the address are how look-alike URLs are written (https://arxiv.org@evil.com).
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The address a content script's message came from: its own frame's, else its tab's. */
function senderUrl(sender: Sender): string | undefined {
  return sender.url ?? sender.tab?.url;
}

/** True when the sender is a page of this extension (the panel, the options page, the background). */
export function isExtensionPage(sender: Sender): boolean {
  if (sender.id !== browser.runtime.id) return false;
  // getURL('/') ends with the slash, so another extension id that merely starts the same does not match.
  return typeof sender.url === 'string' && sender.url.startsWith(browser.runtime.getURL('/' as never));
}

/** The only extension page that sends panel commands or opens the panel port. */
const SIDE_PANEL_PATH = '/sidepanel.html';

/**
 * True when the sender is the side panel page itself. Other extension pages (the offscreen document,
 * which parses untrusted PDFs and HTML) are extension pages too, but must not start checks or clear history.
 */
export function isSidePanelPage(sender: Sender): boolean {
  if (!isExtensionPage(sender)) return false;
  try {
    const got = new URL(sender.url ?? '');
    const want = new URL(browser.runtime.getURL(SIDE_PANEL_PATH as never));
    // Not `origin`: it is "null" for extension schemes.
    return got.protocol === want.protocol && got.host === want.host && got.pathname === want.pathname;
  } catch {
    return false;
  }
}

/**
 * Whether a message may be looked at at all: it is from this extension, and, if it came from a
 * tab, that tab is on arXiv or OpenReview (or is one of our own pages). Every handler starts here,
 * then narrows further for the message it got (`isExtensionPage`, `contentSite`).
 */
export function isTrustedSender(sender: Sender): boolean {
  if (sender.id === undefined || sender.id !== browser.runtime.id) return false;
  if (isExtensionPage(sender)) return true;
  // No tab: an extension context (the background itself). Pages cannot send messages to us
  // (no externally_connectable), so a sender with our id and no tab is not a web page.
  if (sender.tab === undefined) return sender.url === undefined;
  const parsed = parseHttps(senderUrl(sender));
  return parsed !== undefined && (parsed.origin === ARXIV_ORIGIN || parsed.origin === OPENREVIEW_ORIGIN);
}

export type ContentSite = 'arxiv-html' | 'openreview-forum';

/**
 * Which of our two content scripts sent this, judged by the address of the frame it runs in:
 * the arXiv script runs only on arxiv.org/html/*, the OpenReview one only on openreview.net/forum*.
 * Undefined for anything else, for sub-frames, and for senders that are not in a tab.
 */
export function contentSite(sender: Sender): ContentSite | undefined {
  if (sender.id === undefined || sender.id !== browser.runtime.id || sender.tab === undefined) return undefined;
  if (sender.frameId !== undefined && sender.frameId !== 0) return undefined;
  const url = senderUrl(sender);
  if (parseHttps(url) === undefined || url === undefined) return undefined;
  const page = detectPage(url);
  if (page.kind === 'arxiv-html') return 'arxiv-html';
  if (page.kind === 'openreview' && new URL(url).pathname === '/forum') return 'openreview-forum';
  return undefined;
}
