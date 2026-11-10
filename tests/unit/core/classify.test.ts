import { describe, expect, test } from 'vitest';
import { cantCheck, classify, effectiveCitation, genuineAuthorAgreement, isConfidentMatch, isStrongMatch, pickBest, pickStrong, preLookupVerdict, scoreCandidate } from '../../../src/core/classify';
import { AUTHOR_OK, CANDIDATE_TITLE, MIN_PARSE_CONFIDENCE, NO_AUTHOR_TITLE, STRONG_TITLE, STRONG_TITLE_NO_AUTHORS, VERIFIED_TITLE, WRONG_ID_TITLE, YEAR_TOLERANCE } from '../../../src/core/thresholds';
import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { ParsedCitation, WorkRecord } from '../../../src/core/types';

const TITLE = 'Attention Is All You Need';

function citation(over: Partial<ParsedCitation> = {}): ParsedCitation {
  return { raw: 'raw', title: TITLE, authors: ['vaswani', 'shazeer', 'parmar'], year: 2017, kind: 'paper', confidence: 0.9, ...over };
}

function record(over: Partial<WorkRecord> = {}): WorkRecord {
  return {
    source: 'crossref',
    title: TITLE,
    authors: ['vaswani', 'shazeer', 'parmar', 'uszkoreit'],
    year: 2017,
    isRetracted: false,
    notes: [],
    ...over,
  };
}

const ALL = [...REQUIRED_SOURCES];

describe('thresholds', () => {
  test('starting values', () => {
    expect([VERIFIED_TITLE, CANDIDATE_TITLE, WRONG_ID_TITLE, AUTHOR_OK, YEAR_TOLERANCE, MIN_PARSE_CONFIDENCE]).toEqual([0.9, 0.75, 0.5, 0.67, 1, 0.4]);
  });
});

describe('scoreCandidate', () => {
  test('perfect candidate scores 1 on every axis', () => {
    const s = scoreCandidate(citation(), record());
    expect(s.title).toBe(1);
    expect(s.authors).toBe(1);
    expect(s.yearOk).toBe(true);
    expect(s.total).toBeCloseTo(1);
  });

  test('year within tolerance is ok, beyond is not', () => {
    expect(scoreCandidate(citation({ year: 2017 }), record({ year: 2018 })).yearOk).toBe(true);
    expect(scoreCandidate(citation({ year: 2017 }), record({ year: 2020 })).yearOk).toBe(false);
  });

  test('a missing year on either side is not penalised', () => {
    expect(scoreCandidate(citation({ year: undefined }), record({ year: 2020 })).yearOk).toBe(true);
    expect(scoreCandidate(citation({ year: 2017 }), record({ year: undefined })).yearOk).toBe(true);
  });

  test('a record with no authors is not penalised', () => {
    expect(scoreCandidate(citation(), record({ authors: [] })).authors).toBe(1);
  });

  test('different authors lower the score', () => {
    const s = scoreCandidate(citation(), record({ authors: ['smith', 'jones'] }));
    expect(s.authors).toBe(0);
    expect(s.total).toBeLessThan(scoreCandidate(citation(), record()).total);
  });
});

describe('pickBest', () => {
  test('returns undefined when no candidate reaches the candidate title threshold', () => {
    expect(pickBest(citation(), [record({ title: 'Deep Residual Learning for Image Recognition' })])).toBeUndefined();
    expect(pickBest(citation(), [])).toBeUndefined();
  });

  // A candidate whose authors and year agree beats one whose title is only closer but whose authors do not agree.
  test('a candidate whose authors and year agree beats a closer title by other people', () => {
    const exactTitleBadAuthors = record({ source: 'openalex', authors: ['smith', 'jones'] });
    const closeTitleGoodAuthors = record({ source: 'crossref', title: 'Attention is all you need for translation' });
    expect(scoreCandidate(citation(), closeTitleGoodAuthors).title).toBeGreaterThanOrEqual(CANDIDATE_TITLE);
    expect(scoreCandidate(citation(), closeTitleGoodAuthors).title).toBeLessThan(1 - 0.01);
    expect(pickBest(citation(), [closeTitleGoodAuthors, exactTitleBadAuthors])).toBe(closeTitleGoodAuthors);
    expect(pickBest(citation(), [exactTitleBadAuthors, closeTitleGoodAuthors])).toBe(closeTitleGoodAuthors);
  });

  // The ranking is a total order, so the cited authors outrank other people whatever the year: a closer title cannot
  // win this case and still lose the one below.
  test('the cited authors outrank a closer title by other people, whatever the year', () => {
    const exactTitleBadAuthors = record({ source: 'openalex', authors: ['smith', 'jones'] });
    const closeTitleGoodAuthorsOtherYear = record({ source: 'crossref', title: 'Attention is all you need for translation', year: 2009 });
    expect(pickBest(citation(), [closeTitleGoodAuthorsOtherYear, exactTitleBadAuthors])).toBe(closeTitleGoodAuthorsOtherYear);
    expect(pickBest(citation(), [exactTitleBadAuthors, closeTitleGoodAuthorsOtherYear])).toBe(closeTitleGoodAuthorsOtherYear);
  });

  test('the higher title score still wins against a record whose authors agree but whose year does not', () => {
    const exactTitleOtherYear = record({ source: 'openalex', year: 2009 });
    const closeTitle = record({ source: 'crossref', title: 'Attention is all you need for translation' });
    expect(pickBest(citation(), [closeTitle, exactTitleOtherYear])).toBe(exactTitleOtherYear);
  });

  test('a real title tie is broken by authors', () => {
    const wrongAuthors = record({ source: 'openalex', authors: ['smith', 'jones'] });
    const rightAuthors = record({ source: 'crossref', title: 'Attention is all you need.' });
    expect(pickBest(citation(), [wrongAuthors, rightAuthors])).toBe(rightAuthors);
    expect(pickBest(citation(), [rightAuthors, wrongAuthors])).toBe(rightAuthors);
  });

  test('title and authors tied: the year within tolerance wins', () => {
    const wrongYear = record({ source: 'openalex', year: 2022 });
    const rightYear = record({ source: 'crossref', year: 2018 });
    expect(pickBest(citation(), [wrongYear, rightYear])).toBe(rightYear);
    expect(pickBest(citation(), [rightYear, wrongYear])).toBe(rightYear);
  });
});

describe('cantCheck', () => {
  test("is a Can't check with its reason and nothing else, a fresh object each time", () => {
    expect(cantCheck('Some reason')).toEqual({ status: 'cant_check', reason: 'Some reason', diffs: [], notes: [] });
    const one = cantCheck('x');
    one.notes.push('changed');
    expect(cantCheck('x').notes).toEqual([]);
  });
});

describe('preLookupVerdict', () => {
  test('websites and software without an identifier cannot be checked', () => {
    for (const kind of ['web', 'software'] as const) {
      const v = preLookupVerdict(citation({ kind }));
      expect(v?.status).toBe('cant_check');
      expect(v?.reason).toBe('Looks like a website or software, not a paper, so there is nothing to look up');
    }
  });

  test('books without an identifier cannot be checked', () => {
    const v = preLookupVerdict(citation({ kind: 'book' }));
    expect(v?.status).toBe('cant_check');
    expect(v?.reason).toBe("Looks like a book or thesis, which these databases don't list reliably");
  });

  test('a DOI or arXiv ID makes a non-paper checkable', () => {
    expect(preLookupVerdict(citation({ kind: 'software', doi: '10.1/x' }))).toBeUndefined();
    expect(preLookupVerdict(citation({ kind: 'web', arxivId: '1706.03762' }))).toBeUndefined();
    expect(preLookupVerdict(citation({ kind: 'book', doi: '10.1/x' }))).toBeUndefined();
  });

  test('kind unknown with a title is searched normally', () => {
    expect(preLookupVerdict(citation({ kind: 'unknown' }))).toBeUndefined();
  });

  test('low parse confidence cannot be checked', () => {
    const v = preLookupVerdict(citation({ confidence: MIN_PARSE_CONFIDENCE - 0.01 }));
    expect(v?.status).toBe('cant_check');
    expect(v?.reason).toBe("Couldn't read this reference reliably");
    expect(preLookupVerdict(citation({ confidence: MIN_PARSE_CONFIDENCE }))).toBeUndefined();
  });

  test('a valid identifier bypasses the parse-confidence gate: it is enough to look the reference up', () => {
    expect(preLookupVerdict(citation({ title: undefined, authors: [], doi: '10.1000/x', confidence: 0.1 }))).toBeUndefined();
    expect(preLookupVerdict(citation({ title: undefined, authors: [], arxivId: '1706.03762', confidence: 0.1 }))).toBeUndefined();
    expect(preLookupVerdict(citation({ doi: '10.1000/x', confidence: 0 }))).toBeUndefined();
  });

  test('without an identifier low confidence still means unreadable', () => {
    expect(preLookupVerdict(citation({ confidence: 0.1 }))?.reason).toBe("Couldn't read this reference reliably");
    expect(preLookupVerdict(citation({ title: undefined, authors: [], confidence: 0.1 }))?.status).toBe('cant_check');
  });

  test('nothing to search for cannot be checked', () => {
    expect(preLookupVerdict(citation({ title: undefined }))?.reason).toBe("Couldn't read this reference reliably");
  });

  test('classify applies it before anything else', () => {
    const r = classify({ citation: citation({ kind: 'web' }), match: record(), matchedVia: 'search', searched: ALL, failed: [] });
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe('Looks like a website or software, not a paper, so there is nothing to look up');
  });
});

