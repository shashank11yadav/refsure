import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Window } from 'happy-dom';
import { trustedClick } from '../helpers/dom';
import { snapshot } from '../helpers/snapshot';
import { recordShadowRoots } from '../helpers/shadow';
import type { Status } from '../../../src/core/types';
import { STATUS_WORD } from '../../../src/core/status';
import { BADGE_CSS, clearBadges, renderBadge, scrollToRef, setReferenceItems, showBadges } from '../../../src/ui/badge';

let win: Window;
let doc: Document;
let captured: { mode: string; root: ShadowRoot }[];
let restoreAttachShadow: () => void;

function makePage(count: number): Document {
  const items = Array.from({ length: count }, (_, i) => `<li class="ltx_bibitem" id="bib.bib${i + 1}"><span class="ltx_tag ltx_tag_bibitem">[${i + 1}]</span><span class="ltx_bibblock">Ref ${i + 1}</span></li>`).join('');
  return new win.DOMParser().parseFromString(
    `<!doctype html><html><head><title>Paper</title></head><body><main><h1>Title</h1><p id="intro">Intro</p><form><input id="secret" value="hunter2"></form></main><ul class="ltx_biblist">${items}</ul></body></html>`,
    'text/html',
  ) as unknown as Document;
}

function itemsOf(page: Document): Map<number, HTMLElement> {
  const map = new Map<number, HTMLElement>();
  page.querySelectorAll<HTMLElement>('li.ltx_bibitem').forEach((li, i) => map.set(i + 1, li));
  return map;
}

/** The whole page with our hosts left out: what must not change when badges come and go. */
function pageOutsideHosts(page: Document): string {
  return snapshot(page.documentElement, ['refsure-badge']);
}

function rootOf(host: Element): ShadowRoot {
  const hit = captured.find((c) => c.root.host === host);
  if (!hit) throw new Error('no shadow root was attached to that host');
  return hit.root;
}

function highlighted(host: Element): boolean {
  return rootOf(host).querySelector('[data-highlight]') !== null;
}

async function flushed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  win = new Window({ url: 'https://arxiv.org/html/1706.03762v7' });
  doc = makePage(3);
  captured = [];
  const recording = recordShadowRoots(win);
  captured = recording.roots;
  restoreAttachShadow = recording.restore;
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
});

