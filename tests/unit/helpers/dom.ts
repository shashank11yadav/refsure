import { Window } from 'happy-dom';

export interface TestDom {
  win: Window;
  doc: Document;
}

export function makeDom(url = 'chrome-extension://ext-id/sidepanel.html'): TestDom {
  const win = new Window({ url });
  return { win, doc: win.document as unknown as Document };
}

/** The first matching element whose own text content (trimmed, whitespace squashed) equals `text`. */
export function byText<T extends Element = HTMLElement>(root: ParentNode, selector: string, text: string): T {
  const hit = [...root.querySelectorAll<T>(selector)].find((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim() === text);
  if (hit === undefined) throw new Error(`no ${selector} with text "${text}"; have: ${[...root.querySelectorAll(selector)].map((n) => JSON.stringify(n.textContent)).join(', ')}`);
  return hit;
}

export function maybeByText(root: ParentNode, selector: string, text: string): Element | undefined {
  return [...root.querySelectorAll(selector)].find((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim() === text);
}

export function click(node: Element): void {
  (node as HTMLElement).click();
}

/**
 * A click as a person makes it. `element.click()` and dispatched events are not trusted (a page script can make them), and
 * the badges act only on trusted clicks; the DOM used in tests cannot make one, so the flag is set by hand.
 */
export function trustedClick(node: Element): void {
  const view = node.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent };
  const event = new view.MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  node.dispatchEvent(event);
}

/** Lets pending promises and zero-delay timers run. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function text(root: ParentNode): string {
  return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Every attribute value and the text of a tree, to prove a secret is nowhere in it. */
export function everything(root: Element): string {
  const parts: string[] = [root.textContent ?? ''];
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attr of node.attributes) parts.push(attr.value);
    const value = (node as HTMLInputElement).value;
    if (typeof value === 'string' && node.tagName === 'INPUT') parts.push(value);
  }
  return parts.join('\n');
}