describe('classify: retraction', () => {
  test('a retracted cited version overrides a verified match', () => {
    const r = classify({ citation: citation(), match: record(), matchedVia: 'search', retraction: { retracted: true, version: 'cited' }, searched: ALL, failed: [] });
    expect(r.status).toBe('retracted');
    expect(r.reason).toMatch(/cited version/);
  });

  test('a retraction on the other version names the published version or preprint', () => {
    const asPreprint = classify({ citation: citation({ arxivId: '1706.03762' }), match: record(), matchedVia: 'id', retraction: { retracted: true, version: 'other' }, searched: ALL, failed: [] });
    expect(asPreprint.status).toBe('retracted');
    expect(asPreprint.reason).toMatch(/published version/);
    const asPublished = classify({ citation: citation({ doi: '10.1/x' }), match: record(), matchedVia: 'id', retraction: { retracted: true, version: 'other' }, searched: ALL, failed: [] });
    expect(asPublished.reason).toMatch(/preprint/);
    const unclear = classify({ citation: citation(), match: record(), matchedVia: 'search', retraction: { retracted: true, version: 'other' }, searched: ALL, failed: [] });
    expect(unclear.reason).toMatch(/published version|preprint/);
  });

  test('not retracted leaves the match-based status', () => {
    const r = classify({ citation: citation(), match: record(), matchedVia: 'search', retraction: { retracted: false }, searched: ALL, failed: [] });
    expect(r.status).toBe('verified');
  });

  test('unknown retraction state keeps the status and adds a note, never retracted', () => {
    const r = classify({ citation: citation(), match: record(), matchedVia: 'search', retraction: 'unknown', searched: ALL, failed: [] });
    expect(r.status).toBe('verified');
    expect(r.notes).toContain("Note: retraction status couldn't be checked. Try again later");
  });

  test('unknown retraction also annotates details_differ', () => {
    const r = classify({ citation: citation({ year: 2010 }), match: record(), matchedVia: 'search', retraction: 'unknown', searched: ALL, failed: [] });
    expect(r.status).toBe('details_differ');
    expect(r.notes).toContain("Note: retraction status couldn't be checked. Try again later");
  });
});

describe('classify: wrong_id', () => {
  const unrelated = record({ title: 'Deep Residual Learning for Image Recognition', doi: '10.1109/cvpr.2016.90', authors: ['he', 'zhang'], year: 2016 });

  test('an identifier that resolves to a very different title is wrong_id', () => {
    const r = classify({ citation: citation({ doi: '10.1109/cvpr.2016.90' }), idResolvedTo: unrelated, searched: ALL, failed: [] });
    expect(r.status).toBe('wrong_id');
    expect(r.diffs).toContainEqual({ field: 'title', cited: TITLE, actual: 'Deep Residual Learning for Image Recognition' });
    expect(r.diffs.some((d) => d.field === 'identifier' && d.cited.includes('10.1109/cvpr.2016.90'))).toBe(true);
    expect(r.reason).not.toMatch(/fake|hallucinat|fabricat/i);
  });

  test('wrong_id also beats a match supplied from the same lookup', () => {
    const r = classify({ citation: citation({ arxivId: '1512.03385' }), match: unrelated, matchedVia: 'id', idResolvedTo: unrelated, searched: ALL, failed: [] });
    expect(r.status).toBe('wrong_id');
    expect(r.reason).toMatch(/arXiv/);
  });

  test('an id match with a very different title is wrong_id even without idResolvedTo', () => {
    const r = classify({ citation: citation({ doi: '10.1109/cvpr.2016.90' }), match: unrelated, matchedVia: 'id', searched: ALL, failed: [] });
    expect(r.status).toBe('wrong_id');
  });

  test('a search match with a different title is not wrong_id', () => {
    const r = classify({ citation: citation(), match: unrelated, matchedVia: 'search', searched: ALL, failed: [] });
    expect(r.status).not.toBe('wrong_id');
  });

  test('an identifier resolving to a similar title is not wrong_id', () => {
    const r = classify({ citation: citation(), idResolvedTo: record(), match: record(), matchedVia: 'id', searched: ALL, failed: [] });
    expect(r.status).toBe('verified');
  });

  test('an identifier resolving to the right paper is used as the match when none is given', () => {
    const r = classify({ citation: citation(), idResolvedTo: record(), searched: ALL, failed: [] });
    expect(r.status).toBe('verified');
  });
});

describe('classify: verified and details_differ', () => {
  const base = { matchedVia: 'search' as const, searched: ['crossref' as const], failed: [] };

  test('exact match is verified with no diffs', () => {
    const r = classify({ citation: citation(), match: record(), ...base });
    expect(r.status).toBe('verified');
    expect(r.reason).toBe('Matches the Crossref record');
    expect(r.diffs).toEqual([]);
  });

  test('the Verified reason claims only what the match shows: no authors or year are named when the citation had none', () => {
    const bare = classify({ citation: citation({ authors: [], year: undefined }), match: record(), ...base });
    expect(bare.status).toBe('verified');
    expect(bare.reason).toBe('Matches the Crossref record');
  });

  test('the Verified reason names the source of the matched record by its display name', () => {
    expect(classify({ citation: citation(), match: record({ source: 'arxiv' }), ...base }).reason).toBe('Matches the arXiv record');
    expect(classify({ citation: citation(), match: record({ source: 'openalex' }), ...base }).reason).toBe('Matches the OpenAlex record');
    expect(classify({ citation: citation(), match: record({ source: 'openreview' }), ...base }).reason).toBe('Matches the OpenReview record');
  });

  test('year within tolerance still verifies (preprint vs published)', () => {
    expect(classify({ citation: citation({ year: 2017 }), match: record({ year: 2018 }), ...base }).status).toBe('verified');
  });

  test('year beyond tolerance is details_differ with one year diff', () => {
    const r = classify({ citation: citation({ year: 2017 }), match: record({ year: 2020 }), ...base });
    expect(r.status).toBe('details_differ');
    expect(r.diffs).toEqual([{ field: 'year', cited: '2017', actual: '2020' }]);
    expect(r.reason).toBe('Year differs (cited 2017, found 2020)');
  });

  test('missing cited year or authors does not stop verification', () => {
    expect(classify({ citation: citation({ year: undefined, authors: [] }), match: record(), ...base }).status).toBe('verified');
  });

  test('a record without authors or year does not stop verification', () => {
    expect(classify({ citation: citation(), match: record({ authors: [], year: undefined }), ...base }).status).toBe('verified');
  });

  test('different authors give an authors diff', () => {
    const r = classify({ citation: citation({ authors: ['smith', 'jones', 'brown'] }), match: record(), ...base });
    expect(r.status).toBe('details_differ');
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0]).toMatchObject({ field: 'authors', cited: 'smith, jones, brown' });
    expect(r.reason).toMatch(/^Authors differ/);
  });

  test('two of three authors found is enough', () => {
    expect(classify({ citation: citation({ authors: ['vaswani', 'shazeer', 'smith'] }), match: record(), ...base }).status).toBe('verified');
  });

  test('a close but not exact title is details_differ with a title diff', () => {
    const r = classify({ citation: citation({ title: 'Attention is all you need for machine translation' }), match: record(), ...base });
    expect(r.status).toBe('details_differ');
    expect(r.diffs.map((d) => d.field)).toEqual(['title']);
    expect(r.diffs[0]).toMatchObject({ cited: 'Attention is all you need for machine translation', actual: TITLE });
  });

  test('several failing fields give one diff each and a combined reason', () => {
    const r = classify({ citation: citation({ year: 2010, authors: ['smith', 'jones'] }), match: record(), ...base });
    expect(r.diffs.map((d) => d.field)).toEqual(['authors', 'year']);
    expect(r.reason).toMatch(/Authors differ.*Year differs/);
  });
});

describe('classify: blank titles', () => {
  for (const title of ['', '   \n ']) {
    test(`title ${JSON.stringify(title)} with a resolving DOI is never wrong_id and has no title diff`, () => {
      const ok = classify({ citation: citation({ title, doi: '10.1/x' }), idResolvedTo: record(), matchedVia: 'id', match: record(), searched: ALL, failed: [] });
      expect(ok.status).toBe('verified');
      const off = classify({ citation: citation({ title, doi: '10.1/x', year: 2010 }), idResolvedTo: record(), matchedVia: 'id', match: record(), searched: ALL, failed: [] });
      // No title to compare, so the identifier stands alone; a year far from the record's means it is probably a typo.
      expect(off.status).toBe('cant_check');
      expect(off.reason).toBe("The identifier points to a record that doesn't match the other details");
      const alone = classify({ citation: citation({ title, doi: '10.1/x' }), idResolvedTo: record(), searched: ALL, failed: [] });
      expect(alone.status).toBe('verified');
    });
  }
});