afterEach(() => {
  clearBadges();
  restoreAttachShadow();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('renderBadge', () => {
  test('attaches a closed shadow root: the page cannot reach into it', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'verified', reason: 'Found in Crossref.' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.mode).toBe('closed');
    expect(host.shadowRoot).toBeNull();
  });

  test.each<[Status, string, string]>([
    ['verified', '✓', 'Verified'],
    ['details_differ', '⚠', 'Details differ'],
    ['wrong_id', '⚠', 'Wrong ID'],
    ['retracted', '⛔', 'Retracted'],
    ['not_found', '✗', 'Not found'],
    ['cant_check', '?', "Can't check"],
  ])('%s shows icon, short word and popover; "RefSure: word" is its name and the reason its description', (status, icon, word) => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 4, status, reason: 'The reason in full.' });
    const root = rootOf(host);
    const button = root.querySelector('button');
    expect(button).not.toBeNull();
    expect(STATUS_WORD[status]).toBe(word);
    // The hidden prefix tells a screen-reader user who added the badge; sighted users see icon and word only.
    expect(button?.textContent).toBe(`RefSure: ${icon}${word}`);
    const prefix = button?.querySelector('.sr');
    expect(prefix?.textContent).toBe('RefSure: ');
    expect(prefix?.getAttribute('aria-hidden')).toBeNull();
    // The reason is shown in the popover below, not as a native title (which never appears on keyboard focus
    // and would be announced twice). A screen reader hears it once, as the description: no aria-label.
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.hasAttribute('aria-label')).toBe(false);
    const describedBy = button?.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    const reason = root.getElementById ? root.getElementById(describedBy) : root.querySelector(`#${describedBy}`);
    expect(reason?.textContent).toBe('The reason in full.');
    expect(reason?.getAttribute('class')).toBe('tip');
    expect(reason?.getAttribute('role')).toBe('tooltip');
    expect(reason?.querySelector('button')).toBeNull();
    // The icon is decoration: the word carries the meaning for a screen reader.
    expect(button?.querySelector('[aria-hidden="true"]')?.textContent).toBe(icon);
  });

  test('is a real button that keyboard users can reach', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'verified', reason: 'ok' });
    const button = rootOf(host).querySelector('button');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.tabIndex).toBeGreaterThanOrEqual(0);
  });

  test('a click reports the badge index', () => {
    const host = doc.createElement('refsure-badge');
    const clicked = vi.fn();
    renderBadge(host, { index: 7, status: 'verified', reason: 'ok' }, clicked);
    trustedClick(rootOf(host).querySelector('button') as Element);
    expect(clicked).toHaveBeenCalledExactlyOnceWith(7);
  });

  // A click a script makes is not the reader's, and a badge click can open the panel.
  test('a click that is not trusted (made by a script) is ignored', () => {
    const host = doc.createElement('refsure-badge');
    const clicked = vi.fn();
    renderBadge(host, { index: 7, status: 'verified', reason: 'ok' }, clicked);
    const button = rootOf(host).querySelector('button') as HTMLElement;
    button.click();
    button.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
    expect(clicked).not.toHaveBeenCalled();
  });

  test('a reason holding markup is shown as text and never becomes elements', () => {
    const reason = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'not_found', reason });
    const root = rootOf(host);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('.tip')?.textContent).toBe(reason);
    expect(doc.querySelector('img')).toBeNull();
  });

  test('a reason longer than a popover can hold is cut short with an ellipsis', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'cant_check', reason: 'word '.repeat(300) });
    const shown = rootOf(host).querySelector('.tip')?.textContent ?? '';
    expect(shown.length).toBeLessThanOrEqual(1000);
    expect(shown.endsWith('word…')).toBe(true);
  });

  test('renders again on the same host without a second shadow root', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'cant_check', reason: 'first' });
    renderBadge(host, { index: 1, status: 'verified', reason: 'second' });
    expect(captured).toHaveLength(1);
    const buttons = rootOf(host).querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(rootOf(host).querySelector('.tip')?.textContent).toBe('second');
    expect(buttons[0]?.textContent).toBe('RefSure: ✓Verified');
  });

  test('the verdict is not readable from the page: the host carries no attributes and no data', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'retracted', reason: 'The cited version has been formally retracted' });
    expect(host.getAttributeNames()).toEqual([]);
    expect(snapshot(host)).not.toMatch(/retracted|status|highlight/i);
    // It lives inside the closed root instead, where the styles can still see it.
    const marked = rootOf(host).querySelector('[data-status]');
    expect(marked?.getAttribute('data-status')).toBe('retracted');
    expect(marked?.querySelector('button')).not.toBeNull();
  });

  test('a redraw updates the status inside the root and leaves the host bare', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'cant_check', reason: 'a' });
    renderBadge(host, { index: 1, status: 'verified', reason: 'b' });
    expect(host.getAttributeNames()).toEqual([]);
    const root = rootOf(host);
    expect(root.querySelectorAll('[data-status]')).toHaveLength(1);
    expect(root.querySelector('[data-status]')?.getAttribute('data-status')).toBe('verified');
  });

  test('its styles live in the shadow root, not in the page, and follow the reader\'s settings', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'verified', reason: 'ok' });
    const root = rootOf(host);
    const inRoot = (root as unknown as { adoptedStyleSheets?: unknown[] }).adoptedStyleSheets?.length ?? 0;
    expect(inRoot + root.querySelectorAll('style').length).toBeGreaterThan(0);
    expect(doc.querySelectorAll('style, link')).toHaveLength(0);
    expect(BADGE_CSS).toContain('prefers-color-scheme: dark');
    expect(BADGE_CSS).toContain('prefers-reduced-motion');
    expect(BADGE_CSS).toContain('all: initial');
  });
});

