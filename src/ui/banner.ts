// Notices above the results: why a paper was not checked, offline, interrupted. Plain, calm wording;
// each says what to do next, and none ever accuses anyone (DESIGN section 5).

import { joinAnd, SOURCE_NAME } from '../core/status';
import { REQUIRED_SOURCES, type CheckResult, type SourceName } from '../core/types';
import type { CheckErrorCode } from '../messaging';
import { button, el } from './dom';

export type Tone = 'info' | 'warn';

export interface BannerContent {
  tone: Tone;
  text: string;
}

export interface BannerAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export const INTERRUPTED_TEXT = 'Check interrupted. Press Re-check to start again.';
export const SERVICES_DOWN_TEXT = "The databases RefSure uses aren't answering right now. This isn't a problem with the paper. Try again in a few minutes.";


/** A lookup service that asked RefSure, with a Retry-After, not to contact it until `until` (ms since the epoch). */
export interface SourceBlock {
  source: SourceName;
  until: number;
}

const MINUTE_MS = 60_000;

/**
 * The local clock time a wait ends, as the browser writes a short time ("19:42", "01:12", "7:42 PM"), rounded up to the
 * minute so it is never early.
 */
export function clockTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(Math.ceil(ms / MINUTE_MS) * MINUTE_MS));
}

/** The waits still to come: a time that has passed is never shown. */
export function activeBlocks(blocks: readonly SourceBlock[], now = Date.now()): SourceBlock[] {
  return blocks.filter((b) => b.until > now);
}

/**
 * "Crossref asked RefSure to wait. RefSure will try it again after 19:42." The time is RefSure's own: a service may have
 * asked for longer than the hour RefSure waits at most. Sources whose waits end in the same minute share it.
 */
function waitText(blocks: readonly SourceBlock[]): string {
  const groups = new Map<string, string[]>();
  for (const block of [...blocks].sort((a, b) => b.until - a.until)) {
    const time = clockTime(block.until);
    groups.set(time, [...(groups.get(time) ?? []), SOURCE_NAME[block.source]]);
  }
  const names = joinAnd(blocks.map((b) => SOURCE_NAME[b.source]));
  if (groups.size === 1) {
    const [time = ''] = groups.keys();
    return `${names} asked RefSure to wait. RefSure will try ${blocks.length === 1 ? 'it' : 'them'} again after ${time}.`;
  }
  const whens = [...groups].map(([time, group], i) => `${joinAnd(group)}${i === 0 ? ' again' : ''} after ${time}`);
  return `${names} asked RefSure to wait. RefSure will try ${joinAnd(whens)}.`;
}

/** The notice for a source that asked RefSure to wait: which one, and when RefSure tries it again. */
export function blockedNotice(block: SourceBlock): BannerContent {
  return { tone: 'info', text: `${SOURCE_NAME[block.source]} asked RefSure to wait, so references that need it show as Can't check. RefSure will try it again after ${clockTime(block.until)}.` };
}

/** The "not answering" text, naming each source that asked RefSure to wait (and has not finished waiting) and when it is tried again. */
export function servicesDownText(blocks: readonly SourceBlock[], now = Date.now()): string {
  const waiting = activeBlocks(blocks, now);
  if (waiting.length === 0) return SERVICES_DOWN_TEXT;
  return `The databases RefSure uses aren't answering right now. This isn't a problem with the paper. ${waitText(waiting)}`;
}

/** The notice for a source that ran out of lookups during a run. Only OpenAlex has a key to add. */
export function limitedNotice(source: SourceName): BannerContent {
  if (source === 'openalex') {
    return { tone: 'info', text: "OpenAlex's free daily search limit is used up, so some references will show as Can't check. Try again tomorrow, or add your own free OpenAlex key in Settings → Advanced." };
  }
  return { tone: 'info', text: `${SOURCE_NAME[source]}'s lookup limit is reached for now, so some references will show as Can't check. Try again later.` };
}

/** The notice for a required source that did not answer for some references (not all): they show as Can't check. */
export function unreachableNotice(source: SourceName): BannerContent {
  return { tone: 'info', text: `Couldn't reach ${SOURCE_NAME[source]} for some references, so they show as Can't check. Re-check later to try them again.` };
}

/**
 * The required sources that failed for at least one reference that shows as Can't check, but not for every reference
 * (that is an outage, and the run says so itself). A source with its own limit notice is left to that notice.
 */
export function unreachableSources(results: readonly CheckResult[], limited: readonly SourceName[] = []): SourceName[] {
  const found: SourceName[] = [];
  for (const source of REQUIRED_SOURCES) {
    if (limited.includes(source)) continue;
    const count = results.filter((r) => r.status === 'cant_check' && r.sourcesFailed.includes(source)).length;
    if (count > 0 && count < results.length) found.push(source);
  }
  return found;
}

// No trailing "try again": the button right below says it.
const FETCH_FAILED_DEFAULT = "RefSure couldn't read this paper's references.";
const MAX_MESSAGE_CHARS = 300;

const BANNERS: Readonly<Record<Exclude<CheckErrorCode, 'fetch-failed'>, BannerContent & { retry: boolean }>> = {
  unsupported: {
    tone: 'info',
    retry: false,
    text: 'RefSure works on arXiv papers (abstract, HTML and PDF pages) and on public OpenReview papers. Open one of those, then click the RefSure button.',
  },
  confidential: {
    tone: 'info',
    retry: false,
    text: "This submission isn't public, so RefSure didn't check it. Nothing was sent anywhere.",
  },
  'visibility-unclear': {
    tone: 'info',
    retry: true,
    text: "RefSure couldn't confirm this paper is public, so it didn't check it. Nothing was sent anywhere.",
  },
  'no-arxiv-version': {
    tone: 'info',
    retry: false,
    text: "RefSure reads OpenReview papers through their arXiv version, and this paper doesn't have one it can find yet.",
  },
  'open-forum-page': { tone: 'info', retry: false, text: "Open the paper's OpenReview page (not the PDF) to check it." },
  'no-references': { tone: 'info', retry: false, text: "RefSure couldn't find a reference list in this paper." },
  offline: { tone: 'warn', retry: true, text: 'You appear to be offline. Connect and press Try again.' },
};

/** The notice for a `check:error`. A failed read shows the background's own message, which is written to be shown. */
export function bannerFor(code: CheckErrorCode, message?: string): BannerContent & { retry: boolean } {
  if (code === 'fetch-failed') {
    const own = message?.trim();
    return { tone: 'warn', retry: true, text: own !== undefined && own.length > 0 ? own.slice(0, MAX_MESSAGE_CHARS) : FETCH_FAILED_DEFAULT };
  }
  return BANNERS[code];
}

export function renderBanner(doc: Document, content: BannerContent, actions: readonly BannerAction[]): HTMLElement {
  const box = el(doc, 'div', { class: `banner tone-${content.tone}`, role: 'status' }, el(doc, 'p', { class: 'banner-text' }, content.text));
  if (actions.length > 0) {
    box.append(el(doc, 'div', { class: 'banner-actions' }, ...actions.map((a) => button(doc, a.label, a.onClick, { class: a.primary === false ? 'btn' : 'btn primary', 'data-fk': `banner:${a.label}` }))));
  }
  return box;
}