describe('classify: record notes', () => {
  test('notes map to row notes and do not change the status', () => {
    const r = classify({
      citation: citation(),
      match: record({ notes: ['withdrawn', 'correction', 'expression_of_concern'] }),
      matchedVia: 'search',
      searched: ALL,
      failed: [],
    });
    expect(r.status).toBe('verified');
    expect(r.notes).toEqual([
      'Note: withdrawn by the authors on arXiv',
      'Note: a correction has been published',
      'Note: an expression of concern has been issued',
    ]);
  });

  test('retracted rows keep the record notes', () => {
    const r = classify({ citation: citation(), match: record({ notes: ['correction'] }), matchedVia: 'search', retraction: { retracted: true, version: 'cited' }, searched: ALL, failed: [] });
    expect(r.notes).toEqual(['Note: a correction has been published']);
  });
});

describe('classify: no match', () => {
  test('every Not found reason ends with the reminder that it means "not in these databases"', () => {
    const r = classify({ citation: citation(), searched: ALL, failed: [] });
    expect(r.status).toBe('not_found');
    expect(r.reason.endsWith("This means it isn't in these databases, not that it doesn't exist")).toBe(true);
    expect(r.reason).not.toMatch(/fake|hallucinat|fabricat|made up/i);
  });

  test('every required source searched and none failed is not_found', () => {
    const r = classify({ citation: citation(), searched: ALL, failed: [] });
    expect(r.status).toBe('not_found');
    // The status word is shown next to the reason (row, badge, report), so the reason does not repeat it; and like
    // the other reasons it has no final full stop.
    expect(r.reason).toBe("Not found in Crossref, arXiv, OpenReview or OpenAlex. This means it isn't in these databases, not that it doesn't exist");
    expect(r.diffs).toEqual([]);
  });

  test('wording is never accusatory', () => {
    expect(classify({ citation: citation(), searched: [...REQUIRED_SOURCES], failed: [] }).reason).not.toMatch(/fake|hallucinat|fabricat/i);
  });

  test('a failed required source is cant_check', () => {
    const r = classify({ citation: citation(), searched: ['crossref', 'arxiv', 'openreview'], failed: ['openalex'] });
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/OpenAlex/);
    expect(r.reason).toMatch(/try again later/i);
    expect(r.reason).not.toMatch(/fake|hallucinat|fabricat/i);
  });

  test('a required source that was searched but also failed is cant_check', () => {
    expect(classify({ citation: citation(), searched: ALL, failed: ['arxiv'] }).status).toBe('cant_check');
  });

  test('a required source that was never searched is cant_check and named', () => {
    const r = classify({ citation: citation(), searched: ['crossref'], failed: [] });
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/arXiv, OpenReview and OpenAlex/);
  });

  test('the optional DBLP source failing does not block not_found', () => {
    expect(classify({ citation: citation(), searched: ALL, failed: ['dblp'] }).status).toBe('not_found');
  });

  test('two failed sources are named in plain words', () => {
    const r = classify({ citation: citation(), searched: ['crossref', 'openreview'], failed: ['arxiv', 'openalex'] });
    expect(r.reason).toMatch(/arXiv and OpenAlex/);
  });
});

describe('isConfidentMatch', () => {
  test('an id match is confident unless it is a wrong id', () => {
    expect(isConfidentMatch(citation(), record(), 'id')).toBe(true);
    expect(isConfidentMatch(citation(), record({ title: 'Quantum chromodynamics on the lattice', authors: ['x'] }), 'id')).toBe(false);
  });

  test('an id match with a different title but the same authors and year is still confident (translated title)', () => {
    expect(isConfidentMatch(citation(), record({ title: 'Attention est tout ce dont vous avez besoin' }), 'id')).toBe(true);
  });

  test('a search match needs a verified title and matching authors', () => {
    expect(isConfidentMatch(citation(), record(), 'search')).toBe(true);
    expect(isConfidentMatch(citation(), record({ authors: ['smith', 'jones'] }), 'search')).toBe(false);
    expect(isConfidentMatch(citation({ title: 'Attention is all you need for machine translation' }), record(), 'search')).toBe(false);
  });

  test('two of three authors is enough for a search match', () => {
    expect(isConfidentMatch(citation({ authors: ['vaswani', 'shazeer', 'smith'] }), record(), 'search')).toBe(true);
  });

  test('without authors on either side the title must be nearly exact', () => {
    const exact = 'Graph neural networks for protein folding at scale';
    const near = 'Graph neural networks for protein folding at scales'; // 0.937: verified, but under NO_AUTHOR_TITLE
    const sim = scoreCandidate(citation({ title: near, authors: [] }), record({ title: exact })).title;
    expect(sim).toBeGreaterThanOrEqual(VERIFIED_TITLE);
    expect(sim).toBeLessThan(NO_AUTHOR_TITLE);
    expect(isConfidentMatch(citation({ title: near, authors: [] }), record({ title: exact }), 'search')).toBe(false);
    expect(isConfidentMatch(citation({ title: exact, authors: [] }), record({ title: exact }), 'search')).toBe(true);
    expect(isConfidentMatch(citation({ title: near }), record({ title: exact, authors: [] }), 'search')).toBe(false);
  });

  test('a match with no via is judged as a search match', () => {
    expect(isConfidentMatch(citation(), record({ authors: ['smith', 'jones'] }), undefined)).toBe(false);
  });
});

describe('classify: only a confident match can be retracted', () => {
  const retracted = { retracted: true, version: 'cited' as const };

  test('a close search match whose authors differ is never Retracted', () => {
    const r = classify({ citation: citation(), match: record({ authors: ['wang', 'li'] }), matchedVia: 'search', retraction: retracted, searched: ALL, failed: [] });
    expect(r.status).toBe('details_differ');
  });

  test('a close search match whose title only partly matches is never Retracted', () => {
    const r = classify({ citation: citation({ title: 'Attention is all you need for machine translation' }), match: record(), matchedVia: 'search', retraction: retracted, searched: ALL, failed: [] });
    expect(r.status).toBe('details_differ');
  });

  test('a near-exact title without authors to compare is Details differ with a title row, not Verified', () => {
    const near = 'Graph neural networks for protein folding at scales';
    const r = classify({ citation: citation({ title: near, authors: [] }), match: record({ title: 'Graph neural networks for protein folding at scale' }), matchedVia: 'search', searched: ALL, failed: [] });
    expect(r.status).toBe('details_differ');
    expect(r.diffs.map((d) => d.field)).toEqual(['title']);
  });

  test('a confident search match that is retracted is Retracted', () => {
    const r = classify({ citation: citation(), match: record(), matchedVia: 'search', retraction: retracted, searched: ALL, failed: [] });
    expect(r.status).toBe('retracted');
  });

  test('a retraction on a wrong id is never Retracted', () => {
    const unrelated = record({ title: 'Deep Residual Learning for Image Recognition', authors: ['he', 'zhang'], year: 2016 });
    const r = classify({ citation: citation({ doi: '10.1/x' }), match: unrelated, matchedVia: 'id', retraction: retracted, searched: ALL, failed: [] });
    expect(r.status).toBe('wrong_id');
  });
});

// An author list mixing full names and initials ("Zhaoyang Liu, D. Luo, Yabiao Wang, L.
// Wang, ...") can be cut in the wrong place, so that the middle of the names becomes the "title". A correctly cited
// arXiv id must not then be a Wrong ID because none of the record's authors are in the little text left before it.
describe('classify: a run of names is not a title that an identifier can contradict', () => {
  test.each(['Luo, Yabiao Wang, L', 'Luo, Yabiao Wang, Chengjie Wang, Jilin Li and Tong Lu'])('%s', (title) => {
    const r = classify({ citation: citation({ arxivId: '1911.09435', title, authors: ['zhaoyang liu'] }), idResolvedTo: record({ title: 'TEINet: Towards an Efficient Architecture for Video Recognition', authors: ['liu', 'luo', 'wang'] }), searched: ALL, failed: [] });
    expect(r.status).not.toBe('wrong_id');
  });

  test('a real title that merely has capitals and a comma is still a title', () => {
    const r = classify({ citation: citation({ doi: '10.1/x', title: 'Pretty Good Privacy for Email, Revisited Once More', authors: ['roe'] }), idResolvedTo: record({ title: foreignTitle(), authors: ['he', 'zhang'] }), searched: ALL, failed: [] });
    expect(r.status).toBe('wrong_id');
  });
});

function foreignTitle(): string {
  return 'Attention est tout ce dont vous avez besoin';
}