describe('styling the badge (Minor 3 and 5)', () => {
  const adopted = (root: ShadowRoot): number => (root as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets.length;
  const hostInWindow = (): HTMLElement => win.document.createElement('refsure-badge') as unknown as HTMLElement;

  afterEach(() => vi.restoreAllMocks());

  test('the stylesheet is adopted by the shadow root AND repeated in a <style> element inside it', () => {
    const host = hostInWindow();
    renderBadge(host, { index: 1, status: 'verified', reason: 'ok' });
    const root = rootOf(host);
    expect(adopted(root)).toBe(1);
    // Adopted sheets can fail without an error in Firefox content scripts; the duplicate rules are harmless.
    expect(root.querySelectorAll('style')).toHaveLength(1);
    expect(root.querySelector('style')?.textContent).toBe(BADGE_CSS);
    const sheet = (root as unknown as { adoptedStyleSheets: { cssRules: { length: number } }[] }).adoptedStyleSheets[0];
    expect(sheet?.cssRules.length).toBeGreaterThan(0);
  });

  test('a redraw does not add the styles again', () => {
    const host = hostInWindow();
    renderBadge(host, { index: 1, status: 'verified', reason: 'a' });
    renderBadge(host, { index: 1, status: 'retracted', reason: 'b' });
    expect(adopted(rootOf(host))).toBe(1);
    expect(rootOf(host).querySelectorAll('style')).toHaveLength(1);
  });

  test('the <style> element is there when the sheet cannot be built', () => {
    vi.spyOn(win.CSSStyleSheet.prototype, 'replaceSync').mockImplementation(() => {
      throw new Error('not allowed');
    });
    const host = hostInWindow();
    renderBadge(host, { index: 1, status: 'verified', reason: 'ok' });
    const root = rootOf(host);
    expect(adopted(root)).toBe(0);
    expect(root.querySelectorAll('style')).toHaveLength(1);
    expect(root.querySelector('style')?.textContent).toBe(BADGE_CSS);
  });

  test('the <style> element is there when the root refuses the sheet', () => {
    const proto = win.ShadowRoot.prototype as unknown as object;
    Object.defineProperty(proto, 'adoptedStyleSheets', {
      configurable: true,
      get: () => [],
      set: () => {
        throw new Error('cross-realm sheet');
      },
    });
    try {
      const host = hostInWindow();
      renderBadge(host, { index: 1, status: 'verified', reason: 'ok' });
      expect(rootOf(host).querySelector('style')?.textContent).toBe(BADGE_CSS);
    } finally {
      Reflect.deleteProperty(proto, 'adoptedStyleSheets');
    }
  });

  test('the <style> element is there where the page has no window to build a sheet in', () => {
    Object.defineProperty(doc, 'defaultView', { value: null, configurable: true });
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'verified', reason: 'ok' });
    expect(rootOf(host).querySelector('style')?.textContent).toBe(BADGE_CSS);
  });

  test('the badge text scales with the reader\'s font size: em, not a fixed pixel size', () => {
    const font = /button\s*{[^}]*?font:\s*([^;]+);/.exec(BADGE_CSS)?.[1] ?? '';
    expect(font).toMatch(/\d(?:\.\d+)?r?em\b/);
    expect(font).not.toMatch(/\dpx/);
    expect(BADGE_CSS).not.toMatch(/font(?:-size)?:[^;]*\b\d+px/);
  });
});

