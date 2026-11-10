// Finding the reference list in the text of a PDF and cutting it into entries.
// `referencesFromPages` is pure (positioned text in, references out) so it is tested
// on synthetic pages; `extractPdfReferences` adds the pdf.js step in pdfText.ts.
//
// The list is cut by whichever signal the paper gives, in this order: running
// numbers ([12], 12., (12)), bracketed keys ([Vas17]), a hanging indent, a wider gap
// between entries, and finally what an author-year entry looks like. Every pass is a
// single scan over the lines, so the cost is linear in the size of the section.

import { journalLocator } from '../core/journalLocator';
import { parseCitation } from '../core/parseCitation';
import { MIN_PARSE_CONFIDENCE } from '../core/thresholds';
import type { RawReference } from '../core/types';
import { type Line, type PageText, detectPageLayouts, pageLines, withoutRunningText } from './pdfLayout';
import { readPdfPages } from './pdfText';

export interface PdfExtraction {
  refs: RawReference[];
  /** 0 to 1: how sure we are the list was found and cut correctly. */
  confidence: number;
}

type Style = 'numbered' | 'keyed' | 'hanging' | 'gaps' | 'text';

interface Entry {
  label: string;
  /** Text of the entry's lines, label removed. */
  lines: string[];
  /** Cut from a line that held two entries (cutAtLaterLabels). */
  partial?: true;
}

const MAX_REFERENCES = 2000;
const MAX_REFERENCE_CHARS = 5000;
const HEADINGS = new Set(['references', 'bibliography', 'literaturecited', 'workscited', 'referencelist', 'referencesandnotes', 'bibliographyandreferences']);
// "Appendix", "A Appendix", "10 A PPENDIX", "Supplementary material": a heading is short.
const SECTION_END = /^(?:\d{1,2}\.?|[a-z]\.?)?(?:appendix|appendices|supplementary|supplemental)/;
// The closing sections of Nature-style and other papers that follow the list. Only a line that is the heading alone
// counts: "Acknowledgements in scientific papers. Scientometrics 3, 4 (2019)" is part of an entry.
const CLOSING_HEADING = /^(?:\d{1,2}\.?\s*)?(?:acknowledge?ments?|author contributions|competing (?:financial )?interests|data availability|code availability|additional information)$/i;
const MAX_END_HEADING_CHARS = 70;
const MAX_HEADING_CHARS = 40;
const MAX_HEADINGS_TRIED = 5;

function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, '');
}

