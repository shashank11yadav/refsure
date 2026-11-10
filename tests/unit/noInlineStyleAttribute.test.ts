import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// The extension pages' CSP (default-src 'self') refuses inline style attributes, so a width or colour set that way
// silently does nothing in a real build. Sizes go through the style object (el.style.width = ...) instead.
const ROOT = join(import.meta.dirname, '../../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('no inline style attributes in the UI code', () => {
  test.each(['ui', 'entrypoints', 'background'])('src/%s', (dir) => {
    const offenders = files(join(ROOT, dir)).filter((file) => {
      const code = readFileSync(file, 'utf8');
      return /setAttribute\(\s*['"]style['"]/.test(code) || /[{,]\s*['"]?style['"]?\s*:/.test(code.replace(/const style = [^\n]*/g, ''));
    });
    expect(offenders).toEqual([]);
  });
});