describe('classify: wrong_id needs more than a different title', () => {
  const foreign = 'Attention est tout ce dont vous avez besoin';

  test('a different title with matching authors and year is Details differ with a title row', () => {
    const r = classify({ citation: citation({ doi: '10.1/x' }), idResolvedTo: record({ title: foreign }), searched: ALL, failed: [] });
    expect(r.status).toBe('details_differ');
    expect(r.diffs.map((d) => d.field)).toContain('title');
  });

  test('a different title with different authors is Wrong ID', () => {
    const r = classify({ citation: citation({ doi: '10.1/x' }), idResolvedTo: record({ title: foreign, authors: ['he', 'zhang'] }), searched: ALL, failed: [] });
    expect(r.status).toBe('wrong_id');
  });

  test('a different title with genuine author agreement is Details differ whatever the year (translated title)', () => {
    for (const year of [2001, 2019, 2019 + 2, 2040]) {
      const r = classify({ citation: citation({ doi: '10.1/x' }), idResolvedTo: record({ title: foreign, year }), searched: ALL, failed: [] });
      expect(r.status, String(year)).toBe('details_differ');
      expect(r.diffs.map((d) => d.field)).toContain('title');
    }
  });

  test('an empty author list on either side is no agreement: a different title is then Wrong ID', () => {
    expect(classify({ citation: citation({ doi: '10.1/x', authors: [] }), idResolvedTo: record({ title: foreign }), searched: ALL, failed: [] }).status).toBe('wrong_id');
    expect(classify({ citation: citation({ doi: '10.1/x' }), idResolvedTo: record({ title: foreign, authors: [] }), searched: ALL, failed: [] }).status).toBe('wrong_id');
  });

  test('a record with a blank title is no evidence: never Wrong ID, and Can\'t check without another match', () => {
    for (const title of ['', '  ', '...']) {
      const r = classify({ citation: citation({ doi: '10.1/x' }), idResolvedTo: record({ title, authors: ['he'], year: 1990 }), searched: ALL, failed: [] });
      expect(r.status).toBe('cant_check');
    }
  });

  test('an id the engine marked unusable gives Can\'t check, not Not found', () => {
    const r = classify({ citation: citation({ doi: '10.1/x' }), idUnusable: true, searched: ALL, failed: [] });
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe('The record for this DOI or arXiv ID has no title to compare with. Try again later');
  });

  test('an unusable id does not hide a search match', () => {
    const r = classify({ citation: citation({ doi: '10.1/x' }), idUnusable: true, match: record(), matchedVia: 'search', searched: ALL, failed: [] });
    expect(r.status).toBe('verified');
  });
});

describe('genuineAuthorAgreement', () => {
  test('both lists non-empty and two of the first three surnames shared', () => {
    expect(genuineAuthorAgreement(citation(), record())).toBe(true);
    expect(genuineAuthorAgreement(citation({ authors: ['vaswani', 'shazeer', 'smith'] }), record())).toBe(true);
    expect(genuineAuthorAgreement(citation({ authors: ['vaswani', 'smith', 'jones'] }), record())).toBe(false);
    expect(genuineAuthorAgreement(citation({ authors: ['smith', 'jones'] }), record())).toBe(false);
  });

  test('an empty list on either side is not agreement', () => {
    expect(genuineAuthorAgreement(citation({ authors: [] }), record())).toBe(false);
    expect(genuineAuthorAgreement(citation(), record({ authors: [] }))).toBe(false);
    expect(genuineAuthorAgreement(citation({ authors: [] }), record({ authors: [] }))).toBe(false);
  });
});

describe('isStrongMatch: the only thing that can be Retracted', () => {
  const near = 'Graph neural networks for protein folding at a scale'; // 0.960 against the record title below
  const exact = 'Graph neural networks for protein folding at scale';
  const c = (over: Partial<ParsedCitation> = {}) => citation({ title: exact, authors: ['roe', 'smith', 'chen'], year: 2019, ...over });
  const r = (over: Partial<WorkRecord> = {}) => record({ title: exact, authors: ['roe', 'smith', 'chen'], year: 2019, ...over });

  test('the thresholds', () => {
    expect([STRONG_TITLE, STRONG_TITLE_NO_AUTHORS]).toEqual([0.95, 0.98]);
  });

  test('title >= 0.95, genuine authors and a year in range', () => {
    expect(isStrongMatch(c(), r())).toBe(true);
    expect(isStrongMatch(c({ title: near }), r())).toBe(true);
    expect(isStrongMatch(c({ year: 2020 }), r())).toBe(true);
    expect(isStrongMatch(c({ year: undefined }), r())).toBe(true);
    expect(isStrongMatch(c(), r({ year: undefined }))).toBe(true);
  });

  test('a title under 0.95 is never strong', () => {
    expect(isStrongMatch(c({ title: 'Graph neural networks for protein folding at scales' }), r())).toBe(false); // 0.937
  });

  test('the same title with different authors, or authors that cannot be compared, is not strong at 0.95 to 0.98', () => {
    expect(isStrongMatch(c(), r({ authors: ['wang', 'li'] }))).toBe(false);
    expect(isStrongMatch(c({ title: near, authors: [] }), r())).toBe(false);
    expect(isStrongMatch(c({ title: near }), r({ authors: [] }))).toBe(false);
  });

  test('a year more than the tolerance apart is never strong', () => {
    expect(isStrongMatch(c({ year: 2016 }), r())).toBe(false);
    expect(isStrongMatch(c({ authors: [], year: 2016 }), r({ authors: [] }))).toBe(false);
  });

  test('with no authors on either side, 0.98 is enough and 0.96 is not', () => {
    expect(isStrongMatch(c({ authors: [] }), r({ authors: [] }))).toBe(true);
    expect(isStrongMatch(c({ authors: [] }), r())).toBe(true);
    expect(isStrongMatch(c(), r({ authors: [] }))).toBe(true);
    expect(isStrongMatch(c({ title: near, authors: [] }), r({ authors: [] }))).toBe(false);
  });

  test('disagreeing authors are not rescued by a perfect title', () => {
    expect(isStrongMatch(c(), r({ authors: ['wang', 'li'] }))).toBe(false);
  });

  test('a record with no usable title, or a search match for a citation with none, is not strong', () => {
    expect(isStrongMatch(c(), r({ title: '' }))).toBe(false);
    expect(isStrongMatch(c({ title: undefined }), r())).toBe(false);
    expect(isStrongMatch(c({ title: undefined }), r(), 'search')).toBe(false);
  });

  test('an identifier-only citation: the id names the record, so an id match is strong (and only an id match)', () => {
    const idOnly = c({ title: undefined, doi: '10.1/x' });
    expect(isStrongMatch(idOnly, r(), 'id')).toBe(true);
    // Parsed authors against an author-less record confirm nothing: not strong.
    expect(isStrongMatch(c({ title: '  ', doi: '10.1/x' }), r({ authors: [], year: undefined }), 'id')).toBe(false);
    expect(isStrongMatch(c({ title: '  ', doi: '10.1/x', authors: [], raw: 'doi:10.1/x' }), r({ authors: [], year: undefined }), 'id')).toBe(true);
    expect(isStrongMatch(idOnly, r({ title: '' }), 'id')).toBe(false);
    expect(isStrongMatch(idOnly, r({ title: '...' }), 'id')).toBe(false);
    // With a cited title the normal rules apply, whatever the route.
    expect(isStrongMatch(c({ doi: '10.1/x' }), r({ authors: ['wang', 'li'] }), 'id')).toBe(false);
  });
});

describe('classify: Retracted needs a strong match', () => {
  const retracted = { retracted: true, version: 'cited' as const };
  const unrelated = record({ title: 'Effects of dietary zinc on broiler chicken growth', authors: ['kumar', 'singh'], year: 2019 });

  test('an id record with an unrelated title and no authors on the citation is Wrong ID', () => {
    const r = classify({ citation: citation({ doi: '10.1/x', authors: [] }), idResolvedTo: unrelated, match: unrelated, matchedVia: 'id', retraction: retracted, searched: ALL, failed: [] });
    expect(r.status).toBe('wrong_id');
  });

  test('an id record with an unrelated title and no authors of its own is Wrong ID', () => {
    const none = { ...unrelated, authors: [], year: undefined };
    const r = classify({ citation: citation({ doi: '10.1/x' }), idResolvedTo: none, match: none, matchedVia: 'id', retraction: retracted, searched: ALL, failed: [] });
    expect(r.status).toBe('wrong_id');
  });

  test('an id record whose title is only a prefix of the cited one, with other authors, is not Retracted', () => {
    const prefix = record({ title: 'Attention Is All', authors: ['smith', 'jones'], year: 2017 });
    const r = classify({ citation: citation({ doi: '10.1/x' }), idResolvedTo: prefix, match: prefix, matchedVia: 'id', retraction: retracted, searched: ALL, failed: [] });
    expect(r.status).not.toBe('retracted');
    expect(r.status).toBe('details_differ');
  });

  test('an id match with a year out of range is not Retracted even with matching title and authors', () => {
    const r = classify({ citation: citation({ doi: '10.1/x', year: 2010 }), idResolvedTo: record(), match: record(), matchedVia: 'id', retraction: retracted, searched: ALL, failed: [] });
    expect(r.status).toBe('details_differ');
  });

  test('a search match with a missing cited title is not strong, so not Retracted', () => {
    const r = classify({ citation: citation({ title: undefined }), match: record(), matchedVia: 'search', retraction: retracted, searched: ALL, failed: [] });
    expect(r.status).not.toBe('retracted');
  });

  test('an author-less citation and record: not Retracted at 0.96, Retracted at an exact title', () => {
    const exact = 'Graph neural networks for protein folding at scale';
    const near = 'Graph neural networks for protein folding at a scale';
    const rec = record({ title: exact, authors: [], year: 2019 });
    const at96 = classify({ citation: citation({ title: near, authors: [], year: 2019 }), match: rec, matchedVia: 'search', retraction: retracted, searched: ALL, failed: [] });
    expect(at96.status).not.toBe('retracted');
    const exactly = classify({ citation: citation({ title: exact, authors: [], year: 2019 }), match: rec, matchedVia: 'search', retraction: retracted, searched: ALL, failed: [] });
    expect(exactly.status).toBe('retracted');
  });
});

