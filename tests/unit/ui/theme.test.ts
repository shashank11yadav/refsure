// The shared panel theme: an edge that shows where to type keeps 3:1 against what is around it (WCAG 1.4.11).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const themeCss = readFileSync(join(process.cwd(), 'src/ui/theme.css'), 'utf8');

const channel = (hex: string, i: number): number => {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};
/** A token's values in the order they are written: the light one, then the dark one. */
const token = (name: string): string[] => [...themeCss.matchAll(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'gi'))].map((m) => (m[1] ?? '').toLowerCase());

describe('text fields', () => {
  test.each([
    ['light', 0],
    ['dark', 1],
  ])('in the %s theme the field edge is 3:1 against the page and both surfaces', (_scheme, i) => {
    const edge = token('--field-line')[i] ?? '';
    expect(edge).toMatch(/^#[0-9a-f]{6}$/);
    for (const name of ['--bg', '--surface', '--surface-2']) expect(contrast(edge, token(name)[i] ?? '')).toBeGreaterThanOrEqual(3);
  });

  test('a text field draws its edge with that token, over any rule that names the field by class alone', () => {
    // input + :not([type]) outranks a single class (".key-input"), whichever stylesheet comes last.
    expect(themeCss).toMatch(/input:not\(\[type="checkbox"\], \[type="radio"\]\) {[^}]*border-color: var\(--field-line\)/);
  });
});