describe('Not found has its own muted colour', () => {
  const channel = (hex: string, i: number): number => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string): number => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  };
  const token = (css: string, name: string): string[] => [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'gi'))].map((m) => (m[1] ?? '').toLowerCase());
  const themeCss = readFileSync(join(process.cwd(), 'src/ui/theme.css'), 'utf8');

  test('theme.css: light and dark Not found tokens are the muted pair, not the Retracted red', () => {
    expect(token(themeCss, '--not_found-fg')).toEqual(['#5b2a35', '#f0c4cc']);
    expect(token(themeCss, '--not_found-bg')).toEqual(['#f6edef', '#2e1d21']);
    expect(token(themeCss, '--not_found-line')).toEqual(['#a8707b', '#a8707b']);
    expect(token(themeCss, '--retracted-fg')).not.toEqual(token(themeCss, '--not_found-fg'));
  });

  test('the badge stylesheet uses the same muted pair, still with a dashed border', () => {
    const rules = [...BADGE_CSS.matchAll(/\[data-status="not_found"\][^{]*{([^}]*)}/g)].map((m) => m[1] ?? '').join(' ');
    expect(rules).toContain('--fg: #5b2a35');
    expect(rules).toContain('--bg: #f6edef');
    expect(rules).toContain('--line: #a8707b');
    expect(rules).toContain('--fg: #f0c4cc');
    expect(rules).toContain('--bg: #2e1d21');
    expect(BADGE_CSS).toMatch(/not_found"\] button { border-style: dashed; }/);
  });

  test.each([
    ['light', '#5b2a35', '#f6edef'],
    ['dark', '#f0c4cc', '#2e1d21'],
  ])('the %s text on its pill passes AA (4.5:1)', (_scheme, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the badge follows the page\'s own colour scheme', () => {
  const wrapOf = (host: Element): Element | null => rootOf(host).querySelector('.wrap');

  test('with html[data-theme] set, the badge carries that theme inside its root; unset, it carries none', () => {
    doc.documentElement.setAttribute('data-theme', 'light');
    const a = doc.createElement('refsure-badge');
    renderBadge(a, { index: 1, status: 'verified', reason: 'ok' });
    expect(wrapOf(a)?.getAttribute('data-theme')).toBe('light');
    doc.documentElement.setAttribute('data-theme', 'dark');
    const b = doc.createElement('refsure-badge');
    renderBadge(b, { index: 2, status: 'verified', reason: 'ok' });
    expect(wrapOf(b)?.getAttribute('data-theme')).toBe('dark');
    doc.documentElement.removeAttribute('data-theme');
    const c = doc.createElement('refsure-badge');
    renderBadge(c, { index: 3, status: 'verified', reason: 'ok' });
    expect(wrapOf(c)?.hasAttribute('data-theme')).toBe(false);
    // The host stays bare: the theme is marked inside the closed root only.
    expect(a.getAttributeNames()).toEqual([]);
  });

  test('any other value of the attribute is ignored', () => {
    doc.documentElement.setAttribute('data-theme', 'sepia"><img src=x>');
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'verified', reason: 'ok' });
    expect(wrapOf(host)?.hasAttribute('data-theme')).toBe(false);
  });

  test('the class of the wrapper never changes (the e2e reader finds it by that class)', () => {
    doc.documentElement.setAttribute('data-theme', 'dark');
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'verified', reason: 'ok' });
    expect(wrapOf(host)?.getAttribute('class')).toBe('wrap');
  });

  test('toggling the attribute on a page with badges restyles them without a new check', async () => {
    setReferenceItems(itemsOf(doc));
    showBadges([{ index: 1, status: 'verified', reason: 'ok' }], () => undefined);
    await flushed();
    const host = doc.querySelector('refsure-badge') as Element;
    expect(wrapOf(host)?.hasAttribute('data-theme')).toBe(false);
    doc.documentElement.setAttribute('data-theme', 'dark');
    await flushed();
    expect(wrapOf(host)?.getAttribute('data-theme')).toBe('dark');
    doc.documentElement.setAttribute('data-theme', 'light');
    await flushed();
    expect(wrapOf(host)?.getAttribute('data-theme')).toBe('light');
    doc.documentElement.removeAttribute('data-theme');
    await flushed();
    expect(wrapOf(host)?.hasAttribute('data-theme')).toBe(false);
  });

  test('after clearBadges the page is no longer watched', async () => {
    setReferenceItems(itemsOf(doc));
    showBadges([{ index: 1, status: 'verified', reason: 'ok' }], () => undefined);
    await flushed();
    const host = doc.querySelector('refsure-badge') as Element;
    clearBadges();
    doc.documentElement.setAttribute('data-theme', 'dark');
    await flushed();
    expect(wrapOf(host)?.hasAttribute('data-theme')).toBe(false);
  });

  test('the stylesheet has dark rules for the attribute and skips the media query when the page says light', () => {
    expect(BADGE_CSS).toContain('.wrap[data-theme="dark"]');
    expect(BADGE_CSS).toMatch(/@media \(prefers-color-scheme: dark\) {[^@]*\.wrap:not\(\[data-theme="light"\]\)/);
  });
});