describe('classify: identifier-only citations can surface retractions', () => {
  const idOnly = citation({ doi: '10.1/x', title: undefined });

  test('a DOI-only citation whose record is retracted is Retracted', () => {
    const r = classify({ citation: idOnly, idResolvedTo: record(), match: record(), matchedVia: 'id', retraction: { retracted: true, version: 'cited' }, searched: ALL, failed: [] });
    expect(r.status).toBe('retracted');
  });

  test('the same record, not retracted, is Verified', () => {
    const r = classify({ citation: idOnly, idResolvedTo: record(), match: record(), matchedVia: 'id', retraction: { retracted: false }, searched: ALL, failed: [] });
    expect(r.status).toBe('verified');
  });

  test('a DOI-only citation whose record has a blank title is Can\'t check, never Retracted or Verified', () => {
    for (const title of ['', '   ', '...']) {
      const r = classify({ citation: idOnly, idResolvedTo: record({ title }), match: record({ title }), matchedVia: 'id', retraction: { retracted: true, version: 'cited' }, searched: ALL, failed: [] });
      expect(r.status, JSON.stringify(title)).toBe('cant_check');
    }
  });
});

describe('genuineAuthorAgreement from the raw text', () => {
  const rec = (authors: string[]) => record({ authors });
  const cit = (raw: string) => citation({ authors: [], raw });

  test('with no parsed authors, two of the record\'s first three surnames as whole words in the raw text', () => {
    expect(genuineAuthorAgreement(cit('J. Roe and J. Smith, Science 367, 123 (2020)'), rec(['roe', 'smith', 'chen']))).toBe(true);
    expect(genuineAuthorAgreement(cit('J. Roe, Science 367, 123 (2020)'), rec(['roe', 'smith', 'chen']))).toBe(false);
    expect(genuineAuthorAgreement(cit('Nature 571, 95 (2020)'), rec(['roe', 'smith']))).toBe(false);
  });

  test('a record with fewer than two authors needs all of them', () => {
    expect(genuineAuthorAgreement(cit('Roe, Nature 571'), rec(['roe']))).toBe(true);
    expect(genuineAuthorAgreement(cit('Nature 571'), rec(['roe']))).toBe(false);
  });

  test('only the first three of the record count, and only whole words', () => {
    expect(genuineAuthorAgreement(cit('Roe, Smith, Chen and Kumar'), rec(['kumar', 'singh', 'wu', 'roe']))).toBe(false);
    expect(genuineAuthorAgreement(cit('Wang and a literature review, Li'), rec(['li', 'wang']))).toBe(true);
    expect(genuineAuthorAgreement(cit('A literature review of Smithson'), rec(['li', 'smith']))).toBe(false);
  });

  test('a record with no authors is never agreement, parsed authors or not', () => {
    expect(genuineAuthorAgreement(cit('Roe and Smith'), rec([]))).toBe(false);
    expect(genuineAuthorAgreement(citation({ authors: ['roe'] }), rec([]))).toBe(false);
  });

  test('parsed authors still decide when there are some', () => {
    expect(genuineAuthorAgreement(citation({ authors: ['smith', 'jones'], raw: 'Roe and Smith' }), rec(['roe', 'smith']))).toBe(false);
  });
});

describe('classify: Wrong ID needs no surname of the record in the raw text', () => {
  const other = record({ title: 'Effects of dietary zinc on broiler chicken growth', authors: ['kumar', 'singh', 'wu'], year: 2019 });
  const cit = (raw: string) => citation({ doi: '10.1/x', authors: [], raw });

  test('none of the surnames present: Wrong ID', () => {
    expect(classify({ citation: cit('Roe and Smith, Nature 571'), idResolvedTo: other, searched: ALL, failed: [] }).status).toBe('wrong_id');
  });

  test('one of them present: Details differ, not Wrong ID', () => {
    const r = classify({ citation: cit('Roe and Kumar, Nature 571'), idResolvedTo: other, searched: ALL, failed: [] });
    expect(r.status).toBe('details_differ');
    expect(r.diffs.map((d) => d.field)).toContain('title');
  });

  test('a cited "title" of fewer than three words (Retrieved from, Supplementary material) is no evidence of anything', () => {
    for (const title of ['Retrieved from https://doi.org/10.1000/xyz123', 'Supplementary material, doi:10.1000/xyz123', 'Editorial']) {
      const r = classify({ citation: citation({ title, doi: '10.1/x', authors: [], raw: title }), idResolvedTo: other, searched: ALL, failed: [] });
      expect(r.status, title).toBe('details_differ');
    }
  });
});

describe('isStrongMatch: guards for identifier-only citations', () => {
  const rec = record({ authors: ['roe', 'smith', 'chen'], year: 2020 });
  const idOnly = (over: Partial<ParsedCitation> = {}) => citation({ doi: '10.1/x', title: undefined, ...over });

  test('parsed authors that share no surname with the record are not strong', () => {
    expect(isStrongMatch(idOnly({ authors: ['kumar'], year: undefined }), rec, 'id')).toBe(false);
    expect(isStrongMatch(idOnly({ authors: ['roe'], year: undefined }), rec, 'id')).toBe(true);
  });

  test('a years gap beyond the tolerance is not strong', () => {
    expect(isStrongMatch(idOnly({ authors: ['roe'], year: 2009 }), rec, 'id')).toBe(false);
    expect(isStrongMatch(idOnly({ authors: ['roe'], year: 2021 }), rec, 'id')).toBe(true);
  });

  test('no parsed authors: some text about the reference but none of the record\'s surnames in it is not strong', () => {
    expect(isStrongMatch(idOnly({ authors: [], raw: 'Roe, J. Nature 2019; 571: 95. doi:10.1/x' }), record({ authors: ['kumar', 'singh'] }), 'id')).toBe(false);
    expect(isStrongMatch(idOnly({ authors: [], year: 2020, raw: 'J. Roe and J. Smith, Nature 571, 95 (2020). doi:10.1/x' }), rec, 'id')).toBe(true);
  });

  test('a bare identifier has no text to disagree with and stays strong', () => {
    for (const raw of ['doi:10.1/x', '[1] 10.1000/xyz123', 'arXiv:1706.03762', 'https://doi.org/10.1000/xyz123']) {
      expect(isStrongMatch(idOnly({ authors: [], year: undefined, raw }), rec, 'id'), raw).toBe(true);
    }
  });

  test('classify says so: Can\'t check, never Retracted', () => {
    const r = classify({ citation: idOnly({ authors: ['kumar'], year: 2009 }), idResolvedTo: rec, match: rec, matchedVia: 'id', retraction: { retracted: true, version: 'cited' }, searched: ALL, failed: [] });
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("The identifier points to a record that doesn't match the other details");
  });
});

describe('isStrongMatch: author-less titles of fewer than four words', () => {
  const generic = (title: string) => record({ title, authors: [], year: 2015 });
  const cit = (title: string) => citation({ title, authors: [], year: 2015 });

  test.each(['Editorial', 'See above', 'Book reviews'])('%j is never strong without authors', (title) => {
    expect(isStrongMatch(cit(title), generic(title))).toBe(false);
  });

  test('five words still need 0.98 and a compatible year', () => {
    const t = 'Introduction to the special issue';
    expect(isStrongMatch(cit(t), generic(t))).toBe(true);
    expect(isStrongMatch({ ...cit(t), year: 2005 }, generic(t))).toBe(false);
    expect(isStrongMatch(cit('Introduction to the special issues on x'), generic(t))).toBe(false);
  });

  test('with genuine agreement from the raw text a title at 0.95 can be strong', () => {
    const t = 'Graph neural networks for protein folding at scale';
    const c = citation({ title: 'Graph neural networks for protein folding at a scale', authors: [], year: 2019, raw: 'J. Roe and J. Smith, Graph neural networks for protein folding at a scale' });
    expect(isStrongMatch(c, record({ title: t, authors: ['roe', 'smith', 'chen'], year: 2019 }))).toBe(true);
  });
});

describe('effectiveCitation', () => {
  test('a low-confidence citation with an identifier is checked by the identifier alone', () => {
    const c = citation({ doi: '10.1/x', confidence: 0.2, year: 2001, authors: ['roe'] });
    expect(effectiveCitation(c)).toMatchObject({ doi: '10.1/x', authors: [], raw: c.raw });
    expect(effectiveCitation(c).title).toBeUndefined();
    // The year is kept so a record from another decade still contradicts the reference.
    expect(effectiveCitation(c).year).toBe(2001);
  });

  test('anything else is left as it is', () => {
    const c = citation({ doi: '10.1/x', confidence: 0.9 });
    expect(effectiveCitation(c)).toBe(c);
    const noId = citation({ confidence: 0.1 });
    expect(effectiveCitation(noId)).toBe(noId);
  });

  test('so it can only be Verified, Retracted or Can\'t check, never Wrong ID or Details differ', () => {
    // The zone names one of the record's authors, which confirms the identifier (a lone "Roe." would not).
    const c = effectiveCitation(citation({ doi: '10.1/x', confidence: 0.2, year: 2001, authors: ['roe'], raw: 'J. Roe. doi:10.1/x' }));
    const rec = record({ title: 'Something else entirely', authors: ['roe', 'smith'], year: 2001 });
    const r = classify({ citation: c, idResolvedTo: rec, match: rec, matchedVia: 'id', searched: ALL, failed: [] });
    expect(r.status).toBe('verified');
    // A year far off the record's is a contradiction: Can't check, still never Details differ.
    const off = classify({ citation: c, idResolvedTo: { ...rec, year: 2020 }, match: { ...rec, year: 2020 }, matchedVia: 'id', searched: ALL, failed: [] });
    expect(off.status).toBe('cant_check');
  });
});

