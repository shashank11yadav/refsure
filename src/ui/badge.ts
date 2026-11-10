// Inline status badges on an arXiv HTML paper (SECURITY.md section 4, DESIGN.md section 7.3).
//
// Isolation, in one place: each reference gets one host element appended inside its own `li`, and
// everything visible lives in that host's CLOSED shadow root together with its own stylesheet, so
// the page's CSS cannot reach the badge and the badge's CSS cannot reach the page. The host itself
// carries no attributes: the verdict and the highlight are marked on an element inside the closed
// root, so a script on the page cannot read what was found about a reference. Texts go in with
// `textContent` and `setAttribute` only. The only things this file ever changes on the page are our
// own hosts: it never edits a page element's attributes, classes or styles, and it reads nothing
// from the page besides the reference elements it is handed and the one word arXiv's own light/dark
// toggle leaves on <html data-theme>, which only picks between our own two colour sets.

import { STATUS_WORD } from '../core/status';
import type { Status } from '../core/types';
import type { BadgeUpdate } from '../messaging';
import { clip } from './dom';

const HOST_TAG = 'refsure-badge';
const HIGHLIGHT_ATTR = 'data-highlight';
const WRAP_CLASS = 'wrap';
// Unique within the closed root, which is all an IDREF in a shadow tree can see.
const REASON_ID = 'reason';
const HIGHLIGHT_MS = 2000;
const THEME_ATTR = 'data-theme';
const TIP_OFF_ATTR = 'data-tip-off';
// Titles and screen-reader names stay readable; a reason is a sentence, never a page.
const MAX_REASON_CHARS = 1000;

const STATUS_ICON: Readonly<Record<Status, string>> = {
  verified: '✓',
  details_differ: '⚠',
  wrong_id: '⚠',
  retracted: '⛔',
  not_found: '✗',
  cant_check: '?',
};

// Colour is never the only signal: every status also has its own word, and the icon is repeated
// in the border style (retracted is solid and bold, not found is dashed). `all: initial` on the host
// stops the paper's font, colour and line height from being inherited into the badge.
//
// Light and dark: the dark values are written once and used twice. arXiv's own light/dark toggle sets
// html[data-theme]; the content script copies that onto the wrapper as data-theme (light or dark), and
// then it decides. Only when the page sets nothing does the reader's prefers-color-scheme decide.
const DARK_BASE = '--fg: #dfe3e8; --bg: #2c3037; --line: #8a919c; --focus: #8ab4ff; --mark: #ffb54a;';
const DARK_STATUS: Readonly<Record<Status, string>> = {
  verified: '--fg: #a8e6bd; --bg: #16341f; --line: #4c9a67;',
  details_differ: '--fg: #ffdf91; --bg: #3a2c08; --line: #c08a1a;',
  wrong_id: '--fg: #ffc9a3; --bg: #3d2108; --line: #cc6a2a;',
  retracted: '--fg: #ffb3bd; --bg: #40131b; --line: #c4384a;',
  // A muted rose, clearly not the red of Retracted: "not in these databases" is not an alarm.
  not_found: '--fg: #f0c4cc; --bg: #2e1d21; --line: #a8707b;',
  cant_check: '--fg: #dfe3e8; --bg: #2c3037; --line: #8a919c;',
};

function darkRules(scope: string): string {
  const status = (Object.keys(DARK_STATUS) as Status[])
    .filter((name) => name !== 'cant_check')
    .map((name) => `${scope}[data-status="${name}"] { ${DARK_STATUS[name]} }`)
    .join('\n');
  return `${scope} { ${DARK_BASE} }\n${status}\n${scope} button:hover { filter: brightness(1.15); }`;
}