function isReferencesHeading(line: Line): boolean {
  return line.text.length <= MAX_HEADING_CHARS && HEADINGS.has(compact(line.text));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const CAPTION = /^(?:figure|fig\.|table|algorithm)\s+[A-Za-z]?\d+\s*[.:]/i;
// A line this far off the entries' font size is a heading, a table or a chart, not a reference.
const SIZE_DEVIATION = 0.15;
const BIG_GAP_FACTOR = 3;
const MIN_BIG_GAP = 30;

function startsLabelled(text: string): boolean {
  return text.startsWith('[') || /^\(?\d{1,4}[.)]\s/.test(text);
}

function isSectionEnd(text: string): boolean {
  return (text.length <= MAX_END_HEADING_CHARS && SECTION_END.test(compact(text))) || CAPTION.test(text) || CLOSING_HEADING.test(text.trim());
}

// An entry carried over to the next column or page keeps the list's type size; text set in another size there
// (body text, equations, a heading) is not part of it.
const SAME_SIZE = 0.05;

function offSize(line: Line, bodySize: number): boolean {
  return Math.abs(line.size - bodySize) > SAME_SIZE * bodySize;
}

const samePlace = (a: Line, b: Line): boolean => a.page === b.page && a.column === b.column;

/**
 * Text in another size that opens a new column or page inside the list: in two-column papers the list often starts
 * halfway down a page, under text that fills the top of both columns, and read column by column that text falls
 * between the last entry of the left column and the first of the right. When the list resumes below it in the same
 * column (with a labelled entry, for a labelled list), returns where; when the column ends in such text, 'end': the
 * list stopped at the break. Otherwise (the entry's own text follows, say after a taller formula line) undefined, and
 * nothing is skipped.
 */
function afterStrayText(lines: Line[], from: number, bodySize: number, labelled: boolean): number | 'end' | undefined {
  const first = lines[from];
  if (!first) return undefined;
  let k = from;
  for (let line = lines[k]; line && samePlace(line, first) && !startsLabelled(line.text) && offSize(line, bodySize); line = lines[k]) k++;
  const next = lines[k];
  if (!next || !samePlace(next, first)) return 'end';
  if (offSize(next, bodySize)) return undefined;
  return !labelled || startsLabelled(next.text) ? k : undefined;
}

// Where the bibliography stops: at an appendix or supplement heading, at a figure or table
// caption, at a line set in a clearly different size (a section heading, a table, a chart),
// or after a gap far wider than the line spacing, so what follows the list on the same
// page is not read as part of its last entry. The cheap rules run first and bound the
// section, so the line spacing is measured only over lines that can still belong to the list.
function sectionLines(lines: Line[], headingIndex: number): Line[] {
  const start = headingIndex + 1;
  const bodySize = median(lines.slice(start, start + 30).map((l) => l.size));
  const labelled = startsLabelled(lines[start]?.text ?? '');
  const section: Line[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line) break;
    const prev = section[section.length - 1];
    if (prev && (prev.page !== line.page || prev.column !== line.column) && bodySize > 0 && !startsLabelled(line.text) && offSize(line, bodySize)) {
      const after = afterStrayText(lines, i, bodySize, labelled);
      if (after === 'end') break;
      if (after !== undefined) {
        i = after - 1;
        continue;
      }
    }
    if (bodySize > 0 && Math.abs(line.size - bodySize) > SIZE_DEVIATION * bodySize) break;
    // A reference's own label ("[3]", "12.") never marks the end, whatever the entry says after it.
    if (!startsLabelled(line.text) && isSectionEnd(line.text)) break;
    section.push(line);
  }

  const gaps: number[] = [];
  for (let i = 1; i < section.length; i++) {
    const prev = section[i - 1];
    const line = section[i];
    if (prev && line && prev.page === line.page && prev.column === line.column) gaps.push(prev.y - line.y);
  }
  const typicalGap = gaps.length >= 5 ? median(gaps) : 0;
  if (typicalGap === 0) return section;
  const bigGap = Math.max(typicalGap * BIG_GAP_FACTOR, MIN_BIG_GAP);
  for (let i = 1; i < section.length; i++) {
    const prev = section[i - 1];
    const line = section[i];
    if (!prev || !line || startsLabelled(line.text)) continue;
    if (prev.page === line.page && prev.column === line.column && prev.y - line.y > bigGap) return section.slice(0, i);
  }
  return section;
}

// ---------------------------------------------------------------- numbered and keyed labels

interface Labelled {
  index: number;
  label: string;
  rest: string;
}

const NUMBERED_PATTERNS: ReadonlyArray<{ re: RegExp; label: (n: string) => string }> = [
  { re: /^\[(\d{1,4})\]\s*/, label: (n) => `[${n}]` },
  { re: /^\((\d{1,4})\)\s+/, label: (n) => `(${n})` },
  { re: /^(\d{1,4})\.\s+(?=\S)/, label: (n) => `${n}.` },
];
const KEY_PATTERN = /^\[([A-Za-z][A-Za-z0-9+-]{1,14})\]\s*/;
const NOT_A_KEY = /^(?:online|accessed|available|url|doi|arxiv|preprint|pdf)$/i;
// Allowed to skip a few numbers: a label lost in extraction should not drop the rest of the list.
const MAX_SKIP = 2;

