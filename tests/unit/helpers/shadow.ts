import type { Window } from 'happy-dom';

type AttachShadow = (init: { mode: 'open' | 'closed' }) => unknown;

/**
 * Records every shadow root attached in a happy-dom window, with the mode it was attached in. A closed
 * root cannot be reached through `host.shadowRoot`, which is the point, so tests read it from here.
 * The element classes are shared between windows, so `restore` must run after the test.
 */
export function recordShadowRoots(win: Window): { roots: { mode: string; root: ShadowRoot }[]; restore: () => void } {
  const proto = win.Element.prototype as unknown as { attachShadow: AttachShadow };
  const original = proto.attachShadow;
  const roots: { mode: string; root: ShadowRoot }[] = [];
  proto.attachShadow = function (this: unknown, init) {
    const root = original.call(this, init);
    roots.push({ mode: init.mode, root: root as ShadowRoot });
    return root;
  };
  return {
    roots,
    restore: () => {
      proto.attachShadow = original;
    },
  };
}
