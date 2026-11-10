// Accuracy evaluation (`npm run eval`): the real engine against the real services, measured against the quality
// bar of docs/DESIGN.md section 10. See tests/eval/README.md for the data and how to read the numbers.
//
//   npm run eval                      run what is missing, then score
//   npm run eval -- --max-refs 60     check the first 60 references of each paper (default 40)
//   npm run eval -- --offline         answer only from the disk cache (fast, for re-scoring after a threshold change)
//   npm run eval -- --rerun           recompute runs that are already stored (use with --offline)
//   npm run eval -- --only html,holdout,holdout2,holdout3,holdout4,holdout5,holdout6,pdf,physics,openreview,retracted,corrupted,controls
//   npm run eval -- --papers 2       only the first 2 papers of each kind (a quick trial; the score is then partial)
//   npm run eval -- --ids 2503.00312,1602.03837   only these arXiv ids
//   npm run eval -- --list-flagged    print the Not found / Wrong ID / Retracted cases still to be inspected by hand
//
// Everything the services answer is kept in tests/eval/.cache (not committed), so a stopped run resumes and a
// finished one can be scored again without asking anyone. Exit code 1 when the arXiv HTML bar is missed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import type { CheckResult, PaperInfo, RawReference } from '../src/core/types';
import { installChromeStub } from './eval/chromeStub';
import { installDiskFetch } from './eval/diskFetch';
import { installEvalHooks } from './eval/loader';
import { heldOutSetsText, inspectionTable, pathReport, pathTables, syntheticReport, TIMING_NOTE, timingTable, type PathReport } from './eval/report';
import { flaggedCases, judge, readInspection, timeToShare } from './eval/score';
import type { Dataset, DatasetPaper, PaperPath, RunFile } from './eval/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVAL = join(ROOT, 'tests/eval');
const CACHE = join(EVAL, '.cache');
const RUNS = join(CACHE, 'runs');
const DEFAULT_MAX_REFS = 40;
const RUN_LIMIT_MS = 45 * 60 * 1000;

// ------------------------------------------------------------------ arguments

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : (process.argv[at + 1] ?? '');
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const maxRefs = Number(arg('max-refs') ?? DEFAULT_MAX_REFS);
const offline = flag('offline');
const ids = arg('ids') === undefined ? undefined : new Set((arg('ids') ?? '').split(',').map((x) => x.trim()));
const paperLimit = arg('papers') === undefined ? Number.POSITIVE_INFINITY : Number(arg('papers'));
const rerun = flag('rerun');
const only = new Set((arg('only') ?? 'html,holdout,holdout2,holdout3,holdout4,holdout5,holdout6,pdf,physics,openreview,retracted,corrupted,controls').split(',').map((s) => s.trim()));
const contactEmail = process.env['REFSURE_CONTACT_EMAIL'];

if (!Number.isInteger(maxRefs) || maxRefs < 1) throw new Error('--max-refs must be a positive whole number');

// ------------------------------------------------------------------ the engine, in Node

mkdirSync(RUNS, { recursive: true });
const disk = installDiskFetch({ dir: join(CACHE, 'http'), offline, contactEmail });
installEvalHooks();
installChromeStub();

// Imported only now: the hooks above must be in place before any of the extension's source loads.
const { runCheck, defaultDeps } = await import('../src/engine/checker');
const { limiters, fetchBytes, fetchText, SourceError } = await import('../src/sources/http');
const { createRateLimiter } = await import('../src/sources/rateLimiter');
const { extractArxivReferences } = await import('../src/extract/arxivHtml');
const { extractPdfReferences } = await import('../src/extract/pdfReferences');
const { API } = await import('../src/config');

if (offline) {
  // Nothing goes out, so there is nobody to be polite to.
  // The rate headers stored with old answers must not slow the replay either.
  for (const name of Object.keys(limiters) as (keyof typeof limiters)[]) limiters[name] = { ...createRateLimiter({ ratePerSec: 1_000_000, maxConcurrent: 64 }), updateFromHeaders: () => undefined };
}

const noCache = { get: () => Promise.resolve(undefined), set: () => Promise.resolve(), clear: () => Promise.resolve() };

