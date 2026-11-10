// A text picture of a DOM tree (tags, every attribute, text), for "nothing on the page changed" checks.
// Written by hand because the lint rules ban outerHTML everywhere, reading included.

/** The tree under `node`, leaving out any element whose tag name is in `skipTags` (our own badge hosts). */
export function snapshot(node: Node, skipTags: readonly string[] = []): string {
  const skip = new Set(skipTags.map((tag) => tag.toLowerCase()));
  const lines: string[] = [];
  const walk = (current: Node, depth: number): void => {
    if (current.nodeType === 3) {
      lines.push(`${' '.repeat(depth)}#text ${JSON.stringify(current.textContent)}`);
      return;
    }
    if (current.nodeType !== 1 && current.nodeType !== 9) return;
    if (current.nodeType === 1) {
      const element = current as Element;
      if (skip.has(element.tagName.toLowerCase())) return;
      const attrs = Array.from(element.attributes)
        .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
        .sort()
        .join(' ');
      lines.push(`${' '.repeat(depth)}<${element.tagName.toLowerCase()} ${attrs}>`);
    }
    for (const child of Array.from(current.childNodes)) walk(child, depth + 1);
  };
  walk(node, 0);
  return lines.join('\n');
}
