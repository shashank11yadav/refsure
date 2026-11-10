// Tiny DOM helpers for the extension pages. Text goes in only as text nodes and attributes only through
// setAttribute, so nothing taken from a page, a PDF or an API can become markup (SECURITY.md section 4).

export type Child = Node | string | null | undefined | false;
export type Attrs = Record<string, string | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return node;
}

export function button(doc: Document, label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  const node = el(doc, 'button', { type: 'button', ...attrs }, label);
  node.addEventListener('click', onClick);
  return node;
}

let nextId = 0;
/** A fresh id for aria-controls / aria-describedby pairs. */
export function uid(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

/** Keeps a long text short for display; the full text stays available where the user can expand it. */
export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}