describe('effectiveCitation keeps the year', () => {
  test('only the title and authors are dropped', () => {
    const c = effectiveCitation(citation({ doi: '10.1/x', confidence: 0.2, year: 2020, authors: ['roe'] }));
    expect(c.year).toBe(2020);
    expect(c.title).toBeUndefined();
    expect(c.authors).toEqual([]);
  });

  test('a DOI typo onto a retracted record from another decade is Can\'t check, never Retracted', () => {
    const c = effectiveCitation(citation({ doi: '10.1/x', confidence: 0.2, year: 2020, authors: [], title: undefined, raw: 'Y. Wang, Science 367, 123 (2020). doi:10.1/x' }));
    const rec = record({ title: 'Effects of dietary zinc on broiler chicken growth', authors: ['wang', 'kumar'], year: 2009 });
    const r = classify({ citation: c, idResolvedTo: rec, match: rec, matchedVia: 'id', retraction: { retracted: true, version: 'cited' }, searched: ALL, failed: [] });
    expect(r.status).toBe('cant_check');
  });

  test('pure numbers are not words about the paper: a bare identifier with a page number stays bare', () => {
    const rec = record({ authors: ['kumar'], year: 2020 });
    const c = citation({ doi: '10.1/x', title: undefined, authors: [], year: undefined, raw: '571, 95-98. doi:10.1/x' });
    expect(isStrongMatch(c, rec, 'id')).toBe(true);
  });
});

describe('author zone', () => {
  const ALLRET = { retraction: { retracted: true, version: 'cited' as const }, searched: ALL, failed: [] };
  const generic = (title: string, authors: string[], raw: string) => ({
    citation: citation({ title, authors: [], year: 2015, raw }),
    match: record({ title, authors, year: 2015 }),
    matchedVia: 'search' as const,
  });

  test.each([
    ['Green chemistry', ['green'], 'Green chemistry. 2015.'],
    ['Editorial', ['the lancet'], 'Editorial. The Lancet 385, 1 (2015).'],
    ['Editorial', ['thomas'], 'Thomas Roe. Editorial. 2015.'],
  ])('%j by %j (cited as %j) is never Retracted', (title, authors, raw) => {
    expect(classify({ ...generic(title, authors, raw), ...ALLRET }).status).not.toBe('retracted');
  });

  test('title words never count as the record\'s authors', () => {
    const c = citation({ title: 'Long short-term memory networks for traffic forecasting', authors: [], raw: 'Long short-term memory networks for traffic forecasting. In ICML, 2020.' });
    expect(genuineAuthorAgreement(c, record({ authors: ['long', 'short'] }))).toBe(false);
    // A leading "title" that reads as a list of names (title-less styles) stays in the zone.
    const names = citation({ title: 'Jane Long and John Short', authors: [], raw: 'Jane Long and John Short (2020). doi:10.1/x' });
    expect(genuineAuthorAgreement(names, record({ authors: ['long', 'short'] }))).toBe(true);
    const withAuthors = citation({ title: 'Long short-term memory networks for traffic forecasting', authors: [], raw: 'A. Roe and B. Doe. Long short-term memory networks for traffic forecasting. In ICML, 2020.' });
    expect(genuineAuthorAgreement(withAuthors, record({ authors: ['long', 'short'] }))).toBe(false);
  });

  test('a leading label is not an author run', () => {
    const c = citation({ title: 'M. Mueller, Nature 571, 95', authors: [], raw: '[12] M. Mueller, Nature 571, 95 (2020).' });
    expect(genuineAuthorAgreement(c, record({ authors: ['muller'] }))).toBe(true);
  });
});

describe('isWrongId: boilerplate and venue titles', () => {
  const other = record({ title: 'Effects of dietary zinc on broiler chicken growth', authors: ['kumar', 'singh'], year: 2019 });
  const cit = (title: string) => citation({ title, doi: '10.1/x', authors: [], raw: title });

  test.each(['Accessed on 12 May 2021', 'Data available at https://doi.org/10.1000/xyz123', 'Supplementary material for this article, doi:10.1000/xyz123', 'Software, version 2.1', 'Proceedings of the National Academy of Sciences 117(5), 2345', 'Journal of Applied Physics 98, 1234'])(
    '%j is not a title a record can contradict',
    (title) => {
      expect(classify({ citation: cit(title), idResolvedTo: other, searched: ALL, failed: [] }).status).not.toBe('wrong_id');
    },
  );

  test('a real title with a venue word inside it still can be', () => {
    // The reference names its authors (Wrong ID needs a zone that names someone).
    const title = 'Deep learning for climate science in the tropics';
    const c = citation({ title, doi: '10.1/x', authors: [], raw: `J. Roe and J. Smith. ${title}. 2020.` });
    expect(classify({ citation: c, idResolvedTo: other, searched: ALL, failed: [] }).status).toBe('wrong_id');
    // With no names at all there is no evidence of a wrong identifier.
    expect(classify({ citation: cit(title), idResolvedTo: other, searched: ALL, failed: [] }).status).toBe('details_differ');
  });
});

describe('preLookupVerdict: overlong text', () => {
  test('an identifier bypasses the confidence gate only while the text is at most 1000 characters', () => {
    expect(preLookupVerdict(citation({ doi: '10.1/x', confidence: 0.1, raw: 'x'.repeat(1000) }))).toBeUndefined();
    expect(preLookupVerdict(citation({ doi: '10.1/x', confidence: 0.1, raw: 'x'.repeat(1001) }))?.status).toBe('cant_check');
    expect(preLookupVerdict(citation({ doi: '10.1/x', confidence: 0.9, raw: 'x'.repeat(5000) }))).toBeUndefined();
  });
});

describe('classify: reason when an identifier-only citation finds nothing', () => {
  test('says the identifier was not found and there is no title, not the unsearched sources', () => {
    const r = classify({ citation: citation({ doi: '10.1/x', title: undefined }), searched: ['crossref'], failed: [] });
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("Couldn't find this identifier and there's no title to search by");
  });

  test('a lookup that failed keeps a try-again reason', () => {
    const r = classify({ citation: citation({ doi: '10.1/x', title: undefined }), searched: [], failed: ['crossref'] });
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/try again later/i);
    expect(r.reason).not.toMatch(/OpenReview/);
  });
});