function numberedStarts(lines: Line[], pattern: (typeof NUMBERED_PATTERNS)[number]): Labelled[] {
  const starts: Labelled[] = [];
  let last = 0;
  lines.forEach((line, index) => {
    const m = pattern.re.exec(line.text);
    const digits = m?.[1];
    if (!m || digits === undefined) return;
    const n = Number(digits);
    const accepted = starts.length === 0 ? n >= 1 && n <= 2 : n > last && n <= last + 1 + MAX_SKIP;
    if (!accepted) return;
    last = n;
    starts.push({ index, label: pattern.label(digits), rest: line.text.slice(m[0].length) });
  });
  return starts;
}

function keyedStarts(lines: Line[]): Labelled[] {
  const starts: Labelled[] = [];
  lines.forEach((line, index) => {
    const m = KEY_PATTERN.exec(line.text);
    const key = m?.[1];
    if (!m || key === undefined || NOT_A_KEY.test(key)) return;
    // "[Vas17]", "[DGV+19]": a key has a digit or several capitals; "[Online]" has neither.
    if (!/\d/.test(key) && (key.match(/\p{Lu}/gu)?.length ?? 0) < 2) return;
    starts.push({ index, label: `[${key}]`, rest: line.text.slice(m[0].length) });
  });
  return starts;
}

function entriesFromStarts(lines: Line[], starts: Labelled[]): Entry[] {
  return starts.map((start, i) => {
    const next = starts[i + 1]?.index ?? lines.length;
    const body = lines.slice(start.index + 1, next).map((l) => l.text);
    return { label: start.label, lines: [start.rest, ...body].filter((t) => t !== '') };
  });
}

// ---------------------------------------------------------------- unlabelled entries

const INDENT_TOLERANCE = 2.5;
const INDENT_MIN = 3;
const HANGING_MIN_SHARE = 0.15;

// Left edge of the text column: a low percentile, so one stray bullet does not set it.
function margin(lines: Line[]): number {
  const lefts = lines.map((l) => l.left).sort((a, b) => a - b);
  return lefts[Math.floor(lefts.length * 0.1)] ?? 0;
}

function sentenceEnd(text: string): boolean {
  return /[.)\]"”'’0-9]$/.test(text);
}

const AUTHOR_START =
  /^(?:\p{Lu}[\p{L}'’-]+,\s+\p{Lu}|\p{Lu}\.\s?(?:\p{Lu}\.\s?)*\p{Lu}[\p{L}'’-]+|\p{Lu}[\p{L}'’-]+\s+\p{Lu}{1,3}[,.\s])/u;

interface Cut {
  starts: boolean[];
  style: Style;
}

function cutUnlabelled(lines: Line[]): Cut {
  const marginByColumn = [0, 1].map((c) => margin(lines.filter((l) => l.column === c)));
  const edge = (l: Line): number => marginByColumn[l.column] ?? 0;
  const indented = lines.filter((l) => l.left > edge(l) + INDENT_MIN).length;
  if (lines.length >= 3 && indented / lines.length >= HANGING_MIN_SHARE) {
    return { starts: lines.map((l) => l.left <= edge(l) + INDENT_TOLERANCE), style: 'hanging' };
  }

  const gaps: number[] = [];
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    if (prev && prev.page === line.page && prev.column === line.column) gaps.push(prev.y - line.y);
  });
  const sorted = [...gaps].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length * 0.25)] ?? 0;
  const wide = Math.max(base * 1.3, base + 1.5);
  const largeShare = gaps.length === 0 ? 0 : gaps.filter((g) => g > wide).length / gaps.length;
  if (gaps.length >= 5 && base > 0 && largeShare >= 0.1 && largeShare <= 0.7) {
    return {
      starts: lines.map((line, i) => {
        const prev = lines[i - 1];
        if (!prev) return true;
        if (prev.page !== line.page || prev.column !== line.column) return sentenceEnd(prev.text);
        return prev.y - line.y > wide;
      }),
      style: 'gaps',
    };
  }

  return {
    starts: lines.map((line, i) => {
      const prev = lines[i - 1];
      return !prev || (sentenceEnd(prev.text) && AUTHOR_START.test(line.text));
    }),
    style: 'text',
  };
}

