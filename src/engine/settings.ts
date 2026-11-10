// User settings, kept in browser.storage.local only (never sync: SECURITY.md section 7).
// Whatever is stored is untrusted on read: every field is checked and a bad one falls back to its default.
import { browser } from 'wxt/browser';
import { validateOpenAlexKey } from '../core/apiKey';
import { isRecord } from '../sources/guards';
import { openalex } from '../sources/openalex';

export interface Settings {
  autoCheckArxiv: boolean;
  autoCheckOpenReview: boolean;
  historyEnabled: boolean;
  /** The user's own OpenAlex key. Local only; never logged. */
  openAlexKey?: string;
}

export const SETTINGS_KEY = 'refsure:settings';

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  autoCheckArxiv: false,
  autoCheckOpenReview: false,
  historyEnabled: true,
};

/** The trimmed key, or undefined when it is absent, blank or not plausibly a key. */
function validKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const checked = validateOpenAlexKey(value);
  return checked.ok ? checked.key : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function validate(raw: unknown): Settings {
  const stored = isRecord(raw) ? raw : {};
  const key = validKey(stored['openAlexKey']);
  return {
    autoCheckArxiv: bool(stored['autoCheckArxiv'], DEFAULT_SETTINGS.autoCheckArxiv),
    autoCheckOpenReview: bool(stored['autoCheckOpenReview'], DEFAULT_SETTINGS.autoCheckOpenReview),
    historyEnabled: bool(stored['historyEnabled'], DEFAULT_SETTINGS.historyEnabled),
    ...(key !== undefined && { openAlexKey: key }),
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return validate(stored[SETTINGS_KEY]);
}

// Updates are read-modify-write; run them one at a time so two quick toggles cannot undo each other.
let writes: Promise<unknown> = Promise.resolve();

/**
 * Merges a patch into the stored settings. Values of the wrong type are ignored, as is an OpenAlex key
 * that is not plausibly one; a blank key clears it. The returned settings show what was actually kept.
 */
export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = async (): Promise<Settings> => {
    const current = await getSettings();
    const merged: Record<string, unknown> = { ...current };
    for (const field of ['autoCheckArxiv', 'autoCheckOpenReview', 'historyEnabled'] as const) {
      if (typeof patch[field] === 'boolean') merged[field] = patch[field];
    }
    if ('openAlexKey' in patch) {
      const key = validKey(patch.openAlexKey);
      if (key !== undefined) merged['openAlexKey'] = key;
      else delete merged['openAlexKey'];
    }
    const next = validate(merged);
    await browser.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  };
  const result = writes.then(run, run);
  writes = result.catch(() => undefined);
  return result;
}

/** Calls `cb` with the validated settings whenever they change. Returns a function that stops listening. */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    const change = changes[SETTINGS_KEY];
    if (area === 'local' && change !== undefined) cb(validate(change.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/**
 * Hands the user's OpenAlex key to the OpenAlex adapter. A key the adapter rejects (too short) is
 * dropped and reported as false: a bad key must never stop a check, which then runs on the free budget.
 */
export function applyOpenAlexKey(key: string | undefined): boolean {
  try {
    openalex.setApiKey(key);
    return true;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    openalex.setApiKey(undefined);
    return false;
  }
}