export const BADGE_CSS = `
:host {
  all: initial;
  display: inline-block;
  margin-inline-start: 0.6em;
  vertical-align: text-bottom;
  line-height: 0;
}
.wrap {
  position: relative;
  display: inline-block;
  --fg: #3d424a; --bg: #eceef1; --line: #8a919c; --focus: #1a56c4; --mark: #b86e00;
}
.wrap[data-status="verified"] { --fg: #0b5d2a; --bg: #e3f4e8; --line: #4c9a67; }
.wrap[data-status="details_differ"] { --fg: #6b4300; --bg: #fff1cc; --line: #c08a1a; }
.wrap[data-status="wrong_id"] { --fg: #7a3000; --bg: #ffe6d4; --line: #cc6a2a; }
.wrap[data-status="retracted"] { --fg: #8a0f1f; --bg: #fde3e6; --line: #c4384a; }
.wrap[data-status="not_found"] { --fg: #5b2a35; --bg: #f6edef; --line: #a8707b; }
button {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  padding: 0 0.55em;
  font: 600 0.75em/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
}
.wrap[data-status="retracted"] button { border-width: 2px; font-weight: 700; margin-block: -1px; }
.wrap[data-status="not_found"] button { border-style: dashed; }
button:hover { filter: brightness(0.96); }
button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
/* The reason, as a small popover under the badge. It is out of the flow (no extra line height) and not
   displayed at all until shown: a box that is only hidden (opacity or visibility) still counts toward the page's
   scrollable width. display:none keeps it the button's description for a screen reader. It opens from the
   badge's end edge (badges sit at the end of a line, so it opens inward) and its width is capped to the viewport;
   keepInView() below nudges it when the badge is near the left edge. The pointer can move onto it (it takes the
   pointer, and its ::before strip covers the gap above it), so a reason is read where it is shown. */
.tip {
  display: none;
  position: absolute;
  inset-block-start: calc(100% + 0.35em);
  inset-inline-end: 0;
  z-index: 2147483000;
  box-sizing: border-box;
  width: max-content;
  max-width: min(22em, calc(100vw - 1rem));
  padding: 0.4em 0.65em;
  font: 400 0.8em/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 0.5em;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  white-space: normal;
}
.tip::before {
  content: '';
  position: absolute;
  inset-inline: 0;
  inset-block-end: 100%;
  block-size: 0.5em;
}
button:focus-visible + .tip, button:hover + .tip, .tip:hover { display: block; }
.wrap[data-tip-off] .tip { display: none; }
.wrap[data-highlight] { outline: 3px solid var(--mark); outline-offset: 3px; border-radius: 999px; }
@media (prefers-color-scheme: dark) {
${darkRules('.wrap:not([data-theme="light"])')}
}
${darkRules('.wrap[data-theme="dark"]')}
@media (prefers-reduced-motion: no-preference) {
  button { transition: filter 0.15s; }
}
@media print { :host { display: none; } }
`;

const roots = new WeakMap<HTMLElement, ShadowRoot>();

/** arXiv's own colour scheme when it has set one ('light' or 'dark'); anything else is no answer. */
function pageTheme(doc: Document): 'light' | 'dark' | undefined {
  const value = doc.documentElement?.getAttribute(THEME_ATTR);
  return value === 'light' || value === 'dark' ? value : undefined;
}

function applyTheme(wrap: Element, theme: 'light' | 'dark' | undefined): void {
  if (theme === undefined) wrap.removeAttribute(THEME_ATTR);
  else wrap.setAttribute(THEME_ATTR, theme);
}

/**
 * The styles go in twice: as a constructed sheet adopted by the closed root, and as a <style> element inside
 * it. Either can fail without telling us (an adopted sheet in a Firefox content script may be accepted and
 * then not applied; a <style> can be blocked by a strict page policy), and the duplicate rules do no harm,
 * so each covers the other's failure.
 */
function applyStyles(root: ShadowRoot, doc: Document): void {
  try {
    const Sheet = doc.defaultView?.CSSStyleSheet;
    if (Sheet !== undefined) {
      const sheet = new Sheet();
      sheet.replaceSync(BADGE_CSS);
      root.adoptedStyleSheets = [sheet];
    }
  } catch {
    // The <style> element below still carries the styles.
  }
  const style = doc.createElement('style');
  style.textContent = BADGE_CSS;
  root.append(style);
}

const EDGE_GAP = 8;

/**
 * Nudges a shown popover sideways so it stays inside the viewport. The CSS anchors it to the badge's end edge,
 * so only a badge near the start edge needs this. It is measured when the popover is shown (a box that is not
 * displayed has no size) and the nudge is undone when it is hidden.
 */