function entriesFromCut(lines: Line[], cut: Cut): Entry[] {
  const entries: Entry[] = [];
  lines.forEach((line, i) => {
    if (cut.starts[i] || entries.length === 0) entries.push({ label: '', lines: [line.text] });
    else entries[entries.length - 1]?.lines.push(line.text);
  });
  return entries;
}

// ---------------------------------------------------------------- assembling

const URL_START = /^(?:https?:?(?:\/\/)?|www\.|doi:|arxiv\.org\/|doi\.org\/|10\.\d{4,9}\/)/i;

// How the next line continues the text so far. A hyphen at a line end before a lower-case
// word is a word break and goes (as in normalizeTitle); before a capital it is a real hyphen
// ("Lopez-" "Gazpio") and stays, with no space. A web address broken at a "/" or "." resumes
// with no space, so identifiers inside it stay findable.
function joinLines(lines: string[]): string {
  let out = '';
  for (const text of lines) {
    // Nothing past the cap is kept, and checking the tail of an ever-longer string for every line would not be linear.
    if (out.length >= MAX_REFERENCE_CHARS) break;
    const lastToken = out.slice(out.lastIndexOf(' ') + 1);
    if (out === '') out = text;
    else if (/[\p{L}\p{N}]-$/u.test(out) && /^\p{Ll}/u.test(text)) out = out.slice(0, -1) + text;
    else if (/[\p{L}\p{N}]-$/u.test(out) && /^\p{Lu}/u.test(text)) out += text;
    else if (URL_START.test(lastToken) && (/[/\-_=?&:]$/.test(lastToken) || (lastToken.endsWith('.') && /^\d/.test(text)))) out += text;
    else out += ` ${text}`;
  }
  return withAccentsJoined(out).replace(/\s+/g, ' ').trim().slice(0, MAX_REFERENCE_CHARS);
}

// TeX sets an accent as its own glyph above the letter, and pdf.js hands it over as a separate spacing character,
// before or after the letter or alone between spaces: "S´eminaire", "Poincar´e", "H¨older", "Chrusciel´ ,", "Nicolo ´,".
// Before a letter it is joined to it ("Séminaire"); anywhere else it is dropped, with the space it left before a comma.
const SPACING_ACCENTS: Record<string, string> = { '\u00b4': '\u0301', '`': '\u0300', '\u00a8': '\u0308', '\u02dc': '\u0303', '\u02c6': '\u0302', '\u02c7': '\u030c', '\u02d8': '\u0306', '\u02d9': '\u0307', '\u00b8': '\u0327', '\u02db': '\u0328', '\u02da': '\u030a', '\u02dd': '\u030b' };
const ACCENT_BEFORE_LETTER = /([\u00b4`\u00a8\u02dc\u02c6\u02c7\u02d8\u02d9\u00b8\u02db\u02da\u02dd])(\p{L})/gu;
const STRAY_ACCENT = /\s?[\u00b4\u00a8\u02dc\u02c6\u02c7\u02d8\u02d9\u00b8\u02db\u02da\u02dd](?=[\s,.;:)]|$)/gu;

function withAccentsJoined(text: string): string {
  if (!/[\u00b4`\u00a8\u02dc\u02c6\u02c7\u02d8\u02d9\u00b8\u02db\u02da\u02dd]/.test(text)) return text;
  return text
    .replace(ACCENT_BEFORE_LETTER, (_, accent: string, letter: string) => `${letter}${SPACING_ACCENTS[accent] ?? ''}`.normalize('NFC'))
    .replace(STRAY_ACCENT, '')
    .replace(/(\p{L})\s+,/gu, '$1,');
}

