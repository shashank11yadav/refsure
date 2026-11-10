// The settings page of the side panel (DESIGN 7.3): two auto-check switches, history on/off and clear,
// and a collapsed Advanced section for the optional OpenAlex key.
//
// The key is the one secret here. It is typed into a password field, validated, handed to the store, and
// the field is then removed: afterwards only "••••" and its last four characters ever appear in the page,
// and the key is never written to the console.

import { OPENALEX_KEY_MAX, OPENALEX_KEY_MIN, validateOpenAlexKey, type KeyRefusal } from '../core/apiKey';
import type { Settings } from '../engine/settings';
import { button, el, uid } from './dom';

export interface SettingsApi {
  get(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
  /** Asks the background to delete history and cache; false when it could not. */
  clearHistory(): Promise<boolean>;
}

export interface SettingsViewProps {
  settings: Settings;
  api: SettingsApi;
  /** Shows a short message to the user (a toast). */
  notify(message: string): void;
  onBack(): void;
}

const KEY_ERROR: Readonly<Record<KeyRefusal, string>> = {
  length: `That doesn't look like a key. It should be ${OPENALEX_KEY_MIN} to ${OPENALEX_KEY_MAX} characters.`,
  space: 'A key has no spaces in it. Check for a stray space or line break.',
  ascii: 'A key uses only plain letters, digits and symbols. This one has other characters, so check what you copied.',
};
const KEY_DROPPED_ERROR = "That doesn't look like a valid key, so it wasn't saved.";

/** "••••1234": all that is ever shown of a saved key. */
export function maskKey(key: string): string {
  return `••••${key.slice(-4)}`;
}

type Toggle = 'autoCheckArxiv' | 'autoCheckOpenReview' | 'historyEnabled';

export function renderSettingsView(doc: Document, props: SettingsViewProps): HTMLElement {
  const { api, notify } = props;
  const view = el(doc, 'div', { class: 'settings' });
  let current = props.settings;
  let confirmingHistoryOff = false;
  let busy = false;

  const fail = (message: string): void => notify(message);

  /** Saves one switch; false when it could not be saved (the switch then goes back to what is stored). */
  async function setToggle(name: Toggle, value: boolean): Promise<boolean> {
    let saved: boolean;
    try {
      current = await api.update({ [name]: value });
      saved = current[name] === value;
    } catch {
      saved = false;
    }
    draw(name);
    return saved;
  }

  async function turnHistoryOff(): Promise<void> {
    confirmingHistoryOff = false;
    // Delete only once the setting is really off: otherwise history would go while still being kept.
    if (!(await setToggle('historyEnabled', false))) {
      fail("Couldn't turn history off. Try again.");
      return;
    }
    notify((await safeClear()) ? 'Saved checks deleted.' : "Couldn't clear history. Try again.");
  }

  async function safeClear(): Promise<boolean> {
    try {
      return await api.clearHistory();
    } catch {
      return false;
    }
  }

  function toggle(name: Toggle, title: string, help: string): HTMLElement {
    const input = el(doc, 'input', { type: 'checkbox', 'data-focus': name, ...(current[name] && { checked: true }) });
    input.checked = current[name];
    input.addEventListener('change', () => {
      if (name === 'historyEnabled' && !input.checked) {
        confirmingHistoryOff = true;
        draw('confirm-cancel');
        return;
      }
      void setToggle(name, input.checked).then((saved) => {
        if (!saved) fail("Couldn't save that setting. Try again.");
      });
    });
    const helpId = uid('help');
    input.setAttribute('aria-describedby', helpId);
    return el(doc, 'div', { class: 'setting' }, el(doc, 'label', { class: 'switch' }, input, el(doc, 'span', {}, title)), el(doc, 'p', { class: 'help', id: helpId }, help));
  }

  function confirmBox(): HTMLElement {
    return el(
      doc,
      'div',
      { class: 'confirm', role: 'group', 'aria-label': 'Confirm turning history off' },
      el(doc, 'p', {}, 'Turning this off deletes saved checks.'),
      el(doc, 'div', { class: 'banner-actions' }, button(doc, 'Turn off', () => void turnHistoryOff(), { class: 'btn primary' }), button(doc, 'Cancel', () => {
        confirmingHistoryOff = false;
        draw('historyEnabled');
      }, { class: 'btn', 'data-focus': 'confirm-cancel' })),
    );
  }

  function keySection(): HTMLElement {
    const section = el(doc, 'div', { class: 'advanced-body' });
    const inputId = uid('openalex');
    section.append(el(doc, 'label', { class: 'field-label', for: inputId }, 'Your own free OpenAlex API key'));
    section.append(el(doc, 'p', { class: 'help' }, 'Optional. Raises the daily search budget. Stored only on this device and sent only to OpenAlex.'));
    if (current.openAlexKey !== undefined) {
      // Only the mask: the full key is not put in the page again.
      section.append(
        el(doc, 'p', {}, 'Key saved: ', el(doc, 'span', { class: 'key-mask' }, maskKey(current.openAlexKey))),
        button(doc, 'Remove key', () => void removeKey(), { class: 'btn', 'data-focus': 'key' }),
      );
      return section;
    }
    const input = el(doc, 'input', { class: 'key-input', id: inputId, type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'data-focus': 'key' });
    const error = el(doc, 'p', { class: 'key-error', role: 'alert' });
    const save = button(doc, 'Save key', () => void saveKey(input, error, save), { class: 'btn primary' });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save.click();
      // Escape leaves Settings elsewhere on the page, but not from here: a key typed and not saved would be lost.
      else if (event.key === 'Escape') event.stopPropagation();
    });
    section.append(el(doc, 'div', { class: 'key-row' }, input, save), error);
    return section;
  }

  async function saveKey(input: HTMLInputElement, error: HTMLElement, save: HTMLButtonElement): Promise<void> {
    if (busy) return;
    const checked = validateOpenAlexKey(input.value);
    if (!checked.ok) {
      error.textContent = KEY_ERROR[checked.reason];
      return;
    }
    error.textContent = '';
    busy = true;
    save.setAttribute('disabled', '');
    try {
      current = await api.update({ openAlexKey: checked.key });
    } catch {
      busy = false;
      save.removeAttribute('disabled');
      error.textContent = "Couldn't save the key. Try again.";
      return;
    }
    busy = false;
    if (current.openAlexKey === undefined) {
      // The store applies its own check and silently drops a key it does not accept.
      save.removeAttribute('disabled');
      error.textContent = KEY_DROPPED_ERROR;
      return;
    }
    input.value = '';
    notify('Key saved.');
    draw('key');
  }

  async function removeKey(): Promise<void> {
    try {
      current = await api.update({ openAlexKey: '' });
      notify('Key removed.');
    } catch {
      fail("Couldn't remove the key. Try again.");
    }
    draw('key');
  }

  function draw(focus?: string): void {
    const advanced = el(doc, 'details', { class: 'advanced' }, el(doc, 'summary', {}, 'Advanced'), keySection());
    // A redraw would close a section the user has open.
    if (view.querySelector('details')?.hasAttribute('open') === true) advanced.setAttribute('open', '');
    view.replaceChildren(
      el(doc, 'div', { class: 'settings-head' }, button(doc, 'Back', () => props.onBack(), { class: 'btn back' }), el(doc, 'h1', {}, 'Settings')),
      toggle('autoCheckArxiv', 'Check arXiv papers automatically', "Starts a check as soon as you open an arXiv paper. Off by default, so nothing is sent until you choose to check."),
      toggle('autoCheckOpenReview', 'Check public OpenReview papers automatically', 'Same, for public OpenReview papers. Private submissions are never checked.'),
      toggle('historyEnabled', 'Keep history', 'Saves your latest check of each paper on this device, so opening it again is instant. When this is off, nothing is saved and RefSure keeps no lookup cache either.'),
      ...(confirmingHistoryOff ? [confirmBox()] : []),
      el(doc, 'div', { class: 'setting' }, button(doc, 'Clear history', () => void clearNow(), { class: 'btn' }), el(doc, 'p', { class: 'help' }, 'Deletes saved checks and the lookup cache on this device.')),
      advanced,
    );
    if (focus !== undefined) view.querySelector<HTMLElement>(`[data-focus="${focus}"]`)?.focus();
  }

  async function clearNow(): Promise<void> {
    notify((await safeClear()) ? 'History cleared.' : "Couldn't clear history. Try again.");
  }

  // Escape cancels what is open: the history confirmation first, otherwise the whole page.
  view.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    if (confirmingHistoryOff) {
      confirmingHistoryOff = false;
      draw('historyEnabled');
      return;
    }
    props.onBack();
  });

  draw();
  return view;
}