function keepInView(tip: HTMLElement): void {
  tip.style.transform = '';
  const rect = tip.getBoundingClientRect();
  if (rect.width === 0) return;
  const viewport = tip.ownerDocument.documentElement.clientWidth;
  if (rect.left < EDGE_GAP) tip.style.transform = `translateX(${Math.round(EDGE_GAP - rect.left)}px)`;
  else if (viewport > 0 && rect.right > viewport - EDGE_GAP) tip.style.transform = `translateX(${Math.round(viewport - EDGE_GAP - rect.right)}px)`;
}

/**
 * Draws (or redraws) the badge for one reference inside `host`'s closed shadow root.
 * `onClick` receives the reference number when the badge is pressed.
 */
export function renderBadge(host: HTMLElement, s: { status: Status; reason: string; index: number }, onClick?: (index: number) => void): void {
  const doc = host.ownerDocument;
  let root = roots.get(host);
  if (root === undefined) {
    root = host.attachShadow({ mode: 'closed' });
    roots.set(host, root);
    applyStyles(root, doc);
  }

  // Everything the badge shows or marks sits in this wrapper, inside the closed root.
  let wrap = root.querySelector(`.${WRAP_CLASS}`);
  if (wrap === null) {
    wrap = doc.createElement('span');
    wrap.setAttribute('class', WRAP_CLASS);
    dismissOnEscapeWhileHovered(wrap, doc);
    root.append(wrap);
  }

  const word = STATUS_WORD[s.status];
  const reason = clip(s.reason, MAX_REASON_CHARS);
  const button = doc.createElement('button');
  button.setAttribute('type', 'button');
  // Name = "RefSure: " (visually hidden, so a screen-reader user knows who added it) + the visible word.
  // The reason is the description: the popover below, which is visible on focus and hover and still
  // readable while hidden. No title and no aria-label, which would say the reason twice.
  button.setAttribute('aria-describedby', REASON_ID);
  const who = doc.createElement('span');
  who.setAttribute('class', 'sr');
  who.textContent = 'RefSure: ';
  const icon = doc.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = STATUS_ICON[s.status];
  const label = doc.createElement('span');
  label.textContent = word;
  button.append(who, icon, label);
  const tip = doc.createElement('span');
  tip.setAttribute('id', REASON_ID);
  tip.setAttribute('class', 'tip');
  tip.setAttribute('role', 'tooltip');
  tip.textContent = reason;
  const index = s.index;
  // Only the reader's own click (or Enter or Space on the focused badge): a badge click can open the side panel, and a
  // click that a script makes is not the reader's.
  button.addEventListener('click', (event) => {
    if (event.isTrusted) onClick?.(index);
  });
  // Escape closes the popover (it is content on hover or focus, so it must be dismissable); it comes back
  // the next time the pointer or focus arrives. Escape with the pointer alone over the badge: see
  // dismissOnEscapeWhileHovered.
  const showAgain = (): void => wrap?.removeAttribute(TIP_OFF_ATTR);
  button.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') wrap?.setAttribute(TIP_OFF_ATTR, '');
  });
  // Each change of hover or focus re-measures: the popover may still be shown by the other one.
  button.addEventListener('blur', () => {
    showAgain();
    keepInView(tip);
  });
  button.addEventListener('mouseenter', () => {
    showAgain();
    keepInView(tip);
  });
  button.addEventListener('focus', () => keepInView(tip));
  button.addEventListener('mouseleave', () => keepInView(tip));

  wrap.replaceChildren(button, tip);
  applyTheme(wrap, pageTheme(doc));
  // The status is a fixed word from our own list, so it is safe as an attribute for the styles above.
  wrap.setAttribute('data-status', s.status);
}

/**
 * While the pointer is over the badge or its popover, Escape on the page closes the popover; it comes back once the
 * pointer has left. With no focus on the badge, the key goes to the page, so it is heard there: only while the pointer
 * is over us, without stopping or cancelling it, and without reading anything but which key it was. Set up once per
 * wrapper, which outlives a redraw.
 */