interface Split {
  entries: Entry[];
  style: Style;
  /** Entries found, as a share of the entries the numbering says there are (1 when it cannot say). */
  completeness: number;
}

// ---------------------------------------------------------------- a later label inside an entry

// "[116] " inside the text of [112]: the label of an entry the list lacks. Two columns read as one join their lines,
// so an entry of the left column takes in the first line of an entry of the right. Only "[n]" labels are looked for:
// "116." and "(116)" are as often a page or an issue. A label the list has is a cross-reference ("see also [4]"), an
// earlier one is an erratum's or a note's, and a number far past the end of the list ("[2019]") is no label. In the middle
// of a line a label opens an entry only before a capital (a name, an organisation): "Synthesis of [7] helicene" and "see
// also [9] for" are text.
const INNER_LABEL = /(^|\s)\[(\d{1,4})\]\s+(?=\p{L})/gu;
const OPENS_ENTRY = /^\p{Lu}/u;
const MAX_LABELS_PAST_END = 20;

const labelNumber = (label: string): number => Number(/\d+/.exec(label)?.[0] ?? Number.NaN);

interface LabelCut {
  entries: Entry[];
  /** Cuts made in the middle of a line: the lines after it may still hold text of both entries. */
  midLine: number;
}

/**
 * Cuts an entry at a later label the list lacks, so two works never share one number. A label at the start of a line
 * (one the numbering skipped) is a clean cut. One in the middle of a line means two columns were read as one: the
 * entries' first lines are parted, but their other lines may still be mixed. The cut is counted against the list's
 * confidence, and both parts are marked partial, so neither can be Not found on words that may be the other's.
 */
function cutAtLaterLabels(entries: Entry[]): LabelCut {
  const present = new Set(entries.map((e) => labelNumber(e.label)));
  let last = 0;
  for (const n of present) if (n > last) last = n;
  const out: Entry[] = [];
  let midLine = 0;
  for (const entry of entries) {
    let current: Entry = { label: entry.label, lines: [] };
    let number = labelNumber(entry.label);
    for (const line of entry.lines) {
      let from = 0;
      for (const m of line.matchAll(INNER_LABEL)) {
        const n = Number(m[2]);
        if (!(n > number) || n > last + MAX_LABELS_PAST_END || present.has(n)) continue;
        const start = (m.index ?? 0) + (m[1]?.length ?? 0);
        const before = line.slice(from, start).trim();
        const inLine = before !== '';
        if (inLine && !OPENS_ENTRY.test(line.slice((m.index ?? 0) + m[0].length))) continue;
        if (inLine) {
          current.lines.push(before);
          current.partial = true;
          midLine++;
        }
        out.push(current);
        current = inLine ? { label: `[${n}]`, lines: [], partial: true } : { label: `[${n}]`, lines: [] };
        number = n;
        present.add(n);
        from = (m.index ?? 0) + m[0].length;
      }
      const rest = line.slice(from).trim();
      if (rest !== '') current.lines.push(rest);
    }
    out.push(current);
  }
  // In label order: the cut-out entries follow the ones the numbering found before them.
  out.sort((a, b) => labelNumber(a.label) - labelNumber(b.label));
  return { entries: out, midLine };
}

