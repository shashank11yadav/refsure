import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));

import { DEFAULT_SETTINGS, type Settings } from '../../../src/engine/settings';
import { maskKey, renderSettingsView, type SettingsApi } from '../../../src/ui/settingsView';
import { byText, click, everything, flush, makeDom, text } from '../helpers/dom';

const { doc, win } = makeDom();
const KEY = 'sk-live-abcdefgh1234abcd';

function setup(initial: Partial<Settings> = {}) {
  let current: Settings = { ...DEFAULT_SETTINGS, ...initial };
  const api = {
    get: vi.fn(() => Promise.resolve(current)),
    update: vi.fn((patch: Partial<Settings>) => {
      const next: Settings = { ...current, ...patch };
      // Like the real store: a blank key clears it, an implausible one is dropped.
      if ('openAlexKey' in patch) {
        const key = (patch.openAlexKey ?? '').trim();
        if (key.length >= 8 && key.length <= 128 && !/\s/.test(key)) next.openAlexKey = key;
        else delete next.openAlexKey;
      }
      current = next;
      return Promise.resolve(next);
    }),
    clearHistory: vi.fn(() => Promise.resolve(true)),
  } satisfies SettingsApi;
  const notify = vi.fn();
  const onBack = vi.fn();
  const view = renderSettingsView(doc, { settings: current, api, notify, onBack });
  doc.body.replaceChildren(view);
  return { view, api, notify, onBack, current: () => current };
}

function checkbox(view: Element, label: string): HTMLInputElement {
  const hit = [...view.querySelectorAll('label')].find((l) => (l.textContent ?? '').includes(label));
  const input = hit?.querySelector('input[type="checkbox"]');
  if (!input) throw new Error(`no checkbox labelled ${label}`);
  return input as HTMLInputElement;
}

function typeKey(view: Element, value: string): void {
  const input = view.querySelector<HTMLInputElement>('input.key-input');
  if (!input) throw new Error('no key input');
  input.value = value;
}

afterEach(() => vi.restoreAllMocks());

describe('settings view', () => {
  test('reflects the settings and turning on auto-check saves it', async () => {
    const { view, api } = setup({ autoCheckOpenReview: true });
    expect(checkbox(view, 'arXiv').checked).toBe(false);
    expect(checkbox(view, 'OpenReview').checked).toBe(true);
    expect(checkbox(view, 'history').checked).toBe(true);
    click(checkbox(view, 'arXiv'));
    await flush();
    expect(api.update).toHaveBeenCalledWith({ autoCheckArxiv: true });
  });

  test('the history setting says what turning it off means, including the cache', () => {
    const { view } = setup();
    expect(text(view)).toMatch(/no lookup cache|cache/i);
    expect(text(view)).toMatch(/nothing is saved/i);
  });

  test('turning history off asks first, then saves the setting and deletes saved checks', async () => {
    const { view, api, notify } = setup();
    click(checkbox(view, 'history'));
    await flush();
    expect(text(view)).toContain('Turning this off deletes saved checks.');
    expect(api.update).not.toHaveBeenCalled();
    expect(api.clearHistory).not.toHaveBeenCalled();
    click(byText(view, 'button', 'Turn off'));
    await flush();
    expect(api.update).toHaveBeenCalledWith({ historyEnabled: false });
    expect(api.clearHistory).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Saved checks deleted.');
    expect(checkbox(view, 'history').checked).toBe(false);
  });

  test('if saving the setting fails, nothing is deleted, the switch goes back and the user is told', async () => {
    const { view, api, notify } = setup();
    api.update.mockRejectedValueOnce(new Error('storage down'));
    click(checkbox(view, 'history'));
    click(byText(view, 'button', 'Turn off'));
    await flush();
    expect(api.clearHistory).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalledWith('Saved checks deleted.');
    expect(notify).toHaveBeenCalledWith("Couldn't turn history off. Try again.");
    expect(checkbox(view, 'history').checked).toBe(true);
  });

  test('if the store keeps history on, that counts as a failure too', async () => {
    const { view, api, notify } = setup();
    api.update.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, historyEnabled: true });
    click(checkbox(view, 'history'));
    click(byText(view, 'button', 'Turn off'));
    await flush();
    expect(api.clearHistory).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Couldn't turn history off. Try again.");
  });

  test('cancelling the confirm changes nothing', async () => {
    const { view, api } = setup();
    click(checkbox(view, 'history'));
    click(byText(view, 'button', 'Cancel'));
    await flush();
    expect(api.update).not.toHaveBeenCalled();
    expect(api.clearHistory).not.toHaveBeenCalled();
    expect(checkbox(view, 'history').checked).toBe(true);
    expect(text(view)).not.toContain('Turning this off deletes saved checks.');
  });

  test('turning history back on needs no confirm', async () => {
    const { view, api } = setup({ historyEnabled: false });
    click(checkbox(view, 'history'));
    await flush();
    expect(api.update).toHaveBeenCalledWith({ historyEnabled: true });
    expect(api.clearHistory).not.toHaveBeenCalled();
  });

  test('Clear history asks the background and confirms after it says ok', async () => {
    const { view, api, notify } = setup();
    click(byText(view, 'button', 'Clear history'));
    await flush();
    expect(api.clearHistory).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('History cleared.');
  });

  test('a failed clear says so instead of confirming', async () => {
    const { view, api, notify } = setup();
    api.clearHistory.mockResolvedValueOnce(false);
    click(byText(view, 'button', 'Clear history'));
    await flush();
    expect(notify).toHaveBeenCalledWith("Couldn't clear history. Try again.");
  });

  test('Back returns to the results', () => {
    const { view, onBack } = setup();
    click(byText(view, 'button', 'Back'));
    expect(onBack).toHaveBeenCalled();
  });
});