describe('badge popover and line height', () => {
  test('the reason shows on keyboard focus and on hover, from inside the root', () => {
    expect(BADGE_CSS).toMatch(/button:focus-visible \+ \.tip/);
    expect(BADGE_CSS).toMatch(/button:hover \+ \.tip/);
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'verified', reason: 'Why.' });
    const tip = rootOf(host).querySelector('.tip');
    // It comes straight after the button so the sibling selectors above reach it.
    expect(tip?.previousElementSibling?.tagName).toBe('BUTTON');
  });

  test('the popover is not displayed at all until shown, so it adds nothing to the page width', () => {
    const tipRule = /\n\.tip {([^}]*)}/.exec(BADGE_CSS)?.[1] ?? '';
    expect(tipRule).toMatch(/display:\s*none/);
    expect(tipRule).not.toMatch(/visibility/);
    expect(BADGE_CSS).toMatch(/button:focus-visible \+ \.tip, button:hover \+ \.tip, \.tip:hover {\s*display:\s*block/);
    expect(BADGE_CSS).toMatch(/\.wrap\[data-tip-off\] \.tip {\s*display:\s*none/);
  });

  test('the popover opens from the badge\'s end edge and its width is capped to the viewport', () => {
    const tipRule = /\n\.tip {([^}]*)}/.exec(BADGE_CSS)?.[1] ?? '';
    expect(tipRule).toMatch(/inset-inline-end:\s*0/);
    expect(tipRule).not.toMatch(/inset-inline-start/);
    expect(tipRule).toMatch(/max-width:\s*min\(22em, calc\(100vw - 1rem\)\)/);
  });

  describe('a shown popover is kept inside the viewport', () => {
    function shown(rect: { left: number; right: number }, clientWidth: number): HTMLElement {
      Object.defineProperty(doc.documentElement, 'clientWidth', { value: clientWidth, configurable: true });
      const host = doc.createElement('refsure-badge');
      renderBadge(host, { index: 1, status: 'verified', reason: 'Why.' });
      const tip = rootOf(host).querySelector('.tip') as HTMLElement;
      tip.getBoundingClientRect = () => ({ ...rect, width: rect.right - rect.left, top: 0, bottom: 0, height: 0, x: rect.left, y: 0, toJSON: () => ({}) });
      const button = rootOf(host).querySelector('button') as HTMLElement;
      button.dispatchEvent(new win.Event('mouseenter') as unknown as Event);
      return tip;
    }

    test('shifted right when it would start left of the viewport', () => {
      expect(shown({ left: -40, right: 200 }, 400).style.transform).toBe('translateX(48px)');
    });

    test('shifted left when it would end right of the viewport', () => {
      expect(shown({ left: 200, right: 430 }, 400).style.transform).toBe('translateX(-38px)');
    });

    test('left alone when it already fits', () => {
      expect(shown({ left: 20, right: 300 }, 400).style.transform).toBe('');
    });
  });

  test('Escape dismisses the popover until the pointer or focus leaves', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'verified', reason: 'Why.' });
    const wrap = rootOf(host).querySelector('.wrap');
    const button = rootOf(host).querySelector('button') as HTMLElement;
    button.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event);
    expect(wrap?.hasAttribute('data-tip-off')).toBe(true);
    button.dispatchEvent(new win.Event('blur') as unknown as Event);
    expect(wrap?.hasAttribute('data-tip-off')).toBe(false);
  });

  // WCAG 1.4.13: content shown on hover can itself be hovered, and dismissed without moving the pointer.
  test('the pointer can move onto the popover and it stays: it takes the pointer, and nothing between it and the badge drops it', () => {
    const tipRule = /\n\.tip {([^}]*)}/.exec(BADGE_CSS)?.[1] ?? '';
    expect(tipRule).not.toMatch(/pointer-events:\s*none/);
    expect(BADGE_CSS).toMatch(/\.tip:hover {\s*display:\s*block/);
    // A strip over the gap above the popover belongs to it, so crossing the gap never leaves both.
    const bridge = /\n\.tip::before {([^}]*)}/.exec(BADGE_CSS)?.[1] ?? '';
    expect(bridge).toMatch(/content:\s*''/);
    expect(bridge).toMatch(/inset-block-end:\s*100%/);
    expect(bridge).toMatch(/block-size:\s*0\.5em/);
    expect(BADGE_CSS).toMatch(/\n\.tip {[^}]*inset-block-start:\s*calc\(100% \+ 0\.35em\)/);
  });

  test('Escape dismisses a popover the pointer opened, with no focus on the badge, until the pointer leaves', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'verified', reason: 'Why.' });
    const wrap = rootOf(host).querySelector('.wrap') as HTMLElement;
    const escape = (): boolean => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event);
    wrap.dispatchEvent(new win.Event('mouseenter') as unknown as Event);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a' }) as unknown as Event);
    expect(wrap.hasAttribute('data-tip-off')).toBe(false);
    // The page's own Escape handling goes on as before: nothing is cancelled.
    expect(escape()).toBe(true);
    expect(wrap.hasAttribute('data-tip-off')).toBe(true);
    wrap.dispatchEvent(new win.Event('mouseleave') as unknown as Event);
    expect(wrap.hasAttribute('data-tip-off')).toBe(false);
    // Once the pointer is gone, the page's Escape is none of the badge's business.
    escape();
    expect(wrap.hasAttribute('data-tip-off')).toBe(false);
  });

  test('a badge drawn again on the same host still listens once, and only while the pointer is over it', () => {
    const host = doc.createElement('refsure-badge');
    renderBadge(host, { index: 1, status: 'cant_check', reason: 'first' });
    renderBadge(host, { index: 1, status: 'verified', reason: 'second' });
    const wrap = rootOf(host).querySelector('.wrap') as HTMLElement;
    const added = vi.spyOn(doc, 'addEventListener');
    wrap.dispatchEvent(new win.Event('mouseenter') as unknown as Event);
    expect(added.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event);
    expect(wrap.hasAttribute('data-tip-off')).toBe(true);
    wrap.dispatchEvent(new win.Event('mouseleave') as unknown as Event);
    expect(wrap.hasAttribute('data-tip-off')).toBe(false);
  });

  test('the badge adds no height to the line it sits on', () => {
    expect(BADGE_CSS).toMatch(/:host {[^}]*vertical-align: text-bottom/);
    const lineHeight = /button\s*{[^}]*?font:\s*[^;/]*\/([\d.]+)/.exec(BADGE_CSS)?.[1] ?? '';
    expect(Number(lineHeight)).toBeLessThanOrEqual(1.3);
  });
});

