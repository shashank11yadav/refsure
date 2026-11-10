// Deciding what kind of page a tab is showing, from its URL alone. Only the two
// supported sites are recognised, matched on the parsed origin (never on a substring),
// and only identifiers that pass the validators in src/core/identifiers.ts come back.

import { API } from '../config';
import { isValidArxivId, isValidOpenReviewId, stripArxivVersion } from '../core/identifiers';

export type PageKind = 'arxiv-html' | 'arxiv-abs' | 'arxiv-pdf' | 'openreview' | 'unsupported';

export interface PageInfo {
  kind: PageKind;
  /** `arxiv:<id without version>` or `openreview:<forumId>`. */
  paperKey?: string;
  /** As in the URL, version included. */
  arxivId?: string;
  forumId?: string;
}

const UNSUPPORTED: PageInfo = { kind: 'unsupported' };
const ARXIV_ORIGIN = new URL(API.arxivSite).origin;
const OPENREVIEW_ORIGIN = new URL(API.openreviewSite).origin;
const ARXIV_PREFIXES: ReadonlyArray<readonly [string, PageKind]> = [
  ['/html/', 'arxiv-html'],
  ['/abs/', 'arxiv-abs'],
  ['/pdf/', 'arxiv-pdf'],
];
// Upper bound before URL parsing: no real page address comes near this.
const MAX_URL_LENGTH = 2048;

function parse(url: string): URL | undefined {
  if (url.length > MAX_URL_LENGTH) return undefined;
  try {
    const parsed = new URL(url);
    // Credentials in the address are how look-alike URLs are written (https://arxiv.org@evil.com).
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function detectArxiv(path: string): PageInfo {
  for (const [prefix, kind] of ARXIV_PREFIXES) {
    if (!path.startsWith(prefix)) continue;
    let id = path.slice(prefix.length);
    if (id.endsWith('/')) id = id.slice(0, -1);
    if (kind === 'arxiv-pdf' && id.endsWith('.pdf')) id = id.slice(0, -'.pdf'.length);
    if (!isValidArxivId(id)) return UNSUPPORTED;
    return { kind, paperKey: `arxiv:${stripArxivVersion(id)}`, arxivId: id };
  }
  return UNSUPPORTED;
}

function detectOpenReview(path: string, params: URLSearchParams): PageInfo {
  if (path !== '/forum' && path !== '/pdf') return UNSUPPORTED;
  const ids = params.getAll('id');
  const id = ids[0];
  if (ids.length !== 1 || id === undefined || !isValidOpenReviewId(id)) return UNSUPPORTED;
  return { kind: 'openreview', paperKey: `openreview:${id}`, forumId: id };
}

export function detectPage(url: string): PageInfo {
  const parsed = parse(url);
  if (!parsed) return UNSUPPORTED;
  if (parsed.origin === ARXIV_ORIGIN) return detectArxiv(parsed.pathname);
  if (parsed.origin === OPENREVIEW_ORIGIN) return detectOpenReview(parsed.pathname, parsed.searchParams);
  return UNSUPPORTED;
}
