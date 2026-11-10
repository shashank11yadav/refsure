import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import { fakeBrowser } from 'wxt/testing/fake-browser';
import { applyOpenAlexKey, DEFAULT_SETTINGS, getSettings, onSettingsChanged, SETTINGS_KEY, updateSettings } from '../../../src/engine/settings';
import { openalex } from '../../../src/sources/openalex';

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('settings', () => {
  test('defaults are all off except history', () => {
    expect(DEFAULT_SETTINGS).toEqual({ autoCheckArxiv: false, autoCheckOpenReview: false, historyEnabled: true });
  });

  test('nothing stored gives the defaults', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test('a corrupt stored value falls back to its default', async () => {
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { autoCheckArxiv: 'yes', historyEnabled: 0, autoCheckOpenReview: true } });
    expect(await getSettings()).toEqual({ autoCheckArxiv: false, autoCheckOpenReview: true, historyEnabled: true });
  });

  test('a field the extension no longer has (welcomeSeen, from an earlier version) is dropped', async () => {
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { historyEnabled: false, welcomeSeen: true } });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, historyEnabled: false });
    expect(await updateSettings({ autoCheckArxiv: true })).not.toHaveProperty('welcomeSeen');
    expect((await fakeBrowser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]).not.toHaveProperty('welcomeSeen');
  });

  test('a stored value that is not an object gives the defaults', async () => {
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: 'garbage' });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test('update merges, persists and returns the result', async () => {
    const next = await updateSettings({ autoCheckArxiv: true });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, autoCheckArxiv: true });
    expect(await getSettings()).toEqual(next);
    expect(await updateSettings({ historyEnabled: false })).toEqual({ ...DEFAULT_SETTINGS, autoCheckArxiv: true, historyEnabled: false });
  });

  test('the OpenAlex key is trimmed and must be a plausible length', async () => {
    expect((await updateSettings({ openAlexKey: '  abcdefgh12345678  ' })).openAlexKey).toBe('abcdefgh12345678');
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { openAlexKey: 'short' } });
    expect((await getSettings()).openAlexKey).toBeUndefined();
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { openAlexKey: 42 } });
    expect((await getSettings()).openAlexKey).toBeUndefined();
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { openAlexKey: 'x'.repeat(500) } });
    expect((await getSettings()).openAlexKey).toBeUndefined();
  });

  test('the store accepts what the panel accepts: up to 200 printable ASCII characters, nothing else', async () => {
    const long = 'k'.repeat(150) + 'abcd';
    expect((await updateSettings({ openAlexKey: long })).openAlexKey).toBe(long);
    expect((await updateSettings({ openAlexKey: 'k'.repeat(201) })).openAlexKey).toBeUndefined();
    expect((await updateSettings({ openAlexKey: 'abcdefgh12é45678' })).openAlexKey).toBeUndefined();
  });

  test('an invalid key in an update is dropped, a blank one clears the stored key', async () => {
    await updateSettings({ openAlexKey: 'abcdefgh12345678' });
    expect((await updateSettings({ openAlexKey: 'tiny' })).openAlexKey).toBeUndefined();
    await updateSettings({ openAlexKey: 'abcdefgh12345678' });
    expect((await updateSettings({ openAlexKey: '   ' })).openAlexKey).toBeUndefined();
  });

  test('settings live in storage.local and nothing is written to storage.sync', async () => {
    await updateSettings({ autoCheckOpenReview: true });
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
    expect(await fakeBrowser.storage.local.get(SETTINGS_KEY)).toHaveProperty(SETTINGS_KEY);
  });

  test('onSettingsChanged reports validated settings and can be unsubscribed', async () => {
    const seen: unknown[] = [];
    const stop = onSettingsChanged((s) => seen.push(s));
    await updateSettings({ autoCheckOpenReview: true });
    expect(seen).toEqual([{ ...DEFAULT_SETTINGS, autoCheckOpenReview: true }]);
    stop();
    await updateSettings({ autoCheckOpenReview: false });
    expect(seen).toHaveLength(1);
  });

  test('applyOpenAlexKey passes a good key on and never throws for a bad one', () => {
    const set = vi.spyOn(openalex, 'setApiKey');
    expect(applyOpenAlexKey('abcdefgh12345678')).toBe(true);
    expect(set).toHaveBeenCalledWith('abcdefgh12345678');
    expect(applyOpenAlexKey('abc')).toBe(false);
    expect(applyOpenAlexKey(undefined)).toBe(true);
    expect(set).toHaveBeenLastCalledWith(undefined);
  });
});