const dataset = JSON.parse(readFileSync(join(EVAL, 'dataset.json'), 'utf8')) as Dataset;
const inspectionFile = join(EVAL, 'inspection.json');
const { cases: inspection, outOfScope } = readInspection(existsSync(inspectionFile) ? (JSON.parse(readFileSync(inspectionFile, 'utf8')) as unknown) : {});

// ------------------------------------------------------------------ reading a paper, as the extension does

async function htmlReferences(arxivId: string, signal: AbortSignal): Promise<RawReference[]> {
  const html = await fetchText(`${API.arxivSite}/html/${arxivId}`, { source: 'page', kind: 'html', signal });
  const window = new Window();
  try {
    const doc = new window.DOMParser().parseFromString(html, 'text/html');
    return extractArxivReferences(doc as unknown as Document);
  } finally {
    await window.happyDOM.close();
  }
}

async function pdfReferences(arxivId: string, signal: AbortSignal): Promise<RawReference[]> {
  const bytes = await fetchBytes(`${API.arxivSite}/pdf/${arxivId}`, { source: 'page', signal });
  return (await extractPdfReferences(bytes)).refs;
}

/** The arXiv HTML version when there is one and it has references, otherwise the PDF (src/background/loadPaper.ts). */
async function referencesOf(path: PaperPath, arxivId: string, signal: AbortSignal): Promise<{ refs: RawReference[]; via: 'html' | 'pdf' }> {
  if (path === 'arxiv-pdf') return { refs: await pdfReferences(arxivId, signal), via: 'pdf' };
  try {
    const refs = await htmlReferences(arxivId, signal);
    if (refs.length > 0) return { refs, via: 'html' };
  } catch (error) {
    if (path === 'arxiv-html' || !(error instanceof SourceError && error.kind === 'not_found_http')) throw error;
  }
  if (path === 'arxiv-html') throw new Error('the HTML version has no references');
  return { refs: await pdfReferences(arxivId, signal), via: 'pdf' };
}

// ------------------------------------------------------------------ running

const runFile = (key: string): string => join(RUNS, `${key.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`);

function readRun(key: string): RunFile | undefined {
  const file = runFile(key);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RunFile) : undefined;
}

function saveRun(run: RunFile): void {
  writeFileSync(runFile(run.key), JSON.stringify(run));
}

/** `halted` is set when the engine gave up because the lookup services stopped answering: the results are then only the first few. */
async function check(key: string, paper: PaperInfo, refs: RawReference[]): Promise<{ results: CheckResult[]; timing: RunFile['timing']; halted: boolean }> {
  disk.take();
  const results: CheckResult[] = [];
  const arrivals: number[] = [];
  const controller = new AbortController();
  const limit = setTimeout(() => controller.abort(new Error(`${key} took longer than ${RUN_LIMIT_MS / 60000} minutes`)), RUN_LIMIT_MS);
  const started = Date.now();
  let halted: boolean;
  try {
    const summary = await runCheck(
      { paper, refs, signal: controller.signal, onResult: (r) => (results.push(r), arrivals.push(Date.now() - started)) },
      { ...defaultDeps(), cache: noCache },
    );
    halted = summary.halted !== undefined;
  } finally {
    clearTimeout(limit);
  }
  const used = disk.take();
  if (used.misses > 0) log(`${key}: ${used.misses} requests were not in the cache (offline), so some results are incomplete`);
  return {
    halted,
    results: results.sort((a, b) => a.index - b.index),
    timing: {
      live: used.cached === 0 && used.misses === 0,
      runMs: Date.now() - started,
      t90Ms: timeToShare(arrivals, refs.length),
      firstResultMs: arrivals.length === 0 ? null : Math.min(...arrivals),
      requests: { live: used.live, cached: used.cached, byHost: used.byHost },
    },
  };
}

