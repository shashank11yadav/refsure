// Turning positioned text runs from a PDF page into reading-order lines. Pure
// geometry on numbers and strings; pdf.js itself is only touched in pdfText.ts.
// All passes are sort-and-scan, so the cost grows with n log n at worst.

/** One piece of text with its position in points (origin at the bottom left of the page). */
export interface TextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageText {
  width: number;
  height: number;
  runs: TextRun[];
}

export interface Line {
  text: string;
  /** Left edge of the first word and right edge of the last, in points. */
  left: number;
  right: number;
  /** Baseline height above the page bottom. */
  y: number;
  /** Font size of the tallest run. */
  size: number;
  page: number;
  /** 0 for the left (or only) column, 1 for the right. */
  column: 0 | 1;
  /** Page height, for telling headers and footers from body text. */
  pageHeight: number;
}

// How close to the page middle a run may come before it counts as crossing the gutter.
const GUTTER_MARGIN = 4;
// Share of runs allowed to cross the middle on a two-column page (a full-width title, say).
const MAX_CROSSING_SHARE = 0.03;
// The same, counted in characters. A one-column page set with much mathematics breaks into many tiny runs on both
// sides of the middle, so few RUNS cross it; but its lines of prose do, and they carry a large share of the text.
// Only such a page is judged by characters: on an ordinary two-column page a few full-width lines (a wide caption or
// note) carry a large share of the characters too, yet the gutter is clean.
const MAX_CROSSING_CHAR_SHARE = 0.15;
// A page is broken into tiny runs when at least this share of its body runs hold two characters or fewer.
const TINY_RUN_CHARS = 2;
const FRAGMENTED_SHARE = 0.5;
const STRONG_SIDE_RUNS = 5;
const MIN_RUNS_FOR_VOTE = 10;
// A new word starts when the gap to the previous run is wider than this fraction of the font size.
const SPACE_GAP_EM = 0.15;
// Runs whose baselines differ by less than this fraction of the font size share a line.
const SAME_LINE_EM = 0.45;
const MAX_RUNS_PER_PAGE = 100_000;

function isBlank(run: TextRun): boolean {
  return run.str.trim() === '';
}

interface ColumnEvidence {
  left: number;
  right: number;
  crossing: number;
  total: number;
  crossingChars: number;
  chars: number;
  /** Body runs of TINY_RUN_CHARS characters or fewer (spaces aside). */
  tiny: number;
}

function columnEvidence(page: PageText): ColumnEvidence {
  const mid = page.width / 2;
  // Running heads and page numbers sit near the edges and say nothing about the body's columns.
  const body = page.runs.filter((r) => !isBlank(r) && r.y > page.height * 0.1 && r.y < page.height * 0.9);
  let left = 0;
  let right = 0;
  let crossing = 0;
  let crossingChars = 0;
  let chars = 0;
  let tiny = 0;
  for (const run of body) {
    chars += run.str.length;
    if (run.str.trim().length <= TINY_RUN_CHARS) tiny++;
    if (run.x < mid - GUTTER_MARGIN && run.x + run.width > mid + GUTTER_MARGIN) {
      crossing++;
      crossingChars += run.str.length;
    } else if (run.x + run.width / 2 < mid) left++;
    else right++;
  }
  return { left, right, crossing, total: body.length, crossingChars, chars, tiny };
}

function hasCleanGutter(e: ColumnEvidence): boolean {
  const fragmented = e.tiny >= e.total * FRAGMENTED_SHARE;
  return e.total > 0 && e.crossing <= e.total * MAX_CROSSING_SHARE && (!fragmented || e.crossingChars <= e.chars * MAX_CROSSING_CHAR_SHARE) && e.left >= 1 && e.right >= 1;
}

/**
 * How a page is read: `two` cuts the whole page at the gutter, `one` reads it line by
 * line across the page, and `bands` reads it line by line except where a band of lines
 * between full-width ones has a clear gutter of its own (see `pageLines`).
 */
export type PageLayout = 'one' | 'two' | 'bands';

/**
 * How each page is set. A page with plenty of text on both sides of a clean gutter
 * is two-column by itself. A sparse page (the last page of a bibliography, with one
 * short column) follows the rest of the document, so its few right-hand runs are not
 * mistaken for a stray part of a one-column page. Any other page of a two-column
 * document may still hold columns in part of it: two short columns above a full-width
 * author list, as on the last page of a Physical Review Letter. It is read band by band.
 * In a document set mostly in one column (where a two-column page is usually a table)
 * a page that is not two-column as a whole is never cut into columns.
 */