describe('badges on a page', () => {
  test('a queued result is a copy: changing the caller\'s object afterwards changes nothing', async () => {
    setReferenceItems(itemsOf(doc));
    const update = { index: 1, status: 'verified' as const, reason: 'as sent', extra: 'not ours' };
    showBadges([update], () => undefined);
    update.reason = 'changed later';
    update.status = 'retracted' as never;
    await flushed();
    const host = doc.querySelectorAll('refsure-badge')[0] as Element;
    const root = rootOf(host);
    expect(root.querySelector('.tip')?.textContent).toBe('as sent');
    expect(root.querySelector('[data-status]')?.getAttribute('data-status')).toBe('verified');
  });

  test('go at the end of the matching reference only, and change nothing else', async () => {
    const before = pageOutsideHosts(doc);
    const lis = doc.querySelectorAll('li.ltx_bibitem');
    setReferenceItems(itemsOf(doc));
    showBadges([{ index: 2, status: 'verified', reason: 'ok' }], () => undefined);
    await flushed();
    expect(lis[0]?.querySelectorAll('refsure-badge')).toHaveLength(0);
    expect(lis[1]?.querySelectorAll('refsure-badge')).toHaveLength(1);
    expect(lis[1]?.lastElementChild?.tagName.toLowerCase()).toBe('refsure-badge');
    expect(lis[2]?.querySelectorAll('refsure-badge')).toHaveLength(0);
    expect(doc.querySelectorAll('refsure-badge')).toHaveLength(1);
    expect(pageOutsideHosts(doc)).toBe(before);
    expect((doc.getElementById('secret') as HTMLInputElement).value).toBe('hunter2');
  });

  test('an index with no reference on the page is skipped', async () => {
    setReferenceItems(itemsOf(doc));
    showBadges([{ index: 99, status: 'verified', reason: 'ok' }], () => undefined);
    await flushed();
    expect(doc.querySelectorAll('refsure-badge')).toHaveLength(0);
  });

  test('a second result for the same reference replaces its badge', async () => {
    setReferenceItems(itemsOf(doc));
    showBadges([{ index: 1, status: 'cant_check', reason: 'a' }], () => undefined);
    await flushed();
    showBadges([{ index: 1, status: 'verified', reason: 'b' }], () => undefined);
    await flushed();
    const hosts = doc.querySelectorAll('refsure-badge');
    expect(hosts).toHaveLength(1);
    expect(rootOf(hosts[0] as Element).querySelector('.tip')?.textContent).toBe('b');
  });

  test('300 badges render in one animation-frame pass and leave the rest of the page as it was', async () => {
    doc = makePage(300);
    vi.stubGlobal('document', doc);
    const frames = vi.spyOn(win, 'requestAnimationFrame');
    const before = pageOutsideHosts(doc);
    setReferenceItems(itemsOf(doc));
    // The background sends one result at a time; they must still land in a single frame.
    for (let i = 1; i <= 300; i += 1) showBadges([{ index: i, status: i % 2 === 0 ? 'verified' : 'not_found', reason: `Reason ${i}` }], () => undefined);
    await flushed();
    expect(frames).toHaveBeenCalledTimes(1);
    expect(doc.querySelectorAll('refsure-badge')).toHaveLength(300);
    doc.querySelectorAll('li.ltx_bibitem').forEach((li) => expect(li.querySelectorAll(':scope > refsure-badge')).toHaveLength(1));
    expect(pageOutsideHosts(doc)).toBe(before);
    clearBadges();
    expect(doc.querySelectorAll('refsure-badge')).toHaveLength(0);
    expect(snapshot(doc.documentElement)).toBe(before);
  });

  test('clearBadges removes every host and cancels badges still waiting for a frame', async () => {
    setReferenceItems(itemsOf(doc));
    showBadges([{ index: 1, status: 'verified', reason: 'ok' }], () => undefined);
    await flushed();
    showBadges([{ index: 2, status: 'verified', reason: 'ok' }], () => undefined);
    clearBadges();
    await flushed();
    expect(doc.querySelectorAll('refsure-badge')).toHaveLength(0);
  });
});

