// What counts as a plausible OpenAlex key. One rule, used by the panel (to explain a refusal) and by the
// settings store (to decide what it keeps), so the two can never disagree about the same key.

export const OPENALEX_KEY_MIN = 8;
export const OPENALEX_KEY_MAX = 200;

export type KeyRefusal = 'length' | 'space' | 'ascii';
export type KeyCheck = { ok: true; key: string } | { ok: false; reason: KeyRefusal };

/** The key as it will be kept (trimmed), or the first reason it was refused. */
export function validateOpenAlexKey(raw: string): KeyCheck {
  const key = raw.trim();
  if (/\s/.test(key)) return { ok: false, reason: 'space' };
  if (key.length < OPENALEX_KEY_MIN || key.length > OPENALEX_KEY_MAX) return { ok: false, reason: 'length' };
  // Printable ASCII only: the key travels in a URL query and is shown as a mask, never reinterpreted.
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, reason: 'ascii' };
  return { ok: true, key };
}
