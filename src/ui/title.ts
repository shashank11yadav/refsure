// The title shown for a paper before (or instead of) the one the background read: the browser tab's title, tidied
// by the same clean-up the background applies, so both say the same thing.

import { cleanTabTitle } from '../core/title';

/** A PDF tab is often titled by its file: "pdf", "1706.03762.pdf", "1706.03762v7". That names no paper. */
function looksLikeFileName(title: string): boolean {
  return /^pdf$/i.test(title) || /^\S+\.(pdf|html?)$/i.test(title) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(title);
}

/** The tab's title when it reads like a title; undefined when it is missing or only a file name. */
export function usableTabTitle(raw: string | undefined): string | undefined {
  const cleaned = cleanTabTitle(raw);
  return cleaned === undefined || looksLikeFileName(cleaned) ? undefined : cleaned;
}

/** What the ready screen names the paper: its tab title, else "arXiv:<id>" for an arXiv paper, else nothing. */
export function readyTitle(raw: string | undefined, paperKey: string | undefined): string | undefined {
  const usable = usableTabTitle(raw);
  if (usable !== undefined) return usable;
  const id = /^arxiv:(.+)$/.exec(paperKey ?? '')?.[1];
  return id === undefined ? undefined : `arXiv:${id}`;
}
