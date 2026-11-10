// Inline SVG icons, drawn here so the extension needs no image files or fonts. Each status has its own
// shape (circle, triangle, diamond, octagon) so the icon itself tells them apart, not only its colour.

import type { Status } from '../core/types';

const SVG_NS = 'http://www.w3.org/2000/svg';

// 16 x 16 grid, drawn with a stroke in the current text colour.
const SHAPES: Readonly<Record<Status, readonly string[]>> = {
  verified: ['M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5Z', 'M5.2 8.2l2 2 3.8-4'],
  details_differ: ['M8 2.2 14.2 13H1.8Z', 'M8 6.4v3', 'M8 11.3v.1'],
  wrong_id: ['M8 1.8 14.2 8 8 14.2 1.8 8Z', 'M8 5.4v3.2', 'M8 10.7v.1'],
  retracted: ['M5.3 1.8h5.4l3.5 3.5v5.4l-3.5 3.5H5.3l-3.5-3.5V5.3Z', 'M5 8h6'],
  not_found: ['M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5Z', 'M5.8 5.8l4.4 4.4', 'M10.2 5.8l-4.4 4.4'],
  cant_check: ['M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5Z', 'M6.3 6.3a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3', 'M8 11.5v.1'],
};

export function statusIcon(doc: Document, status: Status): SVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Decorative: the word next to it carries the meaning.
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'icon');
  for (const d of SHAPES[status]) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
