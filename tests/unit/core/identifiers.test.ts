import { describe, expect, test } from 'vitest';
import {
  arxivUrl,
  dblpRecordUrl,
  doiUrl,
  findArxivId,
  findDoi,
  isValidArxivId,
  isValidDblpKey,
  isValidDoi,
  isValidOpenAlexWorkId,
  isValidOpenReviewId,
  openalexWorkUrl,
  openreviewUrl,
  stripArxivVersion,
} from '../../../src/core/identifiers';

describe('findDoi', () => {
  test('finds a DOI after a doi: prefix and strips the trailing dot', () => {
    expect(findDoi('… doi:10.1145/3442188.3445922.')).toBe('10.1145/3442188.3445922');
  });

  test('finds a DOI inside a resolver URL', () => {
    expect(findDoi('see https://doi.org/10.1038/nature14539, pp. 1-5')).toBe('10.1038/nature14539');
  });

  test('keeps balanced parentheses but drops an unbalanced closing one', () => {
    expect(findDoi('10.1016/S0092-8674(00)81419-8')).toBe('10.1016/S0092-8674(00)81419-8');
    expect(findDoi('(doi: 10.1000/xyz123)')).toBe('10.1000/xyz123');
  });

  test('does not read the tail of an arXiv number as a DOI', () => {
    expect(findDoi('arXiv:2010.12345v2')).toBeUndefined();
  });

  test('stays fast on hostile input made to trigger repeated trimming', () => {
    const hostile = [
      '10.1000/a' + '.'.repeat(50_000),
      '10.1000/a' + ')'.repeat(50_000),
      '10.1000/a' + '.)'.repeat(25_000),
      '10.'.repeat(17_000),
      '10.1000/' + 'x'.repeat(50_000),
    ];
    for (const text of hostile) {
      const start = performance.now();
      findDoi(text);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });

  test('still finds a real DOI followed by a long run of trailing punctuation', () => {
    expect(findDoi('10.1000/a' + '.'.repeat(50_000))).toBe('10.1000/a');
  });

  test('returns undefined when there is no DOI', () => {
    expect(findDoi('Attention is all you need. NeurIPS 2017.')).toBeUndefined();
  });
});

describe('findArxivId', () => {
  test('reads a DBLP-style CoRR abs/ reference', () => {
    expect(findArxivId('CoRR, abs/1406.1078, 2014.')).toBe('1406.1078');
  });

  test('keeps the version suffix', () => {
    expect(findArxivId('arXiv:2401.01234v3')).toBe('2401.01234v3');
  });

  test('reads old-style identifiers', () => {
    expect(findArxivId('hep-th/9901001')).toBe('hep-th/9901001');
    expect(findArxivId('arXiv:math.GT/0309136')).toBe('math.GT/0309136');
  });

  test('reads URLs and the arXiv DOI form', () => {
    expect(findArxivId('https://arxiv.org/abs/1706.03762')).toBe('1706.03762');
    expect(findArxivId('https://arxiv.org/pdf/1706.03762v7.pdf')).toBe('1706.03762v7');
    expect(findArxivId('doi:10.48550/arXiv.2401.01234')).toBe('2401.01234');
  });

  test('reads the usual "arXiv preprint" wording', () => {
    expect(findArxivId('arXiv preprint arXiv:1706.03762, 2017.')).toBe('1706.03762');
  });

  test('ignores number pairs that have no arXiv context', () => {
    expect(findArxivId('Proc. ICML, pages 1234.56789, 2020')).toBeUndefined();
    expect(findArxivId('vol. 12, no. 2014.1234')).toBeUndefined();
  });

  test('does not accept a longer digit run as an ID', () => {
    expect(findArxivId('arXiv:1706.037621')).toBeUndefined();
  });
});

describe('validators', () => {
  test('stripArxivVersion', () => {
    expect(stripArxivVersion('2401.01234v2')).toBe('2401.01234');
    expect(stripArxivVersion('hep-th/9901001v1')).toBe('hep-th/9901001');
    expect(stripArxivVersion('2401.01234')).toBe('2401.01234');
  });

  test('isValidDoi', () => {
    expect(isValidDoi('10.1145/3442188.3445922')).toBe(true);
    expect(isValidDoi('javascript:alert(1)')).toBe(false);
    expect(isValidDoi('10.12/short-registrant')).toBe(false);
    expect(isValidDoi('10.1000/has space')).toBe(false);
    expect(isValidDoi('10.1000/ctrl\u0000char')).toBe(false);
    expect(isValidDoi('')).toBe(false);
  });

  test('isValidDoi rejects bidi and zero-width characters', () => {
    const hidden = ['\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069', '\ufeff'];
    for (const ch of hidden) {
      expect(isValidDoi(`10.1000/ab${ch}cd`), `U+${ch.charCodeAt(0).toString(16)}`).toBe(false);
    }
  });

  test('isValidDoi rejects dot path segments', () => {
    expect(isValidDoi('10.1000/..')).toBe(false);
    expect(isValidDoi('10.1000/.')).toBe(false);
    expect(isValidDoi('10.1000/a/../b')).toBe(false);
    expect(isValidDoi('10.1000/a/./b')).toBe(false);
    expect(isValidDoi('10.1000/a..b')).toBe(true);
    expect(isValidDoi('10.1000/.hidden')).toBe(true);
  });

  test('isValidArxivId', () => {
    expect(isValidArxivId('2401.01234')).toBe(true);
    expect(isValidArxivId('1406.1078v2')).toBe(true);
    expect(isValidArxivId('hep-th/9901001')).toBe(true);
    expect(isValidArxivId('math.GT/0309136v2')).toBe(true);
    expect(isValidArxivId('2401.012')).toBe(false);
    expect(isValidArxivId('../../etc/passwd')).toBe(false);
    expect(isValidArxivId('2401.01234/../x')).toBe(false);
  });

  test('isValidOpenReviewId', () => {
    expect(isValidOpenReviewId('BJgnXpVYwS')).toBe(true);
    expect(isValidOpenReviewId('zVjNKXSgn5')).toBe(true);
    expect(isValidOpenReviewId('a/b')).toBe(false);
    expect(isValidOpenReviewId('x&y=1')).toBe(false);
    expect(isValidOpenReviewId('')).toBe(false);
  });
});

describe('URL builders', () => {
  test('doiUrl builds from the fixed base and rejects non-DOIs', () => {
    expect(doiUrl('10.1000/xyz')).toBe('https://doi.org/10.1000/xyz');
    expect(() => doiUrl('javascript:alert(1)')).toThrow();
    expect(() => doiUrl('https://evil.example/10.1000/x')).toThrow();
  });

  test('doiUrl escapes characters that could change the URL structure', () => {
    expect(doiUrl('10.1000/a?b=1#c')).toBe('https://doi.org/10.1000/a%3Fb%3D1%23c');
    expect(doiUrl('10.1016/S0092-8674(00)81419-8')).toBe('https://doi.org/10.1016/S0092-8674(00)81419-8');
  });

  test('arxivUrl builds from the fixed base and rejects other input', () => {
    expect(arxivUrl('2401.01234v2')).toBe('https://arxiv.org/abs/2401.01234v2');
    expect(arxivUrl('hep-th/9901001')).toBe('https://arxiv.org/abs/hep-th/9901001');
    expect(() => arxivUrl('https://evil.example')).toThrow();
  });

  test('openreviewUrl builds from the fixed base and rejects other input', () => {
    expect(openreviewUrl('BJgnXpVYwS')).toBe('https://openreview.net/forum?id=BJgnXpVYwS');
    expect(() => openreviewUrl('x&y=1')).toThrow();
  });

  test('openalexWorkUrl builds the work page (openalex.org/works/W…) from a work id (W and digits) and rejects anything else', () => {
    expect(openalexWorkUrl('W2626778328')).toBe('https://openalex.org/works/W2626778328');
    for (const bad of ['', 'W', 'w2626778328', 'A5103024730', 'W12a', 'W1 ', ' W1', 'W1/../x', 'W1?x=1', 'W1#x', 'https://openalex.org/W1', 'https://evil.example/W1', `W${'1'.repeat(16)}`, 'W\u0661\u0662']) {
      expect(isValidOpenAlexWorkId(bad), bad).toBe(false);
      expect(() => openalexWorkUrl(bad), bad).toThrow();
    }
  });

  test('dblpRecordUrl builds the record page from a DBLP key of the documented shape and rejects anything else', () => {
    expect(dblpRecordUrl('conf/nips/VaswaniSPUJGKP17')).toBe('https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17');
    expect(dblpRecordUrl('journals/corr/abs-1706-03762')).toBe('https://dblp.org/rec/journals/corr/abs-1706-03762');
    expect(dblpRecordUrl('books/sp/16/Smith16')).toBe('https://dblp.org/rec/books/sp/16/Smith16');
    expect(isValidDblpKey('phd/basesearch/Roe19')).toBe(true);
    for (const bad of [
      '',
      'conf',
      'conf/nips',
      'conf/nips/../../evil',
      'conf/nips/./x',
      'conf//x',
      'conf/nips/x/',
      '/conf/nips/x',
      'conf/nips/a?b=1',
      'conf/nips/a#b',
      'conf/nips/a b',
      'conf/nips/a%2Fb',
      'conf/nips/caf\u00e9',
      'homepages/v/AshishVaswani',
      'evil/nips/x',
      'https://evil.example/conf/nips/x',
      'conf/a/b/c/d',
      `conf/nips/${'x'.repeat(200)}`,
    ]) {
      expect(isValidDblpKey(bad), bad).toBe(false);
      expect(() => dblpRecordUrl(bad), bad).toThrow();
    }
  });
});

describe('DOIs with lone surrogates', () => {
  test('findDoi refuses a DOI containing a lone surrogate', () => {
    expect(findDoi('10.1234/\uD800abc')).toBeUndefined();
    expect(findDoi('10.1234/abc\uDC00')).toBeUndefined();
  });

  test('isValidDoi and doiUrl reject them without a URIError', () => {
    expect(isValidDoi('10.1234/\uD800abc')).toBe(false);
    expect(() => doiUrl('10.1234/\uD800abc')).toThrow('Invalid DOI');
    expect(() => doiUrl('10.1234/\uD800abc')).not.toThrow(URIError);
  });

  test('a well-formed surrogate pair (astral character) is still accepted', () => {
    expect(isValidDoi('10.1234/ab\u{1D49C}')).toBe(true);
  });
});