function splitEntries(lines: Line[]): Split {
  const [bracketed, ...others] = NUMBERED_PATTERNS.map((p) => numberedStarts(lines, p));
  const numbered = [bracketed ?? [], ...others].sort((a, b) => b.length - a.length)[0] ?? [];
  const keyed = keyedStarts(lines);
  if (numbered.length >= 2 && numbered.length >= keyed.length) {
    const found = entriesFromStarts(lines, numbered);
    // Only bracketed labels are looked for inside entries (see INNER_LABEL).
    const { entries, midLine } = numbered === bracketed ? cutAtLaterLabels(found) : { entries: found, midLine: 0 };
    const lastLabel = labelNumber(entries[entries.length - 1]?.label ?? '');
    const share = Math.min(1, entries.length / Math.max(Number.isFinite(lastLabel) ? lastLabel : entries.length, 1));
    // Both parts of an entry cut in the middle of a line may hold the other's text.
    const mixed = Math.min(1, (2 * midLine) / entries.length);
    return { entries, style: 'numbered', completeness: share * (1 - mixed) };
  }
  if (keyed.length >= 2) return { entries: entriesFromStarts(lines, keyed), style: 'keyed', completeness: 1 };
  const cut = cutUnlabelled(lines);
  return { entries: entriesFromCut(lines, cut), style: cut.style, completeness: 1 };
}

const STYLE_SCORE: Record<Style, number> = { numbered: 1, keyed: 0.9, hanging: 0.8, gaps: 0.65, text: 0.45 };

function confidenceOf(refs: RawReference[], style: Style, completeness: number): number {
  if (refs.length === 0) return 0;
  const withYear = refs.filter((r) => /\b(?:19|20)\d{2}[a-z]?\b|\barxiv\b/i.test(r.text)).length / refs.length;
  const plausible = refs.filter((r) => r.text.length >= 25 && r.text.length <= 1500).length / refs.length;
  let confidence = 0.4 * withYear + 0.2 * plausible + 0.4 * STYLE_SCORE[style] * completeness;
  if (refs.length < 3) confidence = Math.min(confidence, 0.5);
  return Math.round(confidence * 100) / 100;
}

// Whatever trails the list on its last page (a table, a chart's labels) lands in the last entry.
// An entry is not longer, in lines, than the longest one before it plus a little.
const LAST_ENTRY_SLACK = 2;
const MIN_ENTRIES_FOR_CAP = 5;

function capLastEntry(entries: Entry[]): void {
  const last = entries[entries.length - 1];
  if (!last || entries.length <= MIN_ENTRIES_FOR_CAP) return;
  let longest = 0;
  for (let i = 0; i < entries.length - 1; i++) longest = Math.max(longest, entries[i]?.lines.length ?? 0);
  last.lines = last.lines.slice(0, longest + LAST_ENTRY_SLACK);
}

function referencesFromSection(lines: Line[]): PdfExtraction {
  const { entries, style, completeness } = splitEntries(lines);
  capLastEntry(entries);
  const refs: RawReference[] = [];
  for (const entry of entries) {
    if (refs.length >= MAX_REFERENCES) break;
    const text = joinLines(entry.lines);
    if (text === '') continue;
    const index = refs.length + 1;
    refs.push({ index, label: entry.label || `[${index}]`, text, ...(entry.partial === true && { partial: true as const }) });
  }
  return { refs, confidence: confidenceOf(refs, style, completeness) };
}

// ---------------------------------------------------------------- a list with no heading

// Letters in Physical Review Letters and Nature style print the numbered list straight after the text, with no
// "References" heading. Such a list starts with its first label ("[1]" or "1.") and counts up. Section headings
// ("1. Introduction") and the steps of a proof count up too, so a run is taken for a list only when it is long and each
// entry looks like a reference: a plausible length, a year or an arXiv number in most of them, and most of them read
// by the citation parser as an author list with a title, or as a journal citation; and the first one is not a section.
const MIN_HEADINGLESS_REFERENCES = 5;
const MIN_DATED_SHARE = 0.6;
const MIN_READ_SHARE = 0.6;
const MIN_MEDIAN_CHARS = 30;
const MAX_MEDIAN_CHARS = 600;
const SAMPLE_FOR_READING = 30;
const MAX_FIRST_LABELS_TRIED = 8;
const FIRST_LABELS: readonly RegExp[] = [/^\[1\]\s*\S/, /^1\.\s+\S/];
const PROSE_YEAR = /\((?:19|20)\d{2}[a-z]?\)\s+(\p{Ll}\S*)([^]*)$/u;
// What an author-year entry has after a lower-case title start and a sentence has not: "In:", pages, "volume(issue):pages".
const ENTRY_TAIL = /\bIn:\s|\bpp\.?\s*\d|\b\d{1,4}\(\d{1,3}\):\s?\d/;