// A work has several dates (preprint, online, print). A cited year agrees if it is within the
// tolerance of any of them. This only widens Verified: the strong-match test that gates Retracted reads the record's
// main year only.
describe('year agreement across versions', () => {
  const base = { matchedVia: 'search' as const, searched: ALL, failed: [] };

  test('the year of the preprint agrees with a record dated by its publication', () => {
    const r = classify({ citation: citation({ year: 2019 }), match: record({ year: 2022, otherYears: [2019, 2021] }), ...base });
    expect(r.status).toBe('verified');
    expect(r.diffs).toEqual([]);
  });

  test('without another date the year still differs', () => {
    const r = classify({ citation: citation({ year: 2019 }), match: record({ year: 2022 }), ...base });
    expect(r.status).toBe('details_differ');
    expect(r.diffs).toEqual([{ field: 'year', cited: '2019', actual: '2022' }]);
  });

  test('another date counts only inside the tolerance', () => {
    expect(classify({ citation: citation({ year: 2019 }), match: record({ year: 2024, otherYears: [2021] }), ...base }).status).toBe('details_differ');
    expect(classify({ citation: citation({ year: 2019 }), match: record({ year: 2024, otherYears: [2020] }), ...base }).status).toBe('verified');
  });

  // The id's YYMM counts as a date of the work only once the id resolved to the record, which then carries it. An id
  // that never resolved may not exist, or be another work's.
  test('the year of the arXiv id the reference cites agrees when the id is the record\'s', () => {
    const c = citation({ year: 2019, arxivId: '1905.01234' });
    expect(classify({ citation: c, match: record({ year: 2022, otherVersion: { arxivId: '1905.01234' } }), ...base }).status).toBe('verified');
    expect(classify({ citation: c, match: record({ year: 2022 }), ...base }).status).toBe('details_differ');
  });

  test('the year of the preprint the record links to agrees', () => {
    expect(classify({ citation: citation({ year: 2019 }), match: record({ year: 2022, otherVersion: { arxivId: '1906.00001' } }), ...base }).status).toBe('verified');
    expect(classify({ citation: citation({ year: 2019 }), match: record({ year: 2022, arxivId: 'hep-th/9901001' }), ...base }).status).toBe('details_differ');
    expect(classify({ citation: citation({ year: 1999 }), match: record({ year: 2022, arxivId: 'hep-th/9901001' }), ...base }).status).toBe('verified');
  });

  test('a wrong year that no version of the work has is still a difference', () => {
    const c = citation({ year: 2012, arxivId: '1905.01234' });
    // the cited id says 2019, so a cited 2012 agrees with nothing
    expect(classify({ citation: c, match: record({ year: 2022, otherYears: [2019] }), ...base }).status).toBe('details_differ');
  });

  // The year of the arXiv id the reference cites counts for a retraction only if the record is that arXiv work.
  test('a cited arXiv id vouches for the year only for a record that carries that id', () => {
    const c = citation({ title: 'Stem cell niches in the adult brain', year: 2019, arxivId: '1905.01234' });
    const old = record({ title: 'Stem cell niches in the adult brain', year: 2012, isRetracted: true });
    expect(isStrongMatch(c, old, 'search')).toBe(false);
    expect(isStrongMatch(c, { ...old, arxivId: '1905.01234' }, 'search')).toBe(true);
    expect(isStrongMatch(c, { ...old, otherVersion: { arxivId: '1905.01234v2' } }, 'search')).toBe(true);
    expect(isStrongMatch(c, { ...old, arxivId: '1301.00001' }, 'search')).toBe(false);
    // for Verified against Details differ too
    expect(classify({ citation: c, match: old, matchedVia: 'search', searched: ALL, failed: [] }).diffs.map((d) => d.field)).toContain('year');
    expect(classify({ citation: c, match: { ...old, isRetracted: false, arxivId: '1905.01234' }, matchedVia: 'search', searched: ALL, failed: [] }).diffs.map((d) => d.field)).not.toContain('year');
  });

  test('the strong-match test (the gate for Retracted) follows the same rule', () => {
    const c = citation({ year: 2019 });
    expect(isStrongMatch(c, record({ year: 2022, otherYears: [2019] }), 'search')).toBe(true);
    expect(isStrongMatch(c, record({ year: 2022, otherYears: [2016] }), 'search')).toBe(false);
    // everything else a strong match needs is still needed
    expect(isStrongMatch(c, record({ year: 2022, otherYears: [2019], authors: ['someone', 'else', 'again'] }), 'search')).toBe(false);
    expect(isStrongMatch(c, record({ year: 2022, otherYears: [2019], title: 'A rather different title altogether' }), 'search')).toBe(false);
  });
});

// The same paper published twice, one of the two retracted. Which one a citation means is told by its
// year and venue; when nothing tells, no verdict is given.
describe('pickStrong: duplicate publications, one of them retracted', () => {
  const withRaw = (raw: string, over: Partial<ParsedCitation> = {}) => citation({ raw, ...over });
  const retracted = record({ doi: '10.1/a', isRetracted: true, venue: 'Journal of Alpha', year: 2017 });
  const kept = record({ doi: '10.1/b', isRetracted: false, venue: 'Journal of Beta', year: 2017 });

  test('the year the reference cites picks one', () => {
    const r = record({ doi: '10.1/a', isRetracted: true, year: 2016 });
    expect(pickStrong(citation({ year: 2017 }), [r, record({ doi: '10.1/b', year: 2017 })])).toMatchObject({ doi: '10.1/b' });
    expect(pickStrong(citation({ year: 2016 }), [record({ doi: '10.1/b', year: 2017 }), r])).toMatchObject({ doi: '10.1/a' });
  });

  test('the venue named in the reference picks one when the year does not', () => {
    expect(pickStrong(withRaw('V. Shazeer et al. Attention Is All You Need. Journal of Beta, 2017.'), [retracted, kept])).toMatchObject({ doi: '10.1/b' });
    expect(pickStrong(withRaw('V. Shazeer et al. Attention Is All You Need. Journal of Alpha, 2017.'), [kept, retracted])).toMatchObject({ doi: '10.1/a' });
  });

  // The venue is looked for after the title, never in it ("Cell" in "Stem cell niches").
  test('a venue name that only occurs in the title does not pick a copy', () => {
    const cell = record({ title: 'Stem cell niches in the adult brain', doi: '10.1/a', isRetracted: true, venue: 'Cell', year: 2017 });
    const comms = record({ title: 'Stem cell niches in the adult brain', doi: '10.1/b', isRetracted: false, venue: 'Nature Communications', year: 2017 });
    const c = citation({ title: 'Stem cell niches in the adult brain', authors: ['roe', 'smith'], year: 2017, raw: 'Jane Roe and John Smith. Stem cell niches in the adult brain. Nat. Commun. 8, 1-9, 2017.' });
    expect(pickStrong(c, [cell, comms])).toBe('ambiguous');
    expect(pickStrong(c, [comms, cell])).toBe('ambiguous');
  });

  test('a venue named after the title still picks one', () => {
    const cell = record({ title: 'Stem cell niches in the adult brain', doi: '10.1/a', isRetracted: true, venue: 'Cell', year: 2017 });
    const comms = record({ title: 'Stem cell niches in the adult brain', doi: '10.1/b', isRetracted: false, venue: 'Nature Communications', year: 2017 });
    const c = citation({ title: 'Stem cell niches in the adult brain', authors: ['roe', 'smith'], year: 2017, raw: 'Jane Roe and John Smith. Stem cell niches in the adult brain. Nature Communications 8, 1-9, 2017.' });
    expect(pickStrong(c, [cell, comms])).toMatchObject({ doi: '10.1/b' });
  });

  // A short venue must not match inside a longer one, and a copy with no venue cannot be ruled out.
  const STEM = 'Stem cell niches in the adult brain';
  const stemCitation = (raw: string, over: Partial<ParsedCitation> = {}) => citation({ title: STEM, authors: ['roe', 'smith'], year: 2017, raw, ...over });

  test('a retracted copy whose venue is "Cell" is not picked by "Cell Reports" when the other copy has no venue', () => {
    const cell = record({ title: STEM, doi: '10.1/a', isRetracted: true, venue: 'Cell', year: 2017 });
    const kept2 = record({ title: STEM, doi: '10.1/b', isRetracted: false, year: 2017 });
    const c = stemCitation('Jane Roe and John Smith. Stem cell niches in the adult brain. Cell Reports 8, 1-9, 2017.');
    expect(pickStrong(c, [cell, kept2])).toBe('ambiguous');
    expect(pickStrong(c, [kept2, cell])).toBe('ambiguous');
  });

  // Pins the rule above: a copy with no venue is never ruled out, even when the reference names the other copy's venue exactly.
  test('a retracted copy "Cell" cited as "Cell 8, 1-9, 2017" is still ambiguous when the other copy has no venue', () => {
    const cell = record({ title: STEM, doi: '10.1/a', isRetracted: true, venue: 'Cell', year: 2017 });
    const kept2 = record({ title: STEM, doi: '10.1/b', isRetracted: false, year: 2017 });
    const c = stemCitation('Jane Roe and John Smith. Stem cell niches in the adult brain. Cell 8, 1-9, 2017.');
    expect(pickStrong(c, [cell, kept2])).toBe('ambiguous');
    expect(pickStrong(c, [kept2, cell])).toBe('ambiguous');
  });

  test('"Cell" is not "Cell Reports": with both venues known, the longer one is the one cited', () => {
    const cell = record({ title: STEM, doi: '10.1/a', isRetracted: true, venue: 'Cell', year: 2017 });
    const reports = record({ title: STEM, doi: '10.1/b', isRetracted: false, venue: 'Cell Reports', year: 2017 });
    const c = stemCitation('Jane Roe and John Smith. Stem cell niches in the adult brain. Cell Reports 8, 1-9, 2017.');
    expect(pickStrong(c, [cell, reports])).toMatchObject({ doi: '10.1/b' });
    expect(pickStrong(c, [reports, cell])).toMatchObject({ doi: '10.1/b' });
  });

  test('a retracted venue "Brain" does not match "In Brain Informatics"', () => {
    const brain = record({ title: STEM, doi: '10.1/a', isRetracted: true, venue: 'Brain', year: 2017 });
    const lncs = record({ title: STEM, doi: '10.1/b', isRetracted: false, venue: 'Lecture Notes in Computer Science', year: 2017 });
    const c = stemCitation('Jane Roe and John Smith. Stem cell niches in the adult brain. In Brain Informatics, LNCS 10, 1-9, 2017.');
    expect(pickStrong(c, [brain, lncs])).toBe('ambiguous');
    expect(pickStrong(c, [lncs, brain])).toBe('ambiguous');
  });

  test('the parsed venue is preferred over the raw tail', () => {
    const cell = record({ title: STEM, doi: '10.1/a', isRetracted: true, venue: 'Cell', year: 2017 });
    const lncs = record({ title: STEM, doi: '10.1/b', isRetracted: false, venue: 'Lecture Notes in Computer Science', year: 2017 });
    const c = stemCitation('Roe J, Smith J. Stem cell niches in the adult brain. Cell 8:1-9 (2017); see also Lecture Notes in Computer Science', { venue: 'Cell 8:1-9' });
    expect(pickStrong(c, [cell, lncs])).toMatchObject({ doi: '10.1/a' });
  });

  test('the last occurrence of the title ends the part that is searched for the venue', () => {
    const cell = record({ title: STEM, doi: '10.1/a', isRetracted: true, venue: 'Cell', year: 2017 });
    const nat = record({ title: STEM, doi: '10.1/b', isRetracted: false, venue: 'Nature Communications', year: 2017 });
    const c = stemCitation('Stem cell niches in the adult brain. Cell. Roe J, Smith J. Stem cell niches in the adult brain. Nature Communications 8, 1-9, 2017.');
    expect(pickStrong(c, [cell, nat])).toMatchObject({ doi: '10.1/b' });
  });

  test('a cited venue that exactly equals the retracted copy\'s venue still picks it', () => {
    const cell = record({ title: STEM, doi: '10.1/a', isRetracted: true, venue: 'Cell', year: 2017 });
    const nat = record({ title: STEM, doi: '10.1/b', isRetracted: false, venue: 'Nature Communications', year: 2017 });
    const c = stemCitation('Jane Roe and John Smith. Stem cell niches in the adult brain. Cell 8, 1-9, 2017.');
    expect(pickStrong(c, [cell, nat])).toMatchObject({ doi: '10.1/a' });
    expect(pickStrong(stemCitation('x', { venue: 'Cell' }), [nat, cell])).toMatchObject({ doi: '10.1/a' });
  });

  test('nothing to tell them apart is ambiguous', () => {
    expect(pickStrong(withRaw('V. Shazeer et al. Attention Is All You Need. 2017.'), [retracted, kept])).toBe('ambiguous');
  });

  test('without a retracted record, or with two, the best one is taken', () => {
    expect(pickStrong(withRaw('x'), [kept, record({ doi: '10.1/c' })])).toMatchObject({ doi: '10.1/b' });
    expect(pickStrong(withRaw('x'), [retracted, { ...retracted, doi: '10.1/d' }])).toMatchObject({ doi: '10.1/a' });
  });

  test('a single strong record, or none, is not ambiguous', () => {
    expect(pickStrong(citation(), [retracted])).toBe(retracted);
    expect(pickStrong(citation(), [])).toBeUndefined();
  });
});

