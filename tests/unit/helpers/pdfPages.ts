import type { PageText, TextRun } from '../../../src/extract/pdfLayout';

export interface Row {
  /** Distance of the left edge from the page's left side. */
  x: number;
  /** Rows are given top to bottom; `y` is the baseline measured from the top of the page. */
  y: number;
  text: string;
  size?: number;
}

const LETTER = { width: 612, height: 792 };

/** A page of text runs, one run per row (pdf.js would give several; the layout step joins them either way). */
export function page(rows: Row[], dims: { width: number; height: number } = LETTER): PageText {
  const runs: TextRun[] = rows.map(({ x, y, text, size = 10 }) => ({
    str: text,
    x,
    y: dims.height - y,
    width: text.length * size * 0.45,
    height: size,
  }));
  return { ...dims, runs };
}

/** Rows stacked down a column from `top`, `leading` apart. */
export function column(x: number, top: number, texts: string[], leading = 11, size = 10): Row[] {
  return texts.map((text, i) => ({ x, y: top + i * leading, text, size }));
}

export const HEAD = (y = 100, x = 72): Row => ({ x, y, text: 'References', size: 14 });
