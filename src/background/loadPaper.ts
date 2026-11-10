// Getting the references of the paper in a tab, by page kind (DESIGN section 7.1). Everything
// that can stop a check for a reason the user should hear about is a `CheckFailure`.
//
// Privacy order for OpenReview matters: the page's own script says whether the paper is public
// BEFORE anything else happens. Until that answer is "public", no lookup of any kind is made,
// not even a title search, so a confidential submission's title cannot leave through here.

import { browser } from 'wxt/browser';
import { API } from '../config';
import { isValidArxivId, openreviewUrl, stripArxivVersion } from '../core/identifiers';
import { titleSimilarity } from '../core/normalize';
import { cleanTabTitle } from '../core/title';
import { VERIFIED_TITLE } from '../core/thresholds';
import type { PaperInfo, RawReference } from '../core/types';
import { PdfReadError } from '../extract/readError';
import { detectPage, type PageInfo } from '../extract/pageDetect';
import { arxiv } from '../sources/arxiv';
import { abortable, fetchBytes, fetchText, SourceError } from '../sources/http';
import { isOpenReviewReadReply, isRefsExtractReply, type BackgroundToContent, type CheckErrorCode } from '../messaging';
import { parseInHost } from '../extract/parseHost';

// The panel words each notice from its code (src/ui/banner.ts). Only a failed read carries a message, and the
// panel shows it: this default, a PdfReadError's ("This PDF is password protected") or a more precise one.
const FETCH_FAILED_MESSAGE = "RefSure couldn't read this paper's references.";
const TITLE_UNREADABLE_MESSAGE = "RefSure couldn't read this paper's title, so it couldn't look for its arXiv version.";

/**
 * A reason the check cannot go ahead. The message is empty except for a failed read, where it is written for the
 * user and never quotes the page.
 */
export class CheckFailure extends Error {
  readonly code: CheckErrorCode;
  constructor(code: CheckErrorCode, message: string = code === 'fetch-failed' ? FETCH_FAILED_MESSAGE : '') {
    super(message);
    this.name = 'CheckFailure';
    this.code = code;
  }
}

/** Turns anything thrown while loading a paper into a failure with a message that is safe to show. */
export function toCheckFailure(error: unknown): CheckFailure {
  if (error instanceof CheckFailure) return error;
  if (error instanceof SourceError) return new CheckFailure(error.kind === 'offline' ? 'offline' : 'fetch-failed');
  // PdfReadError messages are written to be shown ("Reading this paper took too long").
  if (error instanceof PdfReadError) return new CheckFailure('fetch-failed', error.message);
  return new CheckFailure('fetch-failed');
}

export interface PageTab {
  id: number;
  url: string | undefined;
  title: string | undefined;
}

export interface LoadedPaper {
  paper: PaperInfo;
  refs: RawReference[];
  /** True when a content script supplied the references, so the page can show badges. */
  badges: boolean;
}

// A content script that has not answered by now is not there (page opened before install).
const CONTENT_REPLY_TIMEOUT_MS = 10_000;
// A page that just finished loading may not have its script yet (it starts at document_idle).
const CONTENT_RETRY_DELAY_MS = 500;
const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return abortable(waited, signal).finally(() => clearTimeout(timer));
}