// Not found is an accusation too. It needs a cited title that reads as a title. A parse that took a few author
// names, a journal word or a string with a person's initials for the title says nothing about whether the work exists.
describe('Not found needs a credible title', () => {
  const searchedAll = { searched: ALL, failed: [] as never[] };
  const verdictFor = (title: string) => classify({ citation: citation({ title, authors: [], confidence: 0.75 }), ...searchedAll });

  test('a real title that nothing matches is Not found', () => {
    expect(verdictFor('Quantum phase diagram of the triangular-lattice XXZ model in a magnetic field').status).toBe('not_found');
    expect(verdictFor('Deep residual learning for image recognition').status).toBe('not_found');
  });

  test.each([
    ['one journal word', 'Phys'],
    ['a few author names', 'Yali Wang, Zhipeng Zhou'],
    ['author names in a list', 'Zhang, Shaoqing Ren, and Jian Sun'],
    ['authors glued to the title', 'R. Beig and P.T. Chrusciel, Killing vectors in asymptotically flat space-times'],
    ['an initial and a surname first', 'X. Zhang, Deep residual learning for image recognition'],
    ['a title with its authors after a semicolon', 'Robust Propensity Score Computation Method based on Machine Learning with Label-corrupted Data; Chen Wang , Suzhen Wang, Fuyan Shi'],
    ['a title that stops on a preposition (the line was cut)', 'On elliptic systems in'],
  ])('%s is no title: Can’t check', (_what, title) => {
    const v = verdictFor(title);
    expect(v.status).toBe('cant_check');
    expect(v.reason).toBe("Couldn't read this reference reliably");
  });

  test('a title with a comma that starts with a word is still a title', () => {
    expect(verdictFor('Attention, please: a study of how readers notice things').status).toBe('not_found');
  });
});

describe('classify: nothing found for a reference that names no venue', () => {
  const searchedAll = { searched: ALL, failed: [] };
  const grey = (raw: string, title: string, over: Partial<ParsedCitation> = {}): ParsedCitation =>
    citation({ raw, title, authors: ['hoadley'], year: 1998, kind: 'unknown', ...over });

  test('a company technical paper is Can\'t check, not Not found', () => {
    const c = grey('Hoadley, Bruce, “Boosting the Performance of Transaction Fraud Scores,” Fair, Isaac Technical Paper, August 4, 1998.', 'Boosting the Performance of Transaction Fraud Scores');
    const r = classify({ citation: c, ...searchedAll });
    expect(r.status).toBe('cant_check');
    expect(r.reason).not.toMatch(/fake|hallucinat|fabricat/i);
  });

  test('a news story or a survey with only a year is Can\'t check', () => {
    const news = grey('Jon Christian. 2023. Cnet secretly used ai on articles that didn’t disclose that fact, staff say. Futurusm, January.', 'Cnet secretly used ai on articles that didn’t disclose that fact, staff say', { year: 2023 });
    expect(classify({ citation: news, ...searchedAll }).status).toBe('cant_check');
  });

  test('a journal named only by volume and pages, or by a venue word, can still be Not found', () => {
    const journal = grey('Cortes, C., Vapnik, V. (1995). Bagged Oblique Trees for Heterogeneous Tabular Streams. Machine Learning 20, 273–297.', 'Bagged Oblique Trees for Heterogeneous Tabular Streams');
    expect(classify({ citation: journal, ...searchedAll }).status).toBe('not_found');
    const physics = grey('A. Roe, Invented flux vacua in made-up compactifications, JHEP 09 (2022) 019.', 'Invented flux vacua in made-up compactifications');
    expect(classify({ citation: physics, ...searchedAll }).status).toBe('not_found');
    expect(classify({ citation: citation({ kind: 'paper' }), ...searchedAll }).status).toBe('not_found');
  });

  // Course material shares words with journals ("Machine Learning", "Neural networks for machine learning") but is in no database.
  test('lecture notes, course notes and slides are Can\'t check, while a Lecture Notes series volume can still be Not found', () => {
    const notes = grey('A. Ng. Lecture notes on support vector machines. Machine Learning, Stanford University.', 'Lecture notes on support vector machines');
    expect(classify({ citation: notes, ...searchedAll }).status).toBe('cant_check');
    const coursera = grey('T. Tieleman and G. Hinton. Lecture 6.5-rmsprop: Divide the gradient by a running average of its recent magnitude. COURSERA: Neural networks for machine learning, 4(2):26–31, 2012.', 'Lecture 6.5-rmsprop: Divide the gradient by a running average of its recent magnitude');
    expect(classify({ citation: coursera, ...searchedAll }).status).toBe('cant_check');
    const slides = grey('J. Roe. Invented diffusion tricks. Course slides, CS231n, 2021.', 'Invented diffusion tricks');
    expect(classify({ citation: slides, ...searchedAll }).status).toBe('cant_check');
    const lncs = grey('A. Roe and B. Doe. Invented secure channels for imaginary networks. In Financial Cryptography, Lecture Notes in Computer Science, vol. 12345, pp. 36–46, 2020.', 'Invented secure channels for imaginary networks');
    expect(classify({ citation: lncs, ...searchedAll }).status).toBe('not_found');
  });

  test('a reference that calls itself a technical report is Can\'t check whatever its venue words', () => {
    const c = citation({ raw: 'Y. LeCun. Generalization and network design strategies. Technical Report CRG-TR-89-4, Proceedings 1989.', title: 'Generalization and network design strategies', kind: 'paper' });
    expect(classify({ citation: c, ...searchedAll }).status).toBe('cant_check');
  });
});

describe('pickBest: a near miss by the cited authors', () => {
  const cited = citation({ title: 'Framework for designing catadioptric projection and imaging systems', authors: ['swaminathan', 'nayar', 'grossberg'], year: 2003 });
  const full = record({ title: 'A General Framework for Designing Catadioptric Imaging and Projection Systems', authors: ['swaminathan', 'grossberg', 'nayar'], year: 2003 });

  test('a record whose title contains every cited word, by the same authors and year, is kept as a close match', () => {
    expect(pickBest(cited, [full])).toBe(full);
    const r = classify({ citation: cited, match: full, matchedVia: 'search', searched: ALL, failed: [] });
    expect(r.status).toBe('details_differ');
  });

  test('a sibling paper by the same authors is not', () => {
    const sibling = record({ title: 'Caustics of catadioptric cameras and imaging systems', authors: ['swaminathan', 'grossberg', 'nayar'], year: 2003 });
    expect(pickBest(cited, [sibling])).toBeUndefined();
  });

  test('other authors, another year, or a single cited author are not enough', () => {
    expect(pickBest(cited, [{ ...full, authors: ['smith', 'jones'] }])).toBeUndefined();
    expect(pickBest(cited, [{ ...full, year: 2010 }])).toBeUndefined();
    expect(pickBest({ ...cited, authors: ['swaminathan'] }, [full])).toBeUndefined();
  });

  test('a near miss is never strong enough to be called Retracted', () => {
    const r = classify({ citation: cited, match: { ...full, isRetracted: true }, matchedVia: 'search', retraction: { retracted: true, version: 'cited' }, searched: ALL, failed: [] });
    expect(r.status).toBe('details_differ');
  });
});