function log(message: string): void {
  console.error(`[eval ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function runPaper(path: PaperPath, paper: DatasetPaper, position: string): Promise<RunFile> {
  const key = `${path}:${paper.arxivId}`;
  const stored = readRun(key);
  if (stored !== undefined && !rerun && stored.error === undefined) {
    log(`${position} ${key}: kept (${stored.results.length} results)`);
    return stored;
  }
  // Offline there is nothing to fetch, so a paper that was never run cannot be run now.
  if (offline && stored === undefined) {
    log(`${position} ${key}: skipped (offline, never run)`);
    return { key, group: 'real', path, title: paper.title, error: 'not run', referencesInPaper: 0, refs: [], results: [], timing: { live: false, runMs: 0, t90Ms: null, firstResultMs: null, requests: { live: 0, cached: 0, byHost: {} } } };
  }
  const abort = new AbortController();
  const base = { key, group: 'real' as const, path, title: paper.title };
  let run: RunFile;
  try {
    const { refs, via } = await referencesOf(path, paper.arxivId, abort.signal);
    // Deterministic sample: the first `maxRefs` references, in the paper's own order.
    const sample = refs.slice(0, maxRefs);
    const info: PaperInfo = { key: `arxiv:${paper.arxivId}`, title: paper.title, url: `${API.arxivSite}/abs/${paper.arxivId}`, origin: via === 'html' ? 'arxiv-html' : 'arxiv-pdf', viaPdf: via === 'pdf' };
    log(`${position} ${key}: ${refs.length} references read from the ${via}, checking ${sample.length}`);
    const { results, timing, halted } = await check(key, info, sample);
    // A run the engine cut short is not a complete check: recorded as an error (below), so it is neither scored as one
    // nor kept by the next run.
    if (halted) throw new Error(`the lookup services stopped answering after ${results.length} of ${sample.length} references, so the run was cut short`);
    // A re-score from the cache has no real timings: keep the ones measured when the answers came from the services.
    const kept = stored?.timing.live === true && !timing.live ? stored.timing : timing;
    run = { ...base, via, referencesInPaper: refs.length, refs: sample, results, timing: kept };
    log(`${position} ${key}: done in ${(timing.runMs / 1000).toFixed(1)} s (${timing.requests.live} live requests, ${timing.requests.cached} cached)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${position} ${key}: FAILED: ${message}`);
    run = { ...base, referencesInPaper: 0, refs: [], results: [], error: message, timing: { live: false, runMs: 0, t90Ms: null, firstResultMs: null, requests: { live: 0, cached: 0, byHost: {} } } };
  }
  saveRun(run);
  return run;
}

async function runList(key: 'retracted' | 'corrupted' | 'controls', title: string, texts: string[]): Promise<RunFile> {
  const stored = readRun(key);
  if (stored !== undefined && !rerun && stored.error === undefined) {
    log(`${key}: kept (${stored.results.length} results)`);
    return stored;
  }
  const refs: RawReference[] = texts.map((text, i) => ({ index: i + 1, label: `[${i + 1}]`, text }));
  const info: PaperInfo = { key: `eval:${key}`, title, url: 'https://example.invalid/eval', origin: 'arxiv-html', viaPdf: false };
  log(`${key}: checking ${refs.length} synthetic references`);
  const { results, timing, halted } = await check(key, info, refs);
  const kept = stored?.timing.live === true && !timing.live ? stored.timing : timing;
  if (halted) {
    const message = `the lookup services stopped answering after ${results.length} of ${refs.length} references, so the run was cut short`;
    log(`${key}: FAILED: ${message}`);
    const failed: RunFile = { key, group: key, title, referencesInPaper: 0, refs: [], results: [], error: message, timing: kept };
    saveRun(failed);
    return failed;
  }
  const run: RunFile = { key, group: key, title, referencesInPaper: refs.length, refs, results, timing: kept };
  saveRun(run);
  log(`${key}: done in ${(timing.runMs / 1000).toFixed(1)} s`);
  return run;
}

// ------------------------------------------------------------------ the run

const groups: { name: string; path: PaperPath; papers: DatasetPaper[]; wanted: boolean }[] = [
  { name: 'html', path: 'arxiv-html', papers: dataset.arxivHtml.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('html') },
  // The held-out papers are read and scored as arXiv HTML papers but reported apart, never counted into `html`.
  { name: 'holdout', path: 'arxiv-html', papers: dataset.arxivHtmlHoldout.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('holdout') },
  { name: 'holdout2', path: 'arxiv-html', papers: dataset.arxivHtmlHoldout2.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('holdout2') },
  { name: 'holdout3', path: 'arxiv-html', papers: dataset.arxivHtmlHoldout3.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('holdout3') },
  { name: 'holdout4', path: 'arxiv-html', papers: dataset.arxivHtmlHoldout4.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('holdout4') },
  { name: 'holdout5', path: 'arxiv-html', papers: dataset.arxivHtmlHoldout5.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('holdout5') },
  { name: 'holdout6', path: 'arxiv-html', papers: dataset.arxivHtmlHoldout6.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('holdout6') },
  { name: 'pdf', path: 'arxiv-pdf', papers: dataset.arxivPdfOnly.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('pdf') },
  // Read from the PDF and held to the PDF-only bar, but reported apart, never counted into `pdf`.
  { name: 'physics', path: 'arxiv-pdf', papers: dataset.pdfPhysicsHoldout.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('physics') },
  { name: 'openreview', path: 'openreview', papers: dataset.openreview.filter((p) => ids === undefined || ids.has(p.arxivId)).slice(0, paperLimit), wanted: only.has('openreview') },
];

const total = groups.filter((g) => g.wanted).reduce((n, g) => n + g.papers.length, 0);
let position = 0;
if (!flag('list-flagged')) {
  for (const group of groups) {
    if (!group.wanted) continue;
    for (const paper of group.papers) await runPaper(group.path, paper, `[${++position}/${total}]`);
  }
  if (only.has('retracted')) await runList('retracted', 'Retracted papers, cited correctly', dataset.retracted.map((e) => e.text));
  if (only.has('controls')) await runList('controls', 'Correct citations of well-known papers', dataset.controls.map((e) => e.text));
  if (only.has('corrupted')) await runList('corrupted', 'Corrupted citations', dataset.corrupted.map((e) => e.text));
}

// ------------------------------------------------------------------ scoring

function runsOf(path: PaperPath, papers: DatasetPaper[]): RunFile[] {
  return papers.map((p) => readRun(`${path}:${p.arxivId}`)).filter((r): r is RunFile => r !== undefined);
}

const htmlRuns = runsOf('arxiv-html', dataset.arxivHtml);
const pdfRuns = runsOf('arxiv-pdf', dataset.arxivPdfOnly);
const orRuns = runsOf('openreview', dataset.openreview);
const holdoutRuns = runsOf('arxiv-html', dataset.arxivHtmlHoldout);
const holdout2Runs = runsOf('arxiv-html', dataset.arxivHtmlHoldout2);
const holdout3Runs = runsOf('arxiv-html', dataset.arxivHtmlHoldout3);
const holdout4Runs = runsOf('arxiv-html', dataset.arxivHtmlHoldout4);
const holdout5Runs = runsOf('arxiv-html', dataset.arxivHtmlHoldout5);
const holdout6Runs = runsOf('arxiv-html', dataset.arxivHtmlHoldout6);
const physicsRuns = runsOf('arxiv-pdf', dataset.pdfPhysicsHoldout);
const allReal = [...htmlRuns, ...pdfRuns, ...orRuns, ...holdoutRuns, ...holdout2Runs, ...holdout3Runs, ...holdout4Runs, ...holdout5Runs, ...holdout6Runs, ...physicsRuns];

if (flag('list-flagged')) {
  const pending = judge(flaggedCases(allReal), inspection).pending;
  console.log(JSON.stringify(pending, null, 2));
  console.error(`${pending.length} cases still to inspect`);
  process.exit(0);
}

const reports: PathReport[] = [
  pathReport('arXiv HTML', 'arxiv-html', htmlRuns, inspection, outOfScope),
  pathReport('arXiv PDF-only', 'arxiv-pdf', pdfRuns, inspection, outOfScope),
  pathReport('OpenReview (via arXiv)', 'openreview', orRuns, inspection, outOfScope),
  pathReport('PDF paths (PDF-only + OpenReview)', 'arxiv-pdf', [...pdfRuns, ...orRuns], inspection, outOfScope),
  pathReport('arXiv HTML held-out (partly tuned on)', 'arxiv-html', holdoutRuns, inspection, outOfScope),
  pathReport('arXiv HTML held-out 2 (partly tuned on)', 'arxiv-html', holdout2Runs, inspection, outOfScope),
  pathReport('arXiv HTML held-out 3 (partly tuned on)', 'arxiv-html', holdout3Runs, inspection, outOfScope),
  pathReport('arXiv HTML held-out 4 (partly tuned on)', 'arxiv-html', holdout4Runs, inspection, outOfScope),
  pathReport('arXiv HTML held-out 5 (partly tuned on)', 'arxiv-html', holdout5Runs, inspection, outOfScope),
  pathReport('arXiv HTML held-out 6 (never tuned on)', 'arxiv-html', holdout6Runs, inspection, outOfScope),
  pathReport('arXiv PDF physics held-out (partly tuned on)', 'arxiv-pdf', physicsRuns, inspection, outOfScope),
];
const html = reports[0] as PathReport;

const synthetic = syntheticReport(readRun('corrupted'), readRun('retracted'), readRun('controls'), {
  corrupted: dataset.corrupted,
  retractedWithDoi: dataset.retracted.map((e) => e.withDoi),
});
const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

// References that reached OpenAlex (by id or by search; searches are the metered ones).
const openAlexConsulted = allReal.reduce((n, r) => n + r.results.filter((x) => x.sourcesSearched.includes('openalex') || x.sourcesFailed.includes('openalex')).length, 0);
const budgetLimited = [...reports.slice(0, 3), ...reports.slice(4)].reduce((n, r) => n + r.tally.cantCheck.budget, 0);

const flagged = flaggedCases(allReal);
const judged = judge(flagged, inspection);

const pdfPaths = reports[3] as PathReport;
const holdout = reports[4] as PathReport;
const holdout2 = reports[5] as PathReport;
const holdout3 = reports[6] as PathReport;
const holdout4 = reports[7] as PathReport;
const holdout5 = reports[8] as PathReport;
const holdout6 = reports[9] as PathReport;
const physics = reports[10] as PathReport;
const scored = (report: PathReport): number => report.tally.papers - report.tally.failedPapers;
const heldOutSets = [
  { papers: dataset.arxivHtmlHoldout.length, scored: scored(holdout) },
  { papers: dataset.arxivHtmlHoldout2.length, scored: scored(holdout2) },
  { papers: dataset.arxivHtmlHoldout3.length, scored: scored(holdout3) },
  { papers: dataset.arxivHtmlHoldout4.length, scored: scored(holdout4) },
  { papers: dataset.arxivHtmlHoldout5.length, scored: scored(holdout5) },
  { papers: dataset.arxivHtmlHoldout6.length, scored: scored(holdout6) },
];
const sections: string[] = [
  '# Accuracy results',
  '',
  `Produced by \`npm run eval\` (scripts/eval.ts). The first ${maxRefs} references of each paper are checked; ${offline ? 'this scoring used only the stored answers' : 'answers came from the live services where not stored'}. Crossref used the ${contactEmail === undefined ? 'public pool (no contact address)' : 'polite pool'}.`,
  '',
  '## Real papers against the quality bar',
  '',
  pathTables(reports),
  '',
  `The held-out rows are arXiv HTML papers chosen by the same method as the arXiv HTML row, each set from a later window than the one before (tests/eval/README.md): ${heldOutSetsText(heldOutSets)}. Each is held to the arXiv HTML bar but not counted in the arXiv HTML row or in the exit code. Fixes were drawn from held-out sets 1 to 5, so they are no longer blind; held-out 6 has never been tuned on. The physics held-out row is ${dataset.pdfPhysicsHoldout.length} physics papers read from their PDF, chosen from a later window for their many title-less journal citations; fixes were drawn from it too, so it is partly tuned on. It is held to the arXiv PDF-only bar but not counted in the PDF rows or in the exit code. ${physics.tally.papers - physics.tally.failedPapers} of them are scored here.`,
  '',
  `"Not found + Wrong ID after inspection" counts only the references that, once looked up by hand, turned out to be real works. ${judged.pending.length === 0 ? 'Every Not found and Wrong ID on a real paper has been inspected.' : `${judged.pending.length} cases have not been inspected yet, so the raw numbers are used for the verdict.`}`,
  '',
  "The last table splits Can't check for diagnosis; the bar is held to the all-in share. *Out of scope* are references judged by hand (`outOfScope` in inspection.json) as something no database lookup could check: web pages, software, datasets, talks, theses, reports, journals no database holds, a reference garbled in the paper itself. A title-less conference citation (\"EMNLP (2014)\", \"NIPS pp. 1389–1399\") is engine shortfall: Crossref or the pages could still identify it. *Engine shortfall* is every other Can't check that is not about the budget, books included (Crossref holds most of them; the engine's own \"not a paper\" label is no judgement). *Lookup budget* is OpenAlex's daily limit or a rate limit. *A source not answering* is a source that could not answer, broke its contract or gave a record with no title (in an offline re-score also: an answer that was never stored); it is kept apart from the budget because it can hide a source or engine bug.",
  '',
  `OpenAlex was consulted for ${openAlexConsulted} references of the real papers; ${budgetLimited} references became Can't check because its free daily budget ran out (counted in the Can't check numbers above, and listed separately as "lookup budget used up").`,
  '',
  '## Time until 90% of the results had arrived (arXiv HTML papers)',
  '',
  TIMING_NOTE,
  '',
  timingTable(htmlRuns),
  '',
  '## Corrupted citations and known retractions',
  '',
  table2(
    ['Set', 'Flagged', 'Rate', 'Bar'],
    [
      ['Corrupted citations (any status but Verified)', `${synthetic.corrupted.flagged}/${synthetic.corrupted.total}`, pct(synthetic.corrupted.flagged, synthetic.corrupted.total), '≥ 90%'],
      ...synthetic.corrupted.byKind.map(([kind, f, t]) => [`  ${kind}`, `${f}/${t}`, pct(f, t), '']),
      ['Retracted papers (status Retracted)', `${synthetic.retracted.detected}/${synthetic.retracted.total}`, pct(synthetic.retracted.detected, synthetic.retracted.total), '100%'],
      ['  cited with their DOI', `${synthetic.retracted.withDoi[0]}/${synthetic.retracted.withDoi[1]}`, pct(...synthetic.retracted.withDoi), ''],
      ['  cited without a DOI', `${synthetic.retracted.withoutDoi[0]}/${synthetic.retracted.withoutDoi[1]}`, pct(...synthetic.retracted.withoutDoi), ''],
      ['Controls (correct citations, Verified)', `${synthetic.controls.verified}/${synthetic.controls.total}`, pct(synthetic.controls.verified, synthetic.controls.total), 'informational'],
    ],
  ),
  '',
  `${synthetic.corrupted.budgetLimited} of the corrupted citations came back as Can't check because the OpenAlex budget was used up (they count as flagged).`,
  '',
  '## Not found, Wrong ID and Retracted on real papers, looked up by hand',
  '',
  flagged.length === 0 ? 'None.' : inspectionTable(flagged, inspection),
];
const notes = join(EVAL, 'results-notes.md');
if (existsSync(notes)) sections.push('', readFileSync(notes, 'utf8').trim());
const markdown = sections.join('\n') + '\n';

function table2(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

if (!flag('no-write')) writeFileSync(join(EVAL, 'RESULTS.md'), markdown);
console.log(markdown);

const failures: string[] = [];
if (!html.pass) failures.push('the arXiv HTML bar is missed');
if (html.tally.papers - html.tally.failedPapers < dataset.arxivHtml.length) failures.push('not every arXiv HTML paper could be read');
if (failures.length > 0) {
  console.error(`eval: FAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.error(`eval: ok. PDF paths ${pdfPaths.pass ? 'meet' : 'MISS'} their bar${pdfPaths.pass ? '' : ' (the panel labels them Beta)'}. Held-out HTML papers: ${holdout.tally.refs === 0 ? 'not run' : holdout.pass ? 'meet the arXiv HTML bar' : 'MISS the arXiv HTML bar'}. Held-out 2: ${holdout2.tally.refs === 0 ? 'not run' : holdout2.pass ? 'meet the arXiv HTML bar' : 'MISS the arXiv HTML bar'}. Held-out 3: ${holdout3.tally.refs === 0 ? 'not run' : holdout3.pass ? 'meet the arXiv HTML bar' : 'MISS the arXiv HTML bar'}. Held-out 4: ${holdout4.tally.refs === 0 ? 'not run' : holdout4.pass ? 'meet the arXiv HTML bar' : 'MISS the arXiv HTML bar'}. Held-out 5: ${holdout5.tally.refs === 0 ? 'not run' : holdout5.pass ? 'meet the arXiv HTML bar' : 'MISS the arXiv HTML bar'}. Held-out 6: ${holdout6.tally.refs === 0 ? 'not run' : holdout6.pass ? 'meet the arXiv HTML bar' : 'MISS the arXiv HTML bar'}. Physics held-out: ${physics.tally.refs === 0 ? 'not run' : physics.pass ? 'meet the arXiv PDF-only bar' : 'MISS the arXiv PDF-only bar'}.`);