export function detectPageLayouts(pages: PageText[]): PageLayout[] {
  const evidence = pages.map(columnEvidence);
  const strong = evidence.map((e) => hasCleanGutter(e) && e.left >= STRONG_SIDE_RUNS && e.right >= STRONG_SIDE_RUNS);
  let twoVotes = 0;
  let oneVotes = 0;
  evidence.forEach((e, i) => {
    if (e.total < MIN_RUNS_FOR_VOTE) return;
    if (strong[i]) twoVotes++;
    else if (e.crossing > e.total * 0.2) oneVotes++;
  });
  const documentIsTwoColumn = twoVotes > oneVotes;
  return evidence.map((e, i) => {
    if (strong[i] || (documentIsTwoColumn && hasCleanGutter(e))) return 'two';
    return documentIsTwoColumn ? 'bands' : 'one';
  });
}

// Runs that share a baseline, in left-to-right order, become one line of text.
function clusterByBaseline(runs: TextRun[]): TextRun[][] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const clusters: TextRun[][] = [];
  let baseline = 0;
  let size = 0;
  for (const run of sorted) {
    const current = clusters[clusters.length - 1];
    // A superscript ("[ADG" "+" "16]") sits a little above the baseline and comes first in the
    // sort; it joins the line when it is close enough for the larger of the two sizes.
    if (current && Math.abs(baseline - run.y) <= Math.max(1.5, SAME_LINE_EM * Math.max(size, run.height))) {
      current.push(run);
      size = Math.max(size, run.height);
    } else {
      clusters.push([run]);
      baseline = run.y;
      size = run.height;
    }
  }
  return clusters;
}

function buildLine(cluster: TextRun[], page: number, column: 0 | 1, pageHeight: number): Line | undefined {
  const runs = [...cluster].sort((a, b) => a.x - b.x);
  const words = runs.filter((r) => !isBlank(r));
  const first = words[0];
  if (!first) return undefined;
  let size = 0;
  let right = Number.NEGATIVE_INFINITY;
  for (const word of words) {
    size = Math.max(size, word.height);
    right = Math.max(right, word.x + word.width);
  }
  let text = '';
  let edge = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const startsWithSpace = /^\s/.test(run.str);
    if (text !== '' && !/\s$/.test(text) && !startsWithSpace && run.x - edge > SPACE_GAP_EM * size) text += ' ';
    text += run.str;
    edge = run.x + run.width;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text === '') return undefined;
  return {
    text,
    left: first.x,
    right,
    y: first.y,
    size,
    page,
    column,
    pageHeight,
  };
}

// The lines of some runs read as two columns cut at the gutter: the left column top to bottom, then the right.
function columnLines(runs: TextRun[], mid: number, pageNumber: number, pageHeight: number): Line[] {
  const columns: TextRun[][] = [[], []];
  for (const run of runs) columns[run.x >= mid - GUTTER_MARGIN ? 1 : 0]?.push(run);
  const lines: Line[] = [];
  columns.forEach((columnRuns, index) => {
    for (const cluster of clusterByBaseline(columnRuns)) {
      const line = buildLine(cluster, pageNumber, index === 0 ? 0 : 1, pageHeight);
      if (line) lines.push(line);
    }
  });
  return lines;
}

function crossesGutter(run: TextRun, mid: number): boolean {
  return !isBlank(run) && run.x < mid - GUTTER_MARGIN && run.x + run.width > mid + GUTTER_MARGIN;
}

// A band of a page that is not two-column as a whole holds two columns only when both sides have lines of their own
// and the text leaves a strip down the middle wider than any space between words: so a one-column line that happens
// to break into two runs near the middle, or one line with a wide gap (a running head), is never cut.
const MIN_GUTTER = 8;
const MIN_COLUMN_LINES = 2;

function isColumnBand(runs: TextRun[], mid: number): boolean {
  let leftEdge = Number.NEGATIVE_INFINITY;
  let rightStart = Number.POSITIVE_INFINITY;
  const left: TextRun[] = [];
  const right: TextRun[] = [];
  for (const run of runs) {
    if (isBlank(run)) continue;
    if (run.x >= mid - GUTTER_MARGIN) {
      right.push(run);
      rightStart = Math.min(rightStart, run.x);
    } else {
      left.push(run);
      leftEdge = Math.max(leftEdge, run.x + run.width);
    }
  }
  if (rightStart - leftEdge < MIN_GUTTER) return false;
  return clusterByBaseline(left).length >= MIN_COLUMN_LINES && clusterByBaseline(right).length >= MIN_COLUMN_LINES;
}