describe('scrollToRef', () => {
  test('scrolls the reference into view and highlights our badge for 2 seconds, touching nothing of the page\'s', async () => {
    setReferenceItems(itemsOf(doc));
    showBadges([{ index: 2, status: 'verified', reason: 'ok' }], () => undefined);
    await flushed();
    const li = doc.querySelectorAll('li.ltx_bibitem')[1] as HTMLElement;
    const scroll = vi.fn();
    li.scrollIntoView = scroll;
    const liBefore = snapshot(li, ['refsure-badge']);
    const host = li.querySelector('refsure-badge') as HTMLElement;
    const pageBefore = pageOutsideHosts(doc);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    scrollToRef(2);
    expect(scroll).toHaveBeenCalledOnce();
    // The highlight is drawn inside the closed root: the host (the only thing on the page) gains nothing.
    expect(highlighted(host)).toBe(true);
    expect(host.getAttributeNames()).toEqual([]);
    expect(pageOutsideHosts(doc)).toBe(pageBefore);
    vi.advanceTimersByTime(1900);
    expect(highlighted(host)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(highlighted(host)).toBe(false);
    expect(snapshot(li, ['refsure-badge'])).toBe(liBefore);
    expect(li.getAttribute('class')).toBe('ltx_bibitem');
    expect(li.getAttribute('style')).toBeNull();
  });

  test('scrolls smoothly, or instantly when the reader asks for reduced motion', async () => {
    setReferenceItems(itemsOf(doc));
    const li = doc.querySelectorAll('li.ltx_bibitem')[0] as HTMLElement;
    const scroll = vi.fn();
    li.scrollIntoView = scroll;
    const matchMedia = vi.spyOn(win, 'matchMedia');
    matchMedia.mockImplementation((query: string) => ({ matches: query.includes('reduce') }) as never);
    scrollToRef(1);
    expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }));
    matchMedia.mockImplementation(() => ({ matches: false }) as never);
    scrollToRef(1);
    expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });

  test('a second highlight restarts the 2 seconds and an unknown index does nothing', async () => {
    setReferenceItems(itemsOf(doc));
    showBadges(
      [
        { index: 1, status: 'verified', reason: 'ok' },
        { index: 2, status: 'verified', reason: 'ok' },
      ],
      () => undefined,
    );
    await flushed();
    const [a, b] = Array.from(doc.querySelectorAll('refsure-badge'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    scrollToRef(1);
    vi.advanceTimersByTime(1500);
    scrollToRef(2);
    expect(highlighted(a as Element)).toBe(false);
    expect(highlighted(b as Element)).toBe(true);
    expect(() => scrollToRef(42)).not.toThrow();
  });
});
