// The panel header: paper title, how the references were read, the progress bar while checking,
// and the totals line (DESIGN 7.3).

import { API } from '../config';
import { isValidArxivId } from '../core/identifiers';
import { arxivVersionLine, arxivVersionUrl, PDF_BETA_HELP } from '../core/report';
import { STATUS_ORDER, totalsParts } from '../core/status';
import type { PaperInfo, Status } from '../core/types';
import { el } from './dom';

export interface HeaderModel {
  paper?: PaperInfo;
  title: string;
  phase: 'checking' | 'done' | 'interrupted' | 'stopped';
  /** How many references have a result so far. */
  done: number;
  /** How many references there are; 0 while that is not known yet. */
  total: number;
  counts: Readonly<Record<Status, number>>;
  beta: boolean;
  /** Set when the results are an earlier check read back from history. */
  savedAt?: number;
}

/** The HTML version of an arXiv paper, built from the validated id in its key; undefined for any other key. */
function htmlVersionUrl(paperKey: string): string | undefined {
  const id = /^arxiv:(.+)$/.exec(paperKey)?.[1];
  return id !== undefined && isValidArxivId(id) ? `${API.arxivSite}/html/${id}` : undefined;
}

function progress(doc: Document, m: HeaderModel): HTMLElement {
  const known = m.total > 0;
  const percent = known ? Math.min(100, Math.round((m.done / m.total) * 100)) : 0;
  // The width goes through the style object: the extension pages' CSP refuses an inline style attribute.
  const fill = el(doc, 'div', { class: 'progress-fill' });
  if (known) fill.style.width = `${percent}%`;
  const bar = el(
    doc,
    'div',
    {
      class: known ? 'progress' : 'progress indeterminate',
      role: 'progressbar',
      'aria-label': 'Checking references',
      'aria-valuemin': '0',
      'aria-valuemax': known ? String(m.total) : undefined,
      'aria-valuenow': known ? String(m.done) : undefined,
    },
    fill,
  );
  const label = known ? `Checking ${m.done} of ${m.total} references…` : 'Reading the reference list…';
  return el(doc, 'div', { class: 'progress-wrap' }, bar, el(doc, 'p', { class: 'progress-text' }, label));
}

/**
 * The totals line. A no-break space joins each number to its word, so a narrow panel never leaves "2" at the end of a
 * line and "not found" at the start of the next. (Only that space: a whole part as one unbreakable run is wider than a
 * 160 px panel, which is a 320 px one at 200% zoom.)
 */
function totals(doc: Document, counts: HeaderModel['counts'] | undefined): HTMLElement {
  if (counts === undefined) return el(doc, 'p', { class: 'totals' }, 'No results yet');
  const parts = totalsParts(counts).map((part) => part.replace(' ', '\u00A0'));
  return el(doc, 'p', { class: 'totals' }, parts.length === 0 ? 'No references' : parts.join(' · '));
}

export function renderHeader(doc: Document, m: HeaderModel): HTMLElement {
  const header = el(doc, 'header', { class: 'summary' }, el(doc, 'h1', { class: 'paper-title' }, m.title));

  const arxivId = m.paper?.viaArxivVersion;
  if (arxivId !== undefined) {
    const url = arxivVersionUrl(arxivId);
    const line = arxivVersionLine(arxivId);
    header.append(
      el(
        doc,
        'p',
        { class: 'via' },
        url === undefined ? line : el(doc, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, line),
      ),
    );
  }

  // An abstract page has no inline badges; the HTML version of the same paper does.
  const htmlUrl = m.paper?.origin === 'arxiv-abs' && m.paper.viaPdf !== true ? htmlVersionUrl(m.paper.key) : undefined;
  if (htmlUrl !== undefined) {
    header.append(el(doc, 'p', { class: 'via html-version' }, el(doc, 'a', { href: htmlUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open the HTML version'), ' to see a badge next to each reference'));
  }

  if (m.beta || m.paper?.viaPdf === true) {
    header.append(el(doc, 'p', { class: 'beta' }, el(doc, 'span', { class: 'pill' }, 'Beta'), ' ', el(doc, 'span', { class: 'help' }, PDF_BETA_HELP)));
  }

  if (m.phase === 'checking') header.append(progress(doc, m));
  if (m.phase !== 'checking' || m.done > 0) {
    // A stopped or interrupted check that found nothing has no verdict about the paper's references.
    const nothingYet = (m.phase === 'stopped' || m.phase === 'interrupted') && STATUS_ORDER.every((status) => m.counts[status] === 0);
    header.append(totals(doc, nothingYet ? undefined : m.counts));
  }

  if (m.savedAt !== undefined) {
    header.append(el(doc, 'p', { class: 'saved' }, `Saved check from ${new Date(m.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`));
  }
  return header;
}
