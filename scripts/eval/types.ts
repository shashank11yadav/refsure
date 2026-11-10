import type { CheckResult, RawReference } from '../../src/core/types';

/** `tests/eval/dataset.json` (see tests/eval/README.md for how each part was built). */
export interface Dataset {
  version: number;
  generated: string;
  arxivHtml: DatasetPaper[];
  /** Chosen like `arxivHtml` from a later window; scored against the same bar, apart. Partly tuned on. */
  arxivHtmlHoldout: DatasetPaper[];
  /** A second held-out set, chosen the same way from a still later window. Partly tuned on. */
  arxivHtmlHoldout2: DatasetPaper[];
  /** A third held-out set, from a later window again. Partly tuned on. */
  arxivHtmlHoldout3: DatasetPaper[];
  /** A fourth held-out set, from a later window again. Partly tuned on. */
  arxivHtmlHoldout4: DatasetPaper[];
  /** A fifth held-out set, from a later window again. Partly tuned on. */
  arxivHtmlHoldout5: DatasetPaper[];
  /** A sixth held-out set, from a later window again. Never tuned on. */
  arxivHtmlHoldout6: DatasetPaper[];
  arxivPdfOnly: DatasetPaper[];
  /** Physics papers read from their PDF, chosen for their title-less journal citations; scored against the PDF-only bar, apart. Partly tuned on. */
  pdfPhysicsHoldout: DatasetPaper[];
  openreview: DatasetPaper[];
  retracted: RetractedEntry[];
  corrupted: CorruptedEntry[];
  controls: ControlEntry[];
}

export interface DatasetPaper {
  arxivId: string;
  title: string;
  category: string;
  year: number;
  /** OpenReview papers only. */
  venue?: string;
}

export interface RetractedEntry {
  id: string;
  doi: string;
  title: string;
  year: number;
  /** Always `Retracted`. */
  text: string;
  withDoi: boolean;
  origin: string;
  retractionNoticeDoi: string;
}

export type CorruptionKind = 'wrong_year' | 'swapped_authors' | 'wrong_doi' | 'invented_title' | 'hallucinated';

export interface CorruptedEntry {
  id: string;
  kind: CorruptionKind;
  derivedFrom: string;
  text: string;
  note: string;
}

export interface ControlEntry {
  id: string;
  doi: string;
  text: string;
}

/** The three ways a real paper is read, as in the extension. */
export type PaperPath = 'arxiv-html' | 'arxiv-pdf' | 'openreview';

/** What one run of a paper (or a synthetic list) left on disk. */
export interface RunFile {
  /** `arxiv-html:2503.00258`, `retracted`, ... */
  key: string;
  group: 'real' | 'retracted' | 'corrupted' | 'controls';
  path?: PaperPath;
  /** How the references were read: from the paper's HTML or from its PDF. */
  via?: 'html' | 'pdf';
  title: string;
  /** The error that stopped the run, when it could not be read or checked. */
  error?: string;
  referencesInPaper: number;
  /** The references that were checked: the first `maxRefs` of the paper. */
  refs: RawReference[];
  results: CheckResult[];
  timing: Timing;
}

export interface Timing {
  /** True when every request of the run really went out (nothing came from the disk cache), so the times are real. */
  live: boolean;
  runMs: number;
  /** Milliseconds from the start of the check until 90% of the references had a result. */
  t90Ms: number | null;
  firstResultMs: number | null;
  requests: { live: number; cached: number; byHost: Record<string, { live: number; cached: number }> };
}

/** `tests/eval/inspection.json`: the verdict of looking up each Not found / Wrong ID / Retracted on a real paper by hand. */
export interface Inspection {
  [caseKey: string]: InspectedCase;
}

export interface InspectedCase {
  /** `real`: the reference is a real work, so the label was wrong. `problem`: the reference really is faulty. */
  verdict: 'real' | 'problem';
  /** Short cause, from a fixed vocabulary where possible. */
  cause: string;
  note: string;
}

/**
 * A Can't check reference that no database lookup could ever check (a web page, software, a dataset, a talk, a thesis,
 * a report, a journal no database holds, a reference garbled in the paper itself), judged by hand, with a note saying
 * what it is. A title-less conference citation is not one: Crossref or its pages could still identify it. Listed in inspection.json
 * under `outOfScope`, beside the inspected cases.
 */
export interface OutOfScopeCase {
  /** `<run key>#<reference number>`. */
  case: string;
  kind: string;
  note: string;
}