describe('OpenAlex key', () => {
  test('lives in a collapsed Advanced section', () => {
    const { view } = setup();
    const details = view.querySelector('details');
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Advanced');
    expect(text(details as Element)).toContain('Your own free OpenAlex API key');
  });

  test.each([
    ['too short', 'abc1234', /8/],
    ['too long', 'a'.repeat(201), /200/],
    ['has a space inside', 'abcd efgh1234', /space/i],
  ])('an invalid key (%s) shows an inline error and is not saved', async (_name, value, message) => {
    const { view, api } = setup();
    typeKey(view, value);
    click(byText(view, 'button', 'Save key'));
    await flush();
    expect(api.update).not.toHaveBeenCalled();
    const error = view.querySelector('.key-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toMatch(message);
  });

  test('a key with a non-ASCII character gets a clear inline error and is not saved', async () => {
    const { view, api } = setup();
    typeKey(view, 'abcdefgh12é45678');
    click(byText(view, 'button', 'Save key'));
    await flush();
    expect(api.update).not.toHaveBeenCalled();
    expect(view.querySelector('.key-error')?.textContent).toMatch(/plain/);
  });

  test('OpenAlex key input shows only last 4 characters after save', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { view, api, notify } = setup();
    typeKey(view, `  ${KEY}  `);
    click(byText(view, 'button', 'Save key'));
    await flush();
    expect(api.update).toHaveBeenCalledWith({ openAlexKey: KEY });
    expect(text(view)).toContain('••••abcd');
    expect(everything(view)).not.toContain(KEY);
    expect(everything(view)).not.toContain('efgh1234');
    expect(view.querySelector('input.key-input')).toBeNull();
    expect(byText(view, 'button', 'Remove key')).toBeTruthy();
    expect(notify).toHaveBeenCalledWith('Key saved.');
    for (const spy of [log, warn, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
  });

  test('a key that was already saved shows only its last 4 characters', () => {
    const { view } = setup({ openAlexKey: KEY });
    expect(text(view)).toContain('••••abcd');
    expect(everything(view)).not.toContain(KEY);
  });

  test('Remove clears it and brings the field back', async () => {
    const { view, api, notify } = setup({ openAlexKey: KEY });
    click(byText(view, 'button', 'Remove key'));
    await flush();
    expect(api.update).toHaveBeenCalledWith({ openAlexKey: '' });
    expect(view.querySelector('input.key-input')).not.toBeNull();
    expect(notify).toHaveBeenCalledWith('Key removed.');
  });

  test('if the store drops the key, the user is told and nothing is shown as saved', async () => {
    const { view, api } = setup();
    api.update.mockResolvedValueOnce({ ...DEFAULT_SETTINGS });
    typeKey(view, KEY);
    click(byText(view, 'button', 'Save key'));
    await flush();
    expect(view.querySelector('.key-error')?.textContent).toMatch(/wasn't saved/);
    expect(text(view)).not.toContain('••••');
  });

  test('the field is masked, not autofilled and not spell-checked', () => {
    const { view } = setup();
    const input = view.querySelector('input.key-input');
    expect(input?.getAttribute('type')).toBe('password');
    expect(input?.getAttribute('autocomplete')).toBe('off');
    expect(input?.getAttribute('spellcheck')).toBe('false');
  });

  test('Escape inside the key field does not leave Settings, and the typed key stays', () => {
    const { view, onBack } = setup();
    typeKey(view, 'abcdefgh1234');
    const input = view.querySelector<HTMLInputElement>('input.key-input') as HTMLInputElement;
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event);
    expect(onBack).not.toHaveBeenCalled();
    expect(input.value).toBe('abcdefgh1234');
    // Elsewhere on the page Escape still leaves.
    (view.querySelector('h1') as HTMLElement).dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('maskKey shows bullets and the last four characters', () => {
    expect(maskKey('abcdefgh1234')).toBe('••••1234');
  });
});

void win;
