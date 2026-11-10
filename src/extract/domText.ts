// Reading text out of untrusted markup. Everything here returns plain strings:
// nothing is serialised back to HTML and nothing is inserted into a page (SECURITY.md section 4).

/** What a page's own element id looks like; ids that do not match are never carried along. */
export const ANCHOR_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
// Elements whose contents are not text the reader sees.
const SKIPPED = new Set(['script', 'style', 'noscript', 'template']);
// Zero-width and soft-hyphen characters: invisible, and they only get in the way of matching.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/** Collapses whitespace (non-breaking spaces included) and drops invisible characters. */
export function squashSpace(text: string): string {
  return text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/**
 * The visible text of the given nodes, whitespace-squashed and cut to `maxChars`.
 * Walks the tree with an explicit stack so hostile nesting cannot overflow the call
 * stack, and stops reading once enough text is collected. MathML is read from its
 * `alttext` (its text content would repeat the formula as both glyphs and TeX).
 */
export function textOf(roots: Iterable<Node>, maxChars: number): string {
  const parts: string[] = [];
  let size = 0;
  const stack: Node[] = [...roots].reverse();
  while (stack.length > 0 && size <= maxChars) {
    const node = stack.pop();
    if (!node) break;
    if (node.nodeType === TEXT_NODE) {
      const value = node.nodeValue ?? '';
      parts.push(value);
      size += value.length;
    } else if (node.nodeType === ELEMENT_NODE) {
      const element = node as Element;
      const name = element.localName.toLowerCase();
      if (SKIPPED.has(name)) continue;
      if (name === 'br') {
        parts.push(' ');
        size += 1;
      } else if (name === 'math') {
        const alt = element.getAttribute('alttext') ?? element.textContent ?? '';
        parts.push(` ${alt} `);
        size += alt.length + 2;
      } else {
        const children = element.childNodes;
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i];
          if (child) stack.push(child);
        }
      }
    }
  }
  return squashSpace(parts.join('')).slice(0, maxChars).trim();
}