/**
 * The lines of one page in reading order. On a two-column page, the left column top to
 * bottom, then the right. On a page read band by band, a line with text across the
 * gutter is full width, and each stretch of lines between full-width ones is read as two
 * columns if it has a clear gutter of its own, else line by line, so a list that ends in
 * two short columns above a full-width block keeps its entries apart.
 */
export function pageLines(page: PageText, pageNumber: number, layout: PageLayout): Line[] {
  const runs = page.runs.length > MAX_RUNS_PER_PAGE ? page.runs.slice(0, MAX_RUNS_PER_PAGE) : page.runs;
  const mid = page.width / 2;
  if (layout === 'two') return columnLines(runs, mid, pageNumber, page.height);
  const lines: Line[] = [];
  const acrossPage = (clusters: TextRun[][]): void => {
    for (const cluster of clusters) {
      const line = buildLine(cluster, pageNumber, 0, page.height);
      if (line) lines.push(line);
    }
  };
  if (layout === 'one') {
    acrossPage(clusterByBaseline(runs));
    return lines;
  }
  const clusters = clusterByBaseline(runs);
  const fullWidth = fullWidthLines(clusters, mid);
  let band: TextRun[][] = [];
  const endBand = (): void => {
    const bandRuns = band.flat();
    if (isColumnBand(bandRuns, mid)) lines.push(...columnLines(bandRuns, mid, pageNumber, page.height));
    else acrossPage(band);
    band = [];
  };
  clusters.forEach((cluster, i) => {
    if (fullWidth[i]) {
      endBand();
      acrossPage([cluster]);
    } else band.push(cluster);
  });
  endBand();
  return lines;
}

// A line set closer than this to a full-width line (in its font size) is part of it: the superscripts of an author
// list, which sit on their own baseline just above the names, are not a line of a column.
const ATTACHED_EM = 0.8;

function fullWidthLines(clusters: TextRun[][], mid: number): boolean[] {
  const crossing = clusters.map((cluster) => cluster.some((run) => crossesGutter(run, mid)));
  const baseline = (cluster: TextRun[] | undefined): number => cluster?.[0]?.y ?? Number.NaN;
  const size = (cluster: TextRun[] | undefined): number => Math.max(0, ...(cluster ?? []).map((run) => run.height));
  const attached = (i: number, j: number): boolean =>
    crossing[j] === true && Math.abs(baseline(clusters[i]) - baseline(clusters[j])) < ATTACHED_EM * Math.max(size(clusters[i]), size(clusters[j]));
  return crossing.map((crosses, i) => crosses || attached(i, i - 1) || attached(i, i + 1));
}

const TOP_OR_BOTTOM = 0.1;

function stripDigits(text: string): string {
  return text.replace(/\d+/g, '#').toLowerCase();
}

// A running head that carries the page number: "Automatic Normalization of Word Variations 11", "12 A. Author et al.".
const WITH_PAGE_NUMBER = /^\d{1,4}\s|\s\d{1,4}$/;

/**
 * Drops page numbers and running heads/footers: lines near the top or bottom edge that
 * are only digits, or whose text (digits aside) repeats on another page. The first line of a page
 * counts as near the edge when it carries a page number, wherever it sits: Springer's LNCS sets its
 * running head lower than the band above, and it would otherwise join the entry it interrupts.
 */
export function withoutRunningText(lines: Line[]): Line[] {
  const pagesByKey = new Map<string, Set<number>>();
  const topOfPage = new Map<number, number>();
  for (const line of lines) topOfPage.set(line.page, Math.max(topOfPage.get(line.page) ?? -Infinity, line.y));
  const isEdge = (l: Line): boolean =>
    l.y > l.pageHeight * (1 - TOP_OR_BOTTOM) || l.y < l.pageHeight * TOP_OR_BOTTOM || (l.y === topOfPage.get(l.page) && WITH_PAGE_NUMBER.test(l.text));
  for (const line of lines) {
    if (!isEdge(line)) continue;
    const key = stripDigits(line.text);
    const pages = pagesByKey.get(key) ?? new Set<number>();
    pages.add(line.page);
    pagesByKey.set(key, pages);
  }
  return lines.filter((line) => {
    if (!isEdge(line)) return true;
    if (/^\d{1,4}$/.test(line.text)) return false;
    return (pagesByKey.get(stripDigits(line.text))?.size ?? 0) < 2;
  });
}