/** "Smith, Jones and Brown (2019) studied ...": a bracketed year and a lower-case word is a sentence, unless the entry shows
 *  it is a reference ("(2018) mixup: Beyond ...", "(2013) word2vec ...", "(2019) arXiv:...", an "In:" or pages after the title). */
function isProse(text: string): boolean {
  const found = PROSE_YEAR.exec(text);
  if (found === null) return false;
  const [, word = '', rest = ''] = found;
  if (/:$/.test(word) || /^arxiv/i.test(word) || /\d/.test(word)) return false;
  return !ENTRY_TAIL.test(rest);
}
const SECTION_WORD = /^(?:abstract|introduction|background|related work|preliminar|motivation|overview|method|material|experiment|evaluation|results?\b|discussion|conclusion|summary|acknowledg|appendi|proof|theorem|lemma|definition)/i;

function looksLikeReferences(refs: RawReference[]): boolean {
  if (refs.length < MIN_HEADINGLESS_REFERENCES) return false;
  if (SECTION_WORD.test(refs[0]?.text ?? '')) return false;
  const middle = median(refs.map((r) => r.text.length));
  if (middle < MIN_MEDIAN_CHARS || middle > MAX_MEDIAN_CHARS) return false;
  if (refs.filter((r) => /\b(?:19|20)\d{2}[a-z]?\b|\barxiv\b/i.test(r.text)).length / refs.length < MIN_DATED_SHARE) return false;
  const sample = refs.slice(0, SAMPLE_FOR_READING);
  const read = sample.filter((r) => {
    if (isProse(r.text)) return false;
    const c = parseCitation(r);
    return (c.confidence >= MIN_PARSE_CONFIDENCE && c.authors.length > 0) || journalLocator(c) !== undefined;
  });
  return read.length / sample.length >= MIN_READ_SHARE;
}

/** The longest numbered run that starts at a "1" and reads like a reference list; the later one when two are as long. */
function headinglessList(lines: Line[]): PdfExtraction {
  let best: PdfExtraction = { refs: [], confidence: 0 };
  let tried = 0;
  for (let i = lines.length - 1; i >= 0 && tried < MAX_FIRST_LABELS_TRIED; i--) {
    const text = lines[i]?.text ?? '';
    if (!FIRST_LABELS.some((re) => re.test(text))) continue;
    tried++;
    const result = referencesFromSection(sectionLines(lines, i - 1));
    if (result.refs.length > best.refs.length && looksLikeReferences(result.refs)) best = result;
  }
  return best;
}

/** Reads the last reference list from the pages' text, or finds nothing (no refs, confidence 0). */
export function referencesFromPages(pages: PageText[]): PdfExtraction {
  const layouts = detectPageLayouts(pages);
  const lines = withoutRunningText(pages.flatMap((page, i) => pageLines(page, i + 1, layouts[i] ?? 'one')));
  // A page repeating "References" thousands of times must not make every one of them cost a pass over the rest.
  let tried = 0;
  for (let i = lines.length - 1; i >= 0 && tried < MAX_HEADINGS_TRIED; i--) {
    const line = lines[i];
    if (!line || !isReferencesHeading(line)) continue;
    tried++;
    const result = referencesFromSection(sectionLines(lines, i));
    if (result.refs.length > 0) return result;
  }
  return headinglessList(lines);
}

/** pdf.js text extraction followed by `referencesFromPages`. */
export async function extractPdfReferences(data: ArrayBuffer): Promise<PdfExtraction> {
  return referencesFromPages(await readPdfPages(data));
}