function dismissOnEscapeWhileHovered(wrap: Element, doc: Document): void {
  const onKey = (event: Event): void => {
    if ((event as KeyboardEvent).key === 'Escape') wrap.setAttribute(TIP_OFF_ATTR, '');
  };
  wrap.addEventListener('mouseenter', () => doc.addEventListener('keydown', onKey));
  wrap.addEventListener('mouseleave', () => {
    doc.removeEventListener('keydown', onKey);
    wrap.removeAttribute(TIP_OFF_ATTR);
  });
}

/** Outlines (or stops outlining) the badge on `host`, from inside its root: the host itself is left bare. */
function setHighlight(host: HTMLElement, on: boolean): void {
  const wrap = roots.get(host)?.querySelector(`.${WRAP_CLASS}`);
  if (on) wrap?.setAttribute(HIGHLIGHT_ATTR, '');
  else wrap?.removeAttribute(HIGHLIGHT_ATTR);
}

// ---------------------------------------------------------------------------- the badges on a page

let items: ReadonlyMap<number, HTMLElement> = new Map();
const hosts = new Map<number, HTMLElement>();
// Copies of index, status and reason only: the message objects themselves are not kept.
const queue = new Map<number, BadgeUpdate>();
let clickHandler: (index: number) => void = () => undefined;
let scheduled = false;
let highlighted: { host: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined;
let themeWatcher: MutationObserver | undefined;

/** Keeps every badge on the page's colour scheme when arXiv's toggle changes it. Runs only while badges exist. */
function watchPageTheme(): void {
  if (themeWatcher !== undefined || typeof window.MutationObserver !== 'function') return;
  try {
    themeWatcher = new window.MutationObserver(() => {
      const theme = pageTheme(document);
      for (const host of hosts.values()) {
        const wrap = roots.get(host)?.querySelector(`.${WRAP_CLASS}`);
        if (wrap !== null && wrap !== undefined) applyTheme(wrap, theme);
      }
    });
    themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTR] });
  } catch {
    themeWatcher = undefined; // The badges keep the scheme they were drawn with.
  }
}

function stopHighlight(): void {
  if (highlighted === undefined) return;
  clearTimeout(highlighted.timer);
  setHighlight(highlighted.host, false);
  highlighted = undefined;
}

/** Tells the badge layer which `li` belongs to which reference number. Starts from a clean page. */
export function setReferenceItems(map: ReadonlyMap<number, HTMLElement>): void {
  clearBadges();
  items = map;
}

function flush(): void {
  scheduled = false;
  const batch = [...queue.values()];
  queue.clear();
  for (const result of batch) {
    const item = items.get(result.index);
    if (item === undefined) continue;
    let host = hosts.get(result.index);
    if (host === undefined) {
      host = item.ownerDocument.createElement(HOST_TAG);
      hosts.set(result.index, host);
    }
    renderBadge(host, result, clickHandler);
    if (host.parentNode !== item) item.append(host);
  }
  if (hosts.size > 0) watchPageTheme();
}

/**
 * Queues badges. The background sends results one at a time, so they are all drawn together in the
 * next animation frame (a hidden tab has no frames, so there they are drawn at once): 300 references
 * cost one pass, not 300 layouts.
 */
export function showBadges(results: readonly BadgeUpdate[], onClick: (index: number) => void): void {
  clickHandler = onClick;
  for (const { index, status, reason } of results) queue.set(index, { index, status, reason });
  if (scheduled || queue.size === 0) return;
  scheduled = true;
  if (document.hidden) setTimeout(flush, 0);
  else window.requestAnimationFrame(flush);
}

/** Removes every badge we added, and any that are still waiting to be drawn. */
export function clearBadges(): void {
  stopHighlight();
  queue.clear();
  for (const host of hosts.values()) host.remove();
  hosts.clear();
  themeWatcher?.disconnect();
  themeWatcher = undefined;
}

/** Scrolls reference `index` into view and outlines our badge on it for two seconds. */
export function scrollToRef(index: number): void {
  if (queue.size > 0) flush();
  const item = items.get(index);
  if (item === undefined) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  item.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  stopHighlight();
  const host = hosts.get(index);
  if (host === undefined) return;
  setHighlight(host, true);
  highlighted = { host, timer: setTimeout(stopHighlight, HIGHLIGHT_MS) };
}
