import type { CheckResult, CheckSummary, PaperInfo, Status } from '../../../src/core/types';

export function result(over: Partial<CheckResult> = {}): CheckResult {
  const index = over.index ?? 1;
  return {
    index,
    label: `[${index}]`,
    citedText: `Roe J, Smith J. A study of things. Nature, 2019. (reference ${index})`,
    status: 'verified',
    reason: 'Matches the record found',
    diffs: [],
    notes: [],
    sourcesSearched: ['crossref'],
    sourcesFailed: [],
    links: [],
    ...over,
  };
}

export function paper(over: Partial<PaperInfo> = {}): PaperInfo {
  return { key: 'arxiv:1706.03762', title: 'Attention Is All You Need', url: 'https://arxiv.org/html/1706.03762v7', origin: 'arxiv-html', viaPdf: false, ...over };
}

export function counts(results: CheckResult[]): Record<Status, number> {
  const out: Record<Status, number> = { verified: 0, details_differ: 0, wrong_id: 0, retracted: 0, not_found: 0, cant_check: 0 };
  for (const r of results) out[r.status]++;
  return out;
}

export function summaryOf(p: PaperInfo, results: CheckResult[], over: Partial<CheckSummary> = {}): CheckSummary {
  return { paper: p, counts: counts(results), total: results.length, startedAt: Date.UTC(2026, 9, 21, 10, 0, 0), finishedAt: Date.UTC(2026, 9, 21, 10, 0, 12), beta: p.viaPdf, ...over };
}