/** One try: the script's answer, or nothing, noting whether nobody was listening at all. */
async function tryOnce(tabId: number, message: BackgroundToContent, signal: AbortSignal): Promise<{ reply: unknown; noReceiver: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<{ reply: unknown; noReceiver: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ reply: undefined, noReceiver: false }), CONTENT_REPLY_TIMEOUT_MS);
  });
  // Top frame only.
  const answer = browser.tabs.sendMessage(tabId, message, { frameId: 0 }).then(
    (reply: unknown) => ({ reply, noReceiver: false }),
    (error: unknown) => ({ reply: undefined, noReceiver: error instanceof Error && NO_RECEIVER.test(error.message) }),
  );
  try {
    return await abortable(Promise.race([answer, silence]), signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks a content script and validates its answer. No script and no answer both give undefined. With
 * `retryOnce`, "nobody was listening" (and only that) is tried a second time after a short wait.
 */
async function askContent<T>(
  tabId: number,
  message: BackgroundToContent,
  accept: (x: unknown) => x is T,
  signal: AbortSignal,
  retryOnce = false,
): Promise<T | undefined> {
  let result = await tryOnce(tabId, message, signal);
  if (result.noReceiver && retryOnce) {
    await pause(CONTENT_RETRY_DELAY_MS, signal);
    result = await tryOnce(tabId, message, signal);
  }
  return accept(result.reply) ? result.reply : undefined;
}

// The paper's address is rebuilt from its validated id on a fixed base, never copied from the tab: a tab's
// address can carry where the reader came from (an OpenReview reviewer console adds `referrer=`), a comment they
// opened or tracking, and this address is kept in history and goes into Copy report and the JSON export.
const ARXIV_PATHS = { 'arxiv-abs': 'abs', 'arxiv-html': 'html', 'arxiv-pdf': 'pdf' } as const;

function arxivPaperUrl(kind: keyof typeof ARXIV_PATHS, arxivId: string): string {
  return `${API.arxivSite}/${ARXIV_PATHS[kind]}/${arxivId}`;
}

/** The references of an arXiv paper: its HTML version when there is one, otherwise (or if that has none) its PDF. */
async function readArxivPaper(arxivId: string, signal: AbortSignal): Promise<{ refs: RawReference[]; viaPdf: boolean }> {
  let refs: RawReference[] = [];
  try {
    const html = await fetchText(`${API.arxivSite}/html/${arxivId}`, { source: 'page', kind: 'html', signal });
    refs = (await abortable(parseInHost({ kind: 'arxiv-html-text', html }), signal)).refs;
  } catch (error) {
    // Only "there is no HTML version" falls back to the PDF; a network failure would fail the PDF too.
    if (!(error instanceof SourceError && error.kind === 'not_found_http')) throw error;
  }
  if (refs.length > 0) return { refs, viaPdf: false };
  return { refs: await readArxivPdf(arxivId, signal), viaPdf: true };
}

async function readArxivPdf(arxivId: string, signal: AbortSignal): Promise<RawReference[]> {
  const data = await fetchBytes(`${API.arxivSite}/pdf/${arxivId}`, { source: 'page', signal });
  return (await abortable(parseInHost({ kind: 'pdf', data }), signal)).refs;
}

async function loadArxiv(tab: PageTab & { url: string }, page: PageInfo, signal: AbortSignal): Promise<LoadedPaper> {
  const { paperKey, arxivId } = page;
  if (paperKey === undefined || arxivId === undefined || page.kind === 'openreview' || page.kind === 'unsupported') throw new CheckFailure('unsupported');
  const base = { key: paperKey, url: arxivPaperUrl(page.kind, arxivId) };

  if (page.kind === 'arxiv-pdf') {
    const refs = await readArxivPdf(arxivId, signal);
    return { paper: { ...base, title: `arXiv:${arxivId}`, origin: 'arxiv-pdf', viaPdf: true }, refs, badges: false };
  }

  if (page.kind === 'arxiv-html') {
    const reply = await askContent(tab.id, { type: 'refs:extract' }, isRefsExtractReply, signal);
    if (reply !== undefined) {
      const title = cleanTabTitle(reply.title) ?? cleanTabTitle(tab.title) ?? `arXiv:${arxivId}`;
      return { paper: { ...base, title, origin: 'arxiv-html', viaPdf: false }, refs: reply.refs, badges: true };
    }
  }

  const read = await readArxivPaper(arxivId, signal);
  const origin = page.kind === 'arxiv-html' ? 'arxiv-html' : 'arxiv-abs';
  return { paper: { ...base, title: cleanTabTitle(tab.title) ?? `arXiv:${arxivId}`, origin, viaPdf: read.viaPdf }, refs: read.refs, badges: false };
}

async function loadOpenReview(tab: PageTab & { url: string }, page: PageInfo, signal: AbortSignal): Promise<LoadedPaper> {
  const { paperKey, forumId } = page;
  if (paperKey === undefined || forumId === undefined) throw new CheckFailure('unsupported');
  // The PDF viewer cannot host the reader, so there is no way to learn whether the paper is public from it.
  if (new URL(tab.url).pathname !== '/forum') throw new CheckFailure('open-forum-page');

  const info = await askContent(tab.id, { type: 'openreview:read' }, isOpenReviewReadReply, signal, true);
  // No answer, or an answer about some other forum, is as good as "unclear": fail closed.
  if (info === undefined || info.forumId !== forumId) throw new CheckFailure('visibility-unclear');
  if (info.visibility === 'confidential') throw new CheckFailure('confidential');
  if (info.visibility !== 'public') throw new CheckFailure('visibility-unclear');

  const title = cleanTabTitle(info.title);
  if (title === undefined) throw new CheckFailure('fetch-failed', TITLE_UNREADABLE_MESSAGE);

  const candidates = await arxiv.search({ raw: title, title, authors: [], kind: 'paper', confidence: 1 }, signal);
  // The version must be unique: a title shared by two arXiv papers could be either, and checking the wrong
  // paper's references would be reported as this paper's.
  const qualifying = new Set<string>();
  for (const record of candidates) {
    if (record.arxivId === undefined || !isValidArxivId(record.arxivId)) continue;
    if (titleSimilarity(title, record.title) >= VERIFIED_TITLE) qualifying.add(stripArxivVersion(record.arxivId));
  }
  const [only, ...others] = qualifying;
  const match = only !== undefined && others.length === 0 ? { arxivId: only } : undefined;
  if (match === undefined) throw new CheckFailure('no-arxiv-version');

  const read = await readArxivPaper(match.arxivId, signal);
  const paper: PaperInfo = { key: paperKey, title, url: openreviewUrl(forumId), origin: 'openreview', viaPdf: read.viaPdf, viaArxivVersion: match.arxivId };
  return { paper, refs: read.refs, badges: false };
}

/** Finds the paper in the tab and reads its references. Throws `CheckFailure` (or the abort reason). */
export async function loadPaper(tab: PageTab, signal: AbortSignal): Promise<LoadedPaper> {
  const page = tab.url === undefined ? undefined : detectPage(tab.url);
  if (tab.url === undefined || page === undefined || page.kind === 'unsupported') throw new CheckFailure('unsupported');
  const located = { ...tab, url: tab.url };
  const loaded = page.kind === 'openreview' ? await loadOpenReview(located, page, signal) : await loadArxiv(located, page, signal);
  if (loaded.refs.length === 0) throw new CheckFailure('no-references');
  return loaded;
}
