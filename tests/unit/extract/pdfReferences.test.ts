import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { referencesFromPages } from '../../../src/extract/pdfReferences';
import { type Row, HEAD, column, page } from '../helpers/pdfPages';

const texts = (rows: ReturnType<typeof referencesFromPages>['refs']) => rows.map((r) => r.text);

describe('referencesFromPages: finding the list', () => {
  test('no heading means nothing found', () => {
    const result = referencesFromPages([page(column(72, 100, ['[1] A. Author. A title. 2020.', '[2] B. Author. Another. 2021.']))]);
    expect(result).toEqual({ refs: [], confidence: 0 });
  });

  test('no pages means nothing found', () => {
    expect(referencesFromPages([])).toEqual({ refs: [], confidence: 0 });
  });

  test.each(['References', 'REFERENCES', 'R EFERENCES', '7 References', '7. Bibliography', 'Literature Cited'])('heading %j', (heading) => {
    const rows = [{ x: 72, y: 100, text: heading, size: 14 }, ...column(72, 130, ['[1] A. Author. A title here. 2020.', '[2] B. Author. Another one. 2021.'])];
    expect(referencesFromPages([page(rows)]).refs).toHaveLength(2);
  });

  test('the last "References" heading wins', () => {
    const body = page([
      HEAD(100),
      ...column(72, 130, ['[1] Early A. An early list that is not the paper bibliography. 2001.']),
      ...column(72, 300, ['Some more text and then a second part.']),
      HEAD(400),
      ...column(72, 430, ['[1] Late A. The real first entry in the real list. 2020.', '[2] Late B. The real second entry in the real list. 2021.']),
    ]);
    expect(texts(referencesFromPages([body]).refs)).toEqual(['Late A. The real first entry in the real list. 2020.', 'Late B. The real second entry in the real list. 2021.']);
  });

  test('a heading with nothing readable after it falls back to the previous one', () => {
    const rows = [HEAD(100), ...column(72, 130, ['[1] A. Author. A title here. 2020.', '[2] B. Author. Another one. 2021.']), HEAD(300)];
    expect(referencesFromPages([page(rows)]).refs).toHaveLength(2);
  });

  test('the word "references" inside a sentence is not a heading', () => {
    const rows = column(72, 100, ['We cite prior work in References below, see also the references of that paper.', '[1] A. Author. A title here. 2020.', '[2] B. Author. Another. 2021.']);
    expect(referencesFromPages([page(rows)]).refs).toEqual([]);
  });

  test.each(['Appendix', 'APPENDIX', 'A Appendix', '10 A PPENDIX', 'Appendix A: Proofs', 'Supplementary Material', 'Supplemental material for this paper'])(
    'the list stops at the heading %j',
    (end) => {
      const rows = [
        HEAD(),
        ...column(72, 130, ['[1] A. Author. A title here. 2020.', '[2] B. Author. Another one. 2021.']),
        { x: 72, y: 200, text: end, size: 10 },
        ...column(72, 215, ['[3] Not a reference at all, just appendix text. 2022.', 'More appendix text.']),
      ];
      const refs = referencesFromPages([page(rows)]).refs;
      expect(refs).toHaveLength(2);
    },
  );

  test('the list also stops at a section heading set in a larger size', () => {
    const rows = [
      HEAD(),
      ...column(72, 130, ['[1] A. Author. A title here. 2020.', '[2] B. Author. Another one. 2021.']),
      { x: 72, y: 190, text: 'A Experimental details', size: 14 },
      ...column(72, 210, ['We trained all models for 100 epochs.']),
    ];
    expect(referencesFromPages([page(rows)]).refs).toHaveLength(2);
  });

  describe('what follows the list on the same page', () => {
    const list = (n: number) => column(72, 130, Array.from({ length: n }, (_, i) => `[${i + 1}] Author${i + 1}, A. Title number ${i + 1}. Journal, 20${10 + i}.`));
    const lastY = (n: number) => 130 + (n - 1) * 11;

    test.each(['Table 3: Hyperparameters for training.', 'Figure 9: Proportion of tokens assigned to each expert.', 'Fig. 2. Overview of the method.', 'Algorithm 1: Training loop'])(
      'stops at the caption %j',
      (caption) => {
        const rows = [HEAD(), ...list(6), { x: 72, y: lastY(6) + 11, text: caption, size: 10 }, { x: 72, y: lastY(6) + 22, text: 'more caption text 2020', size: 10 }];
        const refs = referencesFromPages([page(rows)]).refs;
        expect(refs).toHaveLength(6);
        expect(refs[5]?.text).toBe('Author6, A. Title number 6. Journal, 2015.');
      },
    );

    test('stops at a numbered section heading set in a larger size, though it looks like a numbered entry', () => {
      const rows = [
        HEAD(),
        ...column(72, 130, Array.from({ length: 8 }, (_, i) => `${i + 1}. Author${i + 1}, A. Title number ${i + 1}. Journal, 20${10 + i}.`)),
        { x: 72, y: 130 + 8 * 11 + 14, text: '9. Contributions and Acknowledgments', size: 14 },
        { x: 72, y: 130 + 8 * 11 + 30, text: 'Gemini Leads', size: 10 },
      ];
      const refs = referencesFromPages([page(rows)]).refs;
      expect(refs).toHaveLength(8);
      expect(refs[7]?.text).toBe('Author8, A. Title number 8. Journal, 2017.');
    });

    test('stops at text set in a clearly smaller size, such as a table', () => {
      const rows = [HEAD(), ...list(6), { x: 72, y: lastY(6) + 11, text: 'Models Dataset Epochs Base LR 0.1 0.0 2020', size: 7 }];
      expect(referencesFromPages([page(rows)]).refs[5]?.text).toBe('Author6, A. Title number 6. Journal, 2015.');
    });

    test('stops after a gap far wider than the line spacing', () => {
      const rows = [HEAD(), ...list(6), { x: 72, y: lastY(6) + 120, text: 'Layer 0 Either choice 0.3 0.2 0.1 0 2020', size: 10 }];
      expect(referencesFromPages([page(rows)]).refs[5]?.text).toBe('Author6, A. Title number 6. Journal, 2015.');
    });

    test('a trailing block at the same size and spacing cannot make the last entry much longer than the others', () => {
      const tail = Array.from({ length: 12 }, (_, i) => `tail line ${i} of an appendix paragraph`);
      const rows = [HEAD(), ...list(6), ...column(72, lastY(6) + 11, tail)];
      const last = referencesFromPages([page(rows)]).refs[5];
      expect(last?.text.split(' tail line').length).toBeLessThanOrEqual(3);
      expect(last?.text).not.toContain('tail line 5');
    });
  });

  test('a reference that starts with "Supplementary" inside a label is not an end marker', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] A. Author. A title here. 2020.', '[2] Supplementary data for the thing. B. Author. 2021.'])];
    expect(referencesFromPages([page(rows)]).refs).toHaveLength(2);
  });
});

describe('referencesFromPages: numbered lists', () => {
  const entries = (n: number, mark: (i: number) => string) => Array.from({ length: n }, (_, i) => `${mark(i + 1)} Author${i + 1}, A. Title number ${i + 1} of the work. Journal, 20${10 + (i % 10)}.`);

  test('[n] labels, with entries that run over several lines', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] A. Author. A long title that', 'wraps onto the next line. Journal, 2020.', '[2] B. Author. Short. 2021.', '[3] C. Author. Third entry here. 2019.'])];
    const result = referencesFromPages([page(rows)]);
    expect(result.refs).toEqual([
      { index: 1, label: '[1]', text: 'A. Author. A long title that wraps onto the next line. Journal, 2020.' },
      { index: 2, label: '[2]', text: 'B. Author. Short. 2021.' },
      { index: 3, label: '[3]', text: 'C. Author. Third entry here. 2019.' },
    ]);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  test('a label on its own line takes the following lines as its text', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1]', 'A. Author. A title here. 2020.', '[2]', 'B. Author. Another. 2021.'])];
    expect(texts(referencesFromPages([page(rows)]).refs)).toEqual(['A. Author. A title here. 2020.', 'B. Author. Another. 2021.']);
  });

  test.each([
    ['(n)', (n: number) => `(${n})`],
    ['n.', (n: number) => `${n}.`],
  ])('%s labels', (_name, mark) => {
    const rows = [HEAD(), ...column(72, 130, entries(12, mark))];
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs).toHaveLength(12);
    expect(refs[10]?.label).toBe(mark(11));
    expect(refs[10]?.text.startsWith('Author11')).toBe(true);
  });

  test('a year at the start of a continuation line is not a new entry', () => {
    const rows = [HEAD(), ...column(72, 130, ['1. A. Author. A title that goes on for a while,', '2019. Journal of Things.', '2. B. Author. Next. 2020.', '3. C. Author. Last. 2021.'])];
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs).toHaveLength(3);
    expect(refs[0]?.text).toContain('2019. Journal of Things.');
  });

  test('a single lost label does not lose the rest of the list', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] A. Author. One. 2020.', '[2] B. Author. Two. 2020.', '[4] D. Author. Four. 2020.', '[5] E. Author. Five. 2020.'])];
    const result = referencesFromPages([page(rows)]);
    expect(result.refs.map((r) => r.label)).toEqual(['[1]', '[2]', '[4]', '[5]']);
    expect(result.refs.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect(result.confidence).toBeLessThan(1);
  });

  test('hyphenated line breaks are joined', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] A. Author. Learning long-term dependen-', 'cies with gradient descent. Journal, 2020.', '[2] B. Author. Lopez-', 'Gazpio and others. 2021.'])];
    expect(texts(referencesFromPages([page(rows)]).refs)).toEqual([
      'A. Author. Learning long-term dependencies with gradient descent. Journal, 2020.',
      'B. Author. Lopez-Gazpio and others. 2021.',
    ]);
  });

  test('web addresses broken across lines stay whole', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] A. Author. Title. URL http://', 'arxiv.org/abs/1811.', '03962. 2019.', '[2] B. Author. Next one. 2020.'])];
    expect(referencesFromPages([page(rows)]).refs[0]?.text).toBe('A. Author. Title. URL http://arxiv.org/abs/1811.03962. 2019.');
  });

  test('a web address that ends a line is not glued to the next sentence', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] A. Author. Title. URL http://arxiv.org/abs/1905.10337.', 'arXiv: 1905.10337. 2019.', '[2] B. Author. Next one. 2020.'])];
    expect(referencesFromPages([page(rows)]).refs[0]?.text).toBe('A. Author. Title. URL http://arxiv.org/abs/1905.10337. arXiv: 1905.10337. 2019.');
  });
});

describe('referencesFromPages: keyed lists', () => {
  test('alphanumeric keys are kept whole as labels', () => {
    const rows = [HEAD(), ...column(72, 130, ['[Vas17] A. Vaswani et al. Attention is all you need. 2017.', '[DGV+19] M. Dehghani, S. Gouws, O. Vinyals. Universal transformers.', '2019.', '[BCRL79] D. Bini, M. Capovani. Approximate multiplication. 1979.'])];
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs.map((r) => r.label)).toEqual(['[Vas17]', '[DGV+19]', '[BCRL79]']);
    expect(refs[1]?.text).toBe('M. Dehghani, S. Gouws, O. Vinyals. Universal transformers. 2019.');
    expect(refs.every((r) => !r.text.includes('['))).toBe(true);
  });

  test('a key with a raised "+" (a superscript run above the baseline) stays on its line', () => {
    const runs = (y: number, label: [string, string, string], text: string) => [
      { x: 80, y, text: label[0], size: 10 },
      { x: 80 + label[0].length * 4.5, y: y - 3.6, text: label[1], size: 7 },
      { x: 80 + label[0].length * 4.5 + label[1].length * 3.15, y, text: `${label[2]} ${text}`, size: 10 },
    ];
    const rows = [
      HEAD(),
      ...runs(130, ['[ADG', '+', '16]'], 'Marcin Andrychowicz and Nando De Freitas. Learning to learn. 2016.'),
      ...runs(160, ['[BBDIW', '+', '20]'], 'Su Lin Blodgett and Hanna Wallach. Language is power. 2020.'),
      { x: 80, y: 190, text: '[AI19] WeChat AI. Tr-mt (ensemble), December 2019.', size: 10 },
    ];
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs.map((r) => r.label)).toEqual(['[ADG+16]', '[BBDIW+20]', '[AI19]']);
    expect(refs[0]?.text).toBe('Marcin Andrychowicz and Nando De Freitas. Learning to learn. 2016.');
  });

  test('"[Online]" continuation lines are not keys', () => {
    const rows = [HEAD(), ...column(72, 130, ['[Vas17] A. Vaswani. Attention is all you need. 2017.', '[Online]. Available: https://example.org/x', '[Sch81] A. Schonhage. Matrix multiplication. 1981.'])];
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs).toHaveLength(2);
    expect(refs[0]?.text).toContain('[Online]. Available');
  });
});

describe('referencesFromPages: author-year lists', () => {
  const entry = (n: number): string[] => [`Surname${n}, A. and Other, B. ${2000 + n}. Title number ${n} of an`, 'interesting paper. In Proceedings of Something.'];
  const hanging = (n: number, x = 72, top = 130): Row[] =>
    Array.from({ length: n }, (_, i) => {
      const [a, b] = entry(i + 1);
      const y = top + i * 2 * 11;
      return [
        { x, y, text: a ?? '' },
        { x: x + 11, y: y + 11, text: b ?? '' },
      ];
    }).flat();

  test('hanging indent marks where each entry starts', () => {
    const result = referencesFromPages([page([HEAD(), ...hanging(6)])]);
    expect(result.refs).toHaveLength(6);
    expect(result.refs[0]).toEqual({ index: 1, label: '[1]', text: 'Surname1, A. and Other, B. 2001. Title number 1 of an interesting paper. In Proceedings of Something.' });
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  test('a wider gap between entries marks where each starts (no indent)', () => {
    const rows: Row[] = [HEAD()];
    for (let i = 0; i < 6; i++) {
      const y = 130 + i * 36;
      rows.push({ x: 72, y, text: `Surname${i}, A. and Other, B. ${2001 + i}. A title for number ${i} that` }, { x: 72, y: y + 11, text: 'continues on the second line. Journal of Examples.' });
    }
    const result = referencesFromPages([page(rows)]);
    expect(result.refs).toHaveLength(6);
    expect(result.refs[2]?.text).toBe('Surname2, A. and Other, B. 2003. A title for number 2 that continues on the second line. Journal of Examples.');
  });

  test('author names alone can mark the starts when layout says nothing', () => {
    const rows = column(72, 130, [
      'Smith, J. and Jones, K. 2019. A paper about things',
      'that goes on to a second line.',
      'Brown, L. 2020. Another paper with a title.',
      'Taylor, M. and Lee, N. 2018. A third paper title',
      'which also wraps around.',
      'Wilson, P. 2017. The fourth paper.',
    ]);
    const result = referencesFromPages([page([HEAD(), ...rows])]);
    expect(result.refs).toHaveLength(4);
    expect(result.confidence).toBeLessThan(0.85);
  });

  test('an entry that continues across a page break stays one entry', () => {
    // The entries run down to the foot of the page, so the fourth starts there and ends on the next.
    const first = page([HEAD(600), ...hanging(3, 72, 634), { x: 72, y: 700, text: 'Surname4, A. and Other, B. 2004. Title number 4 of an' }]);
    const second = page([
      { x: 83, y: 100, text: 'interesting paper. In Proceedings of Something.' },
      { x: 72, y: 111, text: 'Surname5, A. and Other, B. 2005. Title number 5 of an' },
      { x: 83, y: 122, text: 'interesting paper. In Proceedings of Something.' },
    ]);
    const refs = referencesFromPages([first, second]).refs;
    expect(refs).toHaveLength(5);
    expect(refs[3]?.text).toBe('Surname4, A. and Other, B. 2004. Title number 4 of an interesting paper. In Proceedings of Something.');
  });
});

describe('referencesFromPages: two columns', () => {
  const colEntries = (from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `[${from + i}] Author${from + i}, A. A title for work ${from + i}. Venue, 20${10 + ((from + i) % 10)}.`);

  test('the left column is read before the right', () => {
    const rows = [HEAD(100, 50), ...column(50, 130, colEntries(1, 5), 30), ...column(320, 130, colEntries(6, 10), 30)];
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs.map((r) => r.label)).toEqual(Array.from({ length: 10 }, (_, i) => `[${i + 1}]`));
  });

  test('lines from the two columns that share a height are not merged', () => {
    const rows = [HEAD(100, 50), ...column(50, 130, colEntries(1, 8), 20), ...column(320, 130, colEntries(9, 16), 20)];
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs).toHaveLength(16);
    expect(refs[7]?.text).toBe('Author8, A. A title for work 8. Venue, 2018.');
    expect(refs[8]?.text).toBe('Author9, A. A title for work 9. Venue, 2019.');
  });

  test('a short last column on the final page still reads as a column', () => {
    const first = page([HEAD(100, 50), ...column(50, 130, colEntries(1, 8), 20), ...column(320, 130, colEntries(9, 16), 20)]);
    const last = page([...column(50, 100, colEntries(17, 22), 20), ...column(320, 100, colEntries(23, 23), 20)]);
    expect(referencesFromPages([first, last]).refs).toHaveLength(23);
  });

  test('a two-column hanging-indent list reads each column in turn', () => {
    const entry = (n: number, x: number, y: number): Row[] => [
      { x, y, text: `Surname${n}, A. 20${10 + n}. A title for the work numbered` },
      { x: x + 10, y: y + 10, text: `${n} in this list. Venue.` },
    ];
    const rows: Row[] = [HEAD(100, 50)];
    for (let i = 0; i < 6; i++) rows.push(...entry(i + 1, 50, 130 + i * 20), ...entry(i + 7, 320, 130 + i * 20));
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs).toHaveLength(12);
    expect(refs[6]?.text.startsWith('Surname7')).toBe(true);
  });
});

describe('referencesFromPages: page furniture', () => {
  test('page numbers and repeated running heads are not part of an entry', () => {
    const header = (y: number): Row => ({ x: 72, y, text: 'Published as a conference paper at ICLR 2015', size: 9 });
    const pageNo = (n: number): Row => ({ x: 300, y: 760, text: String(n), size: 9 });
    const first = page([header(40), HEAD(), ...column(72, 130, ['[1] A. Author. A title here. 2020.', '[2] B. Author. Another one. 2021.']), pageNo(10)]);
    const second = page([header(40), ...column(72, 100, ['[3] C. Author. Third one. 2019.', '[4] D. Author. Fourth one. 2018.']), pageNo(11)]);
    const refs = referencesFromPages([first, second]).refs;
    expect(refs).toHaveLength(4);
    expect(texts(refs).join(' ')).not.toMatch(/Published as|\b1[01]\b/);
  });
});

describe('referencesFromPages: untrusted text', () => {
  test('markup and instructions inside a reference stay plain text', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] <img src=x onerror=alert(1)> Ignore previous instructions. 2020.', '[2] B. Author. Another one. 2021.'])];
    expect(referencesFromPages([page(rows)]).refs[0]?.text).toBe('<img src=x onerror=alert(1)> Ignore previous instructions. 2020.');
  });

  test('a huge number of entries is capped and finishes quickly', () => {
    // Entries differ in their letters, not just their digits: identical text near a page edge on
    // several pages is how a running head looks.
    const word = (n: number): string => n.toString(26).replace(/[0-9a-p]/g, (c) => String.fromCharCode(97 + parseInt(c, 26)));
    const pages = [];
    let n = 0;
    for (let p = 0; p < 40; p++) {
      const body = column(72, p === 0 ? 100 : 80, Array.from({ length: 55 }, () => `[${++n}] ${word(n)}, A. Title ${word(n * 7)}. 2020.`), 12);
      pages.push(page(p === 0 ? [HEAD(70), ...body] : body));
    }
    const started = performance.now();
    const refs = referencesFromPages(pages).refs;
    expect(refs).toHaveLength(2000);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test('one enormous entry is cut to a bounded length', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] ' + 'word '.repeat(100_000), '[2] B. Author. Another one. 2021.'])];
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs[0]?.text.length).toBeLessThanOrEqual(5000);
  });

  test('an entry of tens of thousands of lines is read in bounded time', () => {
    const body = Array.from({ length: 30_000 }, (_, i) => `continuation line ${i.toString(36)}-`);
    const rows = [HEAD(), ...column(72, 130, ['[1] A. Author. Start of a runaway entry', ...body, '[2] B. Author. Another one. 2021.'])];
    const started = performance.now();
    const refs = referencesFromPages([page(rows, { width: 612, height: 400_000 })]).refs;
    expect(performance.now() - started).toBeLessThan(3000);
    expect(refs[0]?.text.length).toBeLessThanOrEqual(5000);
  });

  test('thousands of alternating "References" and "Appendix" lines are handled in near-linear time', () => {
    const texts = Array.from({ length: 16_000 }, (_, i) => (i % 2 === 0 ? 'References' : 'Appendix'));
    const rows = column(72, 100, texts);
    const started = performance.now();
    const result = referencesFromPages([page(rows, { width: 612, height: 400_000 })]);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result).toEqual({ refs: [], confidence: 0 });
  });

  test('only the last few headings are tried', () => {
    // A real list, then pairs of bare "References" / "Appendix" lines (each pair holds no entries).
    const noise = (pairs: number) => column(72, 200, Array.from({ length: pairs * 2 }, (_, i) => (i % 2 === 0 ? 'References' : 'Appendix')));
    const real = [HEAD(100), ...column(72, 130, ['[1] A. Author. A title here. 2020.', '[2] B. Author. Another. 2021.'])];
    expect(referencesFromPages([page([...real, ...noise(6)])]).refs).toEqual([]);
    expect(referencesFromPages([page([...real, ...noise(4)])]).refs).toHaveLength(2);
  });

  test('hundreds of thousands of entries or runs on one line do not overflow the call stack', () => {
    const labels = (from: number) => Array.from({ length: 100_000 }, (_, i) => `[${from + i}] A. Author${i}. T${i}.`);
    const tall = { width: 612, height: 1_500_000 };
    const pages = [page([HEAD(50), ...column(72, 100, labels(1))], tall), page(column(72, 100, labels(100_001)), tall)];
    expect(() => referencesFromPages(pages)).not.toThrow();
    const oneLine: Row[] = Array.from({ length: 200_000 }, (_, i) => ({ x: i * 0.001, y: 100, text: 'w' }));
    expect(() => referencesFromPages([page([HEAD(50), ...oneLine])])).not.toThrow();
  });

  test('a long run of hyphens or spaces does not slow the join down', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] ' + '-'.repeat(50_000), 'a' + ' '.repeat(50_000) + 'b', '[2] B. Author. Another one. 2021.'])];
    const started = performance.now();
    referencesFromPages([page(rows)]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

// Letters in Physical Review Letters and Nature style print the numbered list right after the text,
// with no "References" heading to look for. The fixtures are the text runs (with positions) of the last pages
// of two such papers from the evaluation, not the PDFs.
describe('referencesFromPages: a numbered list with no heading', () => {
  const pagesOf = (file: string) => JSON.parse(readFileSync(new URL(`../../fixtures/pdf-text/${file}`, import.meta.url), 'utf8')) as Parameters<typeof referencesFromPages>[0];

  test('LIGO 1602.03837 ([n] labels, two columns, author lists after the list): 111 references', () => {
    const { refs, confidence } = referencesFromPages(pagesOf('ligo-1602.03837-last-pages.json'));
    expect(refs).toHaveLength(111);
    expect(refs[0]?.label).toBe('[1]');
    expect(refs[0]?.text).toMatch(/^A\. Einstein, Sitzungsber\. K\. Preuss\. Akad\. Wiss\. 1, 688 \(1916\)\.$/);
    expect(refs[110]?.label).toBe('[111]');
    expect(refs.every((r) => r.text.length < 600)).toBe(true);
    expect(confidence).toBeGreaterThanOrEqual(0.6);
  });

  // The list ends on page 11 in two short columns above the full-width author list. Read as one
  // column, the lines of [112]-[115] and [116]-[118] would be joined across the gutter: 115 entries instead of 118.
  test('LIGO 1602.03837 with its last page (two short columns above the author list): all 118 references, column by column', () => {
    const { refs } = referencesFromPages([...pagesOf('ligo-1602.03837-last-pages.json'), ...pagesOf('ligo-1602.03837-page-11.json')]);
    expect(refs).toHaveLength(118);
    expect(refs.map((r) => r.label)).toEqual(Array.from({ length: 118 }, (_, i) => `[${i + 1}]`));
    expect(refs.slice(111).map((r) => r.text)).toEqual([
      'C. Kim, V. Kalogera, and D. R. Lorimer, Astrophys. J. 584, 985 (2003).',
      'W. M. Farr, J. R. Gair, I. Mandel, and C. Cutler, Phys. Rev. D 91, 023005 (2015).',
      'J. Abadie et al., Classical Quantum Gravity 27, 173001 (2010).',
      'B. Abbott et al., https://dcc.ligo.org/LIGO‑P1500222/public/main.',
      'LIGO Open Science Center (LOSC), https://losc.ligo.org/events/GW150914/.',
      'B. P. Abbott et al. (LIGO Scientific Collaboration and Virgo Collaboration), Living Rev. Relativity 19, 1 (2016).',
      'B. Iyer et al., LIGO-India Technical Report No. LIGO-M1100296, 2011, https://dcc.ligo.org/LIGO‑M1100296/public/main.',
    ]);
  });

  test('Nature letter 1803.00255 (n. labels, hanging continuation lines, figures after the list): 32 references', () => {
    const { refs } = referencesFromPages(pagesOf('nature-1803.00255-last-pages.json'));
    expect(refs).toHaveLength(32);
    expect(refs[0]?.text).toMatch(/^Nasu, K\., Ping, H\. & Mizouchi, H\. Photoinduced structural phase transitions and their dynamics\. J Phys-Condens Mat 13, R693–R721 \(2001\)\.$/);
    expect(refs[31]?.text).toMatch(/Physical Review E 88, 175 \(2013\)\.$/);
  });

  const body = [...column(72, 100, ['1. Introduction', 'Some text about the method and nothing else.', '2. Methods', 'More text about the method, with a year 2020 in it.', '3. Results', 'And results.', '4. Discussion', 'Words.', '5. Conclusion', 'End of the paper.'])];

  test('numbered section headings are not a reference list', () => {
    expect(referencesFromPages([page(body)])).toEqual({ refs: [], confidence: 0 });
  });

  // Five sections, each mentioning a year, and numbered steps of a proof are runs counting up from 1 as well.
  test('numbered sections that mention years are not a reference list', () => {
    const rows = column(72, 100, [
      '1. Introduction. Since 2015 neural networks have been applied to many problems of this kind, and we study one.',
      '2. Background. The method of 2018 introduced an approach that we extend in the rest of this paper.',
      '3. Methods. We train the model for 100 epochs on the data collected between 2019 and 2021 in two sites.',
      '4. Results. The model reaches 91 percent accuracy, better than the 2020 baseline by a wide margin overall.',
      '5. Conclusion. In 2022 we plan to extend the study to more sites and to other kinds of data than these.',
    ]);
    expect(referencesFromPages([page(rows)])).toEqual({ refs: [], confidence: 0 });
  });

  test('numbered sections are not a list even when none of them starts with a section word', () => {
    const rows = column(72, 100, Array.from({ length: 6 }, (_, i) => `${i + 1}. Our approach number ${i + 1} follows the data collected between 2019 and 2021 in two sites and uses a model.`));
    expect(referencesFromPages([page(rows)])).toEqual({ refs: [], confidence: 0 });
  });

  test('numbered steps of a proof are not a reference list', () => {
    // every step carries a year, so only the reading of the entries can tell them from references
    const rows = column(72, 100, [
      '1. Let n = 2019 and suppose that f is continuous on the closed interval.',
      '2. Then f attains its maximum at some point of the interval in 2020, by compactness.',
      '3. If the maximum is at an endpoint we are done, since 2021 is not needed here.',
      '4. Otherwise the derivative vanishes there and we apply the step of 1999 again.',
      '5. Hence f is constant on the interval, which contradicts the choice of 2018.',
      '6. This completes the proof of the claim stated above for every such function in 2022.',
    ]);
    expect(referencesFromPages([page(rows)])).toEqual({ refs: [], confidence: 0 });
  });

  test('numbered sections that cite authors and years are not a reference list either', () => {
    const rows = column(72, 100, [
      '1. Setting. Smith, Jones and Brown (2019) studied the problem on the closed interval of the real line.',
      '2. Model. Following Roe and Doe (2020) we assume that the data are drawn from a normal distribution.',
      '3. Estimation. Lee, Kim and Park (2018) proposed an estimator that we use in the rest of this section.',
      '4. Inference. As in Wang and Chen (2021) the test statistic is compared with its limiting distribution.',
      '5. Remarks. Garcia, Lopez and Diaz (2022) discuss several extensions that we do not pursue in this note.',
    ]);
    expect(referencesFromPages([page(rows)])).toEqual({ refs: [], confidence: 0 });
  });

  // Author-year entries whose titles start in lower case ("(2018) mixup: ...") are references, not sentences.
  test('Springer-style numbered entries with lower-case titles are read as references', () => {
    const rows = column(72, 100, [
      '1. Zhang H, Cisse M, Dauphin YN, Lopez-Paz D (2018) mixup: Beyond empirical risk minimization. In: ICLR 2018',
      '2. Mikolov T, Chen K, Corrado G, Dean J (2013) word2vec explained: deriving the skip-gram model. Preprint',
      '3. Gupta R, Lee S, Nguyen T (2019) arXiv:1905.00001 a short note on sparse recovery. Preprint',
      '4. Vaswani A, Shazeer N, Parmar N (2017) attention is all you need. In: Advances in Neural Information Processing Systems, pp 5998-6008',
      '5. LeCun Y, Bengio Y, Hinton G (2015) deep learning. Nature 521(7553):436-444',
    ]);
    expect(referencesFromPages([page(rows)]).refs).toHaveLength(5);
  });

  test('a bracketed year followed by a lower-case word is still a sentence when nothing marks an entry', () => {
    const rows = column(72, 100, Array.from({ length: 6 }, (_, i) => `${i + 1}. Smith, Jones and Brown (2019) studied the problem number ${i + 1} on the closed interval of the real line.`));
    expect(referencesFromPages([page(rows)])).toEqual({ refs: [], confidence: 0 });
  });

  test('a run whose entries are far too long or too short is not a list', () => {
    const tiny = column(72, 100, Array.from({ length: 8 }, (_, i) => `[${i + 1}] A. B. 2020.`));
    expect(referencesFromPages([page(tiny)]).refs).toEqual([]);
  });

  test('a short run of numbered lines is not taken for a list', () => {
    const rows = column(72, 100, ['[1] A. Author. A title here. 2020.', '[2] B. Author. Another one. 2021.', '[3] C. Author. A third one. 2022.']);
    expect(referencesFromPages([page(rows)]).refs).toEqual([]);
  });

  test('numbered entries without years are not references', () => {
    const rows = column(
      72,
      100,
      Array.from({ length: 8 }, (_, i) => `[${i + 1}] Something said in the text without a date or any other mark of a reference`),
    );
    expect(referencesFromPages([page(rows)]).refs).toEqual([]);
  });

  test('a list under a heading is read as before, and the heading still wins', () => {
    const rows = [...column(72, 100, Array.from({ length: 6 }, (_, i) => `[${i + 1}] Early A. Not the list. 200${i}.`)), HEAD(300), ...column(72, 330, ['[1] A. Author. A title here. 2020.', '[2] B. Author. Another one. 2021.'])];
    expect(referencesFromPages([page(rows)]).refs).toHaveLength(2);
  });

  test('several numbered runs: the longest one is the list', () => {
    const short = Array.from({ length: 5 }, (_, i) => `[${i + 1}] Jane Roe, John Smith. A note on figures, number ${i}. Journal of Stuff 3, 4-9 (2019).`);
    const long = Array.from({ length: 12 }, (_, i) => `[${i + 1}] Jane Roe, John Smith. A study of things, number ${i}. Journal of Stuff 3, 4-9 (2019).`);
    const rows = [...column(72, 100, short), ...column(72, 300, ['Acknowledgements are here.']), ...column(72, 330, long)];
    expect(referencesFromPages([page(rows)]).refs).toHaveLength(12);
  });
});

describe('referencesFromPages: TeX accents set as separate glyphs', () => {
  test('an accent before a letter is joined to it, a stray one is dropped', () => {
    const rows = [
      HEAD(),
      ...column(72, 130, [
        '[1] P.T. Chrusciel´ , Anti-gravity `a la Carlotto-Schoen, S´eminaire Bourbaki, Ast´erisque 407 (2019), 1–25.',
        '[2] G. Caciotta and F. Nicolo ´, Global characteristic problem, J. Hyper. Differ. Equ. 2 (2005), 201–277.',
        '[3] O. H¨older, A title, Math. Ann. 34 (1889), 26–56.',
      ]),
    ];
    expect(texts(referencesFromPages([page(rows)]).refs)).toEqual([
      'P.T. Chrusciel, Anti-gravity à la Carlotto-Schoen, Séminaire Bourbaki, Astérisque 407 (2019), 1–25.',
      'G. Caciotta and F. Nicolo, Global characteristic problem, J. Hyper. Differ. Equ. 2 (2005), 201–277.',
      'O. Hölder, A title, Math. Ann. 34 (1889), 26–56.',
    ]);
  });
});

describe('referencesFromPages: an accent left after a word', () => {
  test('"and´ E. Delay" loses the accent, and the names read cleanly', () => {
    const rows = [HEAD(), ...column(72, 130, ['[1] P.T. Chrusciel and´ E. Delay, Exotic hyperbolic gluings, J. Differential Geom. 108 (2018), 243–293.', '[2] E. Witten, A new proof of the positive energy theorem, Comm. Math. Phys. 80 (1981), 381–402.'])];
    expect(texts(referencesFromPages([page(rows)]).refs)[0]).toBe('P.T. Chrusciel and E. Delay, Exotic hyperbolic gluings, J. Differential Geom. 108 (2018), 243–293.');
  });
});

describe('referencesFromPages: a one-column page full of mathematics', () => {
  test('a reference line that crosses the middle in one run is not cut at the gutter', () => {
    // Many tiny runs on both sides (formulas), and the references as long runs across the middle, with the tail of
    // one entry starting right of the middle: the page is one column, so the tail stays with its entry.
    const formulas: Row[] = [];
    for (let i = 0; i < 80; i++) formulas.push({ x: 80 + (i % 4) * 20, y: 400 + Math.floor(i / 4) * 12, text: 'x' }, { x: 340 + (i % 4) * 20, y: 400 + Math.floor(i / 4) * 12, text: 'y' });
    const rows: Row[] = [
      HEAD(100),
      { x: 72, y: 130, text: '[1] R.B. Lockhart and R.C. McOwen, On elliptic systems in' },
      { x: 345, y: 130, text: 'Rn, Acta Math. 150 (1983), 125–135.' },
      { x: 72, y: 145, text: '[2] D. Maxwell, Rough solutions of the Einstein constraint equations on compact manifolds, J. Hyp. 2 (2005).' },
      { x: 72, y: 160, text: '[3] E. Witten, A new proof of the positive energy theorem, Comm. Math. Phys. 80 (1981), 381–402.' },
      ...formulas,
    ];
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs[0]?.text).toBe('R.B. Lockhart and R.C. McOwen, On elliptic systems in Rn, Acta Math. 150 (1983), 125–135.');
  });
});

// The character share applies only to a page broken into tiny runs.
describe('referencesFromPages: a two-column page with a few full-width lines', () => {
  test('lines split into a few runs each, and three full-width lines under the columns, still read as two columns', () => {
    const rows: Row[] = [HEAD(80, 50)];
    // Each reference line in three runs (name / title / venue), as pdf.js often gives them.
    const entry = (n: number, x: number, y: number): Row[] => [
      { x, y, text: `[${n}] Author${n}, A.` },
      { x: x + 80, y, text: `Title of work ${n}.` },
      { x: x + 170, y, text: `Venue 20${10 + (n % 10)}.` },
    ];
    for (let i = 0; i < 20; i++) rows.push(...entry(i + 1, 50, 110 + i * 22));
    for (let i = 0; i < 20; i++) rows.push(...entry(i + 21, 320, 110 + i * 22));
    for (let i = 0; i < 3; i++) rows.push({ x: 50, y: 580 + i * 12, text: 'This full width note runs across the whole page under both columns of the reference list and is long enough to cross it.' });
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs).toHaveLength(40);
    expect(refs[0]?.text).toBe('Author1, A. Title of work 1. Venue 2011.');
    expect(refs[20]?.text).toBe('Author21, A. Title of work 21. Venue 2011.');
  });
});

// A page with two columns above a full-width block (the last page of a PRL paper, where the list ends
// above the author list) is two-column only in its upper band. Columns are decided band by band.
describe('referencesFromPages: columns above a full-width block on the same page', () => {
  // Every entry runs over two lines, so lines joined across the gutter would mix two entries' text.
  const entry = (n: number): string[] => [`[${n}] Author${n}, A. A title for the work`, `numbered ${n}. Venue, 20${10 + (n % 10)}.`];
  const entries = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => entry(from + i)).flat();
  const text = (n: number): string => `Author${n}, A. A title for the work numbered ${n}. Venue, 20${10 + (n % 10)}.`;
  const twoColumnPage = page([HEAD(100, 50), ...column(50, 130, entries(1, 8), 20), ...column(320, 130, entries(9, 16), 20)]);
  // The paper's text, in two columns too: most of the document is two-column, as in a real two-column paper.
  const prose = Array.from({ length: 40 }, () => 'Words of the paper in a column of text.');
  const bodyPage = page([...column(50, 100, prose), ...column(320, 100, prose)]);
  const names = 'A. Person, B. Person, C. Person, D. Person, E. Person, F. Person, G. Person, H. Pers';
  const fullWidth = (top: number, count: number): Row[] => Array.from({ length: count }, (_, i) => ({ x: 50, y: top + i * 16, text: names, size: 13 }));

  test('the columns are read one after the other, and the full-width lines after them', () => {
    const last = page([...column(50, 80, entries(17, 20), 14), ...column(320, 80, entries(21, 23), 14), ...fullWidth(220, 10)]);
    const refs = referencesFromPages([bodyPage, twoColumnPage, last]).refs;
    expect(refs.map((r) => r.label)).toEqual(Array.from({ length: 23 }, (_, i) => `[${i + 1}]`));
    expect(refs.slice(16).map((r) => r.text)).toEqual([17, 18, 19, 20, 21, 22, 23].map(text));
  });

  test('a band between two full-width blocks is read column by column too', () => {
    const last = page([...fullWidth(80, 3), HEAD(130, 50), ...column(50, 160, entries(1, 4), 14), ...column(320, 160, entries(5, 8), 14), ...fullWidth(290, 6)]);
    const refs = referencesFromPages([bodyPage, twoColumnPage, last]).refs;
    expect(refs.map((r) => r.text)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(text));
  });

  test('a one-column page whose lines break near the middle is not cut into columns', () => {
    // Each line in two runs with a word space (3 points) between them, at the middle of the page (306): neither run
    // crosses it, yet the line is one line.
    const split = (n: number, y: number): Row[] => {
      const left = `[${n}] Author${n}, A. A long title for the work it goes`;
      return [
        { x: 72, y, text: left },
        { x: 72 + left.length * 4.5 + 3, y, text: 'across the middle. Venue, 2017.' },
      ];
    };
    const rows: Row[] = [];
    for (let i = 0; i < 6; i++) rows.push(...split(17 + i, 80 + i * 14));
    // The full-width lines below make the page mixed, so it is read band by band.
    const refs = referencesFromPages([bodyPage, twoColumnPage, page([...rows, ...fullWidth(220, 10)])]).refs;
    expect(refs).toHaveLength(22);
    expect(refs[16]?.text).toBe('Author17, A. A long title for the work it goes across the middle. Venue, 2017.');
  });

  test('a document mostly in one column is not cut into columns, even where its lines leave a gap down the middle', () => {
    const rows = [HEAD(100, 50), ...column(50, 130, entries(1, 3), 14), ...column(320, 130, entries(4, 6), 14), ...fullWidth(400, 4)];
    // In a document not set in two columns, the page is read line by line as before; the label guard keeps the numbers apart.
    const refs = referencesFromPages([page(rows)]).refs;
    expect(refs.map((r) => r.label)).toEqual(['[1]', '[2]', '[3]', '[4]', '[5]', '[6]']);
    expect(refs[0]?.text).toBe('Author1, A. A title for the work');
  });
});

// Whatever the layout, two entries never share one number. An entry that holds a later label the list
// lacks ("[116]" inside [112]) is cut there.
describe('referencesFromPages: a later label inside an entry', () => {
  const list = (lines: string[]) => referencesFromPages([page([HEAD(), ...column(72, 130, lines)])]);

  test('a label the list lacks is cut out into its own entry, in label order', () => {
    const result = list(['[1] A. Author. One. 2020.', '[2] B. Author. Two. 2020. [5] E. Author. Five. 2021.', '[3] C. Author. Three. 2020.', '[4] D. Author. Four. 2020.']);
    expect(result.refs.map((r) => r.label)).toEqual(['[1]', '[2]', '[3]', '[4]', '[5]']);
    expect(result.refs.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
    expect(result.refs[1]?.text).toBe('B. Author. Two. 2020.');
    expect(result.refs[4]?.text).toBe('E. Author. Five. 2021.');
  });

  test('a label at the start of a line that the numbering skipped is cut there', () => {
    const result = list(['[1] A. Author. One. 2020.', '[2] B. Author. Two. 2020.', '[3] C. Author. Three,', 'long title. 2020.', '[9] I. Author. Nine. 2021.']);
    expect(result.refs.map((r) => r.label)).toEqual(['[1]', '[2]', '[3]', '[9]']);
    expect(result.refs[2]?.text).toBe('C. Author. Three, long title. 2020.');
    expect(result.refs[3]?.text).toBe('I. Author. Nine. 2021.');
  });

  test('a label the list has is a cross-reference and stays in the text', () => {
    const result = list(['[1] A. Author. One. 2020.', '[2] B. Author. Two, see also [4]. 2020.', '[3] C. Author. Three. 2020.', '[4] D. Author. Four. 2020.']);
    expect(result.refs).toHaveLength(4);
    expect(result.refs[1]?.text).toBe('B. Author. Two, see also [4]. 2020.');
  });

  test('an earlier label, a bracketed year and a number far past the list are not labels', () => {
    const lines = ['[1] A. Author. One. 2020.', '[2] B. Author. Erratum to [1] Two. 2020.', '[3] C. Author. Three [2019] Edition. 2019.', '[4] D. Author. Four [90] Collected. 2020.'];
    expect(texts(list(lines).refs)).toEqual(['A. Author. One. 2020.', 'B. Author. Erratum to [1] Two. 2020.', 'C. Author. Three [2019] Edition. 2019.', 'D. Author. Four [90] Collected. 2020.']);
  });

  test('an entry joined line by line with another is cut, and the list is marked less certain', () => {
    const entries = (merged: boolean): string[] => [
      ...Array.from({ length: 8 }, (_, i) => `[${i + 1}] Author${i + 1}, A. A title for the work numbered ${i + 1}. Venue, 2020.`),
      merged ? '[9] Iris Author, A first title that [10] Jon Author, A second title' : '[9] Iris Author, A first title that',
      merged ? 'goes on. J. A 1, 2 (2020). goes on. J. B 3, 4 (2021).' : 'goes on. J. A 1, 2 (2020).',
      ...(merged ? [] : ['[10] Jon Author, A second title', 'goes on. J. B 3, 4 (2021).']),
    ];
    const merged = list(entries(true));
    const clean = list(entries(false));
    expect(merged.refs.map((r) => r.label)).toEqual(clean.refs.map((r) => r.label));
    expect(merged.refs[8]?.text).toBe('Iris Author, A first title that');
    expect(merged.refs[9]?.text.startsWith('Jon Author, A second title')).toBe(true);
    expect(merged.confidence).toBeLessThan(clean.confidence);
  });

  test('the two parts of a cut in the middle of a line are marked partial; a cut at a line start is not', () => {
    const mid = list(['[1] A. Author. One. 2020.', '[2] B. Author. Two. 2020. [5] E. Author. Five. 2021.', '[3] C. Author. Three. 2020.', '[4] D. Author. Four. 2020.']);
    expect(mid.refs.map((r) => r.partial === true)).toEqual([false, true, false, false, true]);
    const start = list(['[1] A. Author. One. 2020.', '[2] B. Author. Two. 2020.', '[3] C. Author. Three,', 'long title. 2020.', '[9] I. Author. Nine. 2021.']);
    expect(start.refs.some((r) => r.partial === true)).toBe(false);
    expect(start.refs.every((r) => !('partial' in r))).toBe(true);
  });

  // A bracketed number inside a real entry, followed by a lower-case word, is no label.
  test.each([
    ['chemistry: "[7] helicene"', ['[1] A. Author. A first title of a paper. J. Am. Chem. Soc. 120, 1 (1998).', '[2] B. Author. Synthesis of [7] helicene derivatives by photocyclization. J. Org. Chem. 61, 2 (1996).', '[3] C. Author. A third title of a paper. Angew. Chem. 37, 3 (1998).', '[4] D. Author. A fourth title of a paper. Chem. Rev. 98, 4 (1998).'], ['[1]', '[2]', '[3]', '[4]']],
    ['a cross-reference to an entry the list lost', ['[1] A. Author. A first title of a paper. Phys. Rev. 1, 1 (1990).', '[2] B. Author. A second title of a paper. Phys. Rev. 2, 2 (1991); see also [9] for the full derivation.', '[3] C. Author. A third title of a paper. Phys. Rev. 3, 3 (1992).'], ['[1]', '[2]', '[3]']],
  ])('a mid-line "[n]" before a lower-case word is not cut: %s', (_what, lines, labels) => {
    const result = list(lines);
    expect(result.refs.map((r) => r.label)).toEqual(labels);
    expect(result.refs.some((r) => r.partial === true)).toBe(false);
  });

  test('an invented reference that hides a later label before its title still has its title read as an entry', () => {
    const result = list(['[1] A. Author. One. 2020.', '[2] Z. Nobody, [3] An invented title on nothing at all, Phys. Rev. Lett. 99, 123456 (2020).']);
    expect(result.refs.map((r) => r.text)).toContain('An invented title on nothing at all, Phys. Rev. Lett. 99, 123456 (2020).');
  });
});

// In two-column physics papers the list often starts halfway down a page, under text that fills the top of both
// columns. Read column by column, that text sits between the last entry of the left column and the first of the right,
// and was taken into that entry. Real continuations of an entry onto the next column or page must still join.
describe('referencesFromPages: an entry at the foot of a column or page', () => {
  const pagesOf = (file: string) => JSON.parse(readFileSync(new URL(`../../fixtures/pdf-text/${file}`, import.meta.url), 'utf8')) as Parameters<typeof referencesFromPages>[0];

  test('RevTeX 2610.31730: the closing paragraph at the top of the right column is not part of the last left entry', () => {
    const { refs } = referencesFromPages(pagesOf('revtex-2610.31730-page-13.json'));
    expect(refs.map((r) => r.label)).toEqual(Array.from({ length: 40 }, (_, i) => `[${i + 1}]`));
    expect(refs[21]?.text).toBe('C. Drischler, J. W. Holt, and C. Wellenhofer, Ann. Rev. Nucl. Part. Sci. 71, 403 (2021).');
    expect(refs[22]?.text).toBe('F. Sammarruca and R. Millerson, Phys. Rev. C 104, 034308 (2021).');
    expect(refs.map((r) => r.text).join(' ')).not.toMatch(/laboris anim|labore reprehenderit/);
  });

  test('RevTeX 2610.28399: equations at the top of the right column neither join the last left entry nor end the list', () => {
    const { refs } = referencesFromPages(pagesOf('revtex-2610.28399-pages-23-24.json'));
    expect(refs.map((r) => r.label)).toEqual(Array.from({ length: 65 }, (_, i) => `[${i + 1}]`));
    expect(refs[20]?.text).toBe('C. Ott, A. Kaldun, P. Raith, K. Meyer, M. Laux, J. Evers, C. H. Keitel, C. H. Greene, and T. Pfeifer, Science 340, 716 (2013).');
    expect(refs[21]?.text).toBe('A. M. Lane and R. G. Thomas, Rev. Mod. Phys. 30, 257 (1958).');
    expect(refs[64]?.text).toBe('S. Fan, W. Suh, and J. D. Joannopoulos, J. Opt. Soc. Am. A 20, 569 (2003).');
    expect(refs.map((r) => r.text).join(' ')).not.toMatch(/analytic|residue|Eq\./);
  });

  const entries = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `[${from + i}] A. Author${from + i}, Phys. Rev. D ${from + i}, 1${from + i} (2015).`);
  const left = (from: number, to: number): Row[] => column(50, 400, entries(from, to), 11, 9);
  const right = (top: number, from: number, to: number): Row[] => column(320, top, entries(from, to), 11, 9);

  test('an entry that runs on into the next column, in the same size, stays one entry', () => {
    const rows = [
      ...left(1, 8),
      { x: 50, y: 488, text: '[9] C. Kim, V. Kalogera, and D. R. Lorimer, Astrophys.', size: 9 },
      { x: 320, y: 100, text: 'J. 584, 985 (2003).', size: 9 },
      ...right(111, 10, 16),
    ];
    const refs = referencesFromPages([page([HEAD(370, 50), ...rows])]).refs;
    expect(refs).toHaveLength(16);
    expect(refs[8]?.text).toBe('C. Kim, V. Kalogera, and D. R. Lorimer, Astrophys. J. 584, 985 (2003).');
  });

  test('an entry that runs on into the next page, in the same size, stays one entry', () => {
    const first = page([HEAD(370, 50), ...column(50, 400, entries(1, 5), 11, 9), { x: 50, y: 455, text: '[6] W. M. Farr, J. R. Gair, I. Mandel, and C. Cutler,', size: 9 }]);
    const second = page(column(50, 100, ['Phys. Rev. D 91, 023005 (2015).', '[7] J. Abadie et al., Classical Quantum Gravity 27, 173001 (2010).'], 11, 9));
    const refs = referencesFromPages([first, second]).refs;
    expect(refs).toHaveLength(7);
    expect(refs[5]?.text).toBe('W. M. Farr, J. R. Gair, I. Mandel, and C. Cutler, Phys. Rev. D 91, 023005 (2015).');
  });

  // An altered reference whose changed year sits at the top of the next column must keep it, so the check can see it.
  test('an altered year carried over to the next column stays in its entry', () => {
    const rows = [
      ...left(1, 8),
      { x: 50, y: 488, text: '[9] B. P. Abbott et al., Observation of Gravitational Waves', size: 9 },
      { x: 320, y: 100, text: 'from a Binary Black Hole Merger, Phys. Rev. Lett. 116,', size: 9 },
      { x: 320, y: 111, text: '061102 (2009).', size: 9 },
      ...right(122, 10, 16),
    ];
    const refs = referencesFromPages([page([HEAD(370, 50), ...rows])]).refs;
    expect(refs[8]?.text).toBe('B. P. Abbott et al., Observation of Gravitational Waves from a Binary Black Hole Merger, Phys. Rev. Lett. 116, 061102 (2009).');
  });

  // An invented entry at the foot of a column is read on its own words: the text skipped after it never lends it a title.
  test('an invented entry before skipped text keeps only its own words', () => {
    const rows = [
      ...left(1, 8),
      { x: 50, y: 488, text: '[9] Z. Nobody, An invented study of nothing, Phys. Rev. D 99,', size: 9 },
      { x: 50, y: 499, text: '123456 (2020).', size: 9 },
      ...column(320, 100, ['Attention is all you need, as shown in Ref. [3], and the', 'results agree with Observation of Gravitational Waves.'], 11, 10),
      ...right(140, 10, 16),
    ];
    const refs = referencesFromPages([page([HEAD(370, 50), ...rows])]).refs;
    expect(refs).toHaveLength(16);
    expect(refs[8]?.text).toBe('Z. Nobody, An invented study of nothing, Phys. Rev. D 99, 123456 (2020).');
  });

  // A continuation whose first line is set a little taller (a formula in a title) and is followed by its own text is no
  // stray text: it stays in the entry.
  test('a continuation whose first line is set taller stays in the entry when the entry text follows it', () => {
    const rows = [
      ...left(1, 8),
      { x: 50, y: 488, text: '[9] A. Author, Measuring the', size: 9 },
      { x: 320, y: 100, text: '√ s = 13 TeV cross section,', size: 10 },
      { x: 320, y: 111, text: 'Phys. Lett. B 761, 179 (2016).', size: 9 },
      ...right(122, 10, 16),
    ];
    const refs = referencesFromPages([page([HEAD(370, 50), ...rows])]).refs;
    expect(refs).toHaveLength(16);
    expect(refs[8]?.text).toBe('A. Author, Measuring the √ s = 13 TeV cross section, Phys. Lett. B 761, 179 (2016).');
  });

  // The author list of a large collaboration after the list, and its affiliations, set in the list's size, on the next page.
  test('text in another size filling the next column ends the list at the break', () => {
    const rows = [...left(1, 9), ...column(320, 100, Array.from({ length: 8 }, (_, i) => `B. P. Abbott${i}, R. Abbott, T. D. Abbott, M. R. Abernathy,`), 11, 10)];
    const affiliations = page(column(50, 100, ['Nikhef, Science Park, 1098 XG Amsterdam, Netherlands', 'INFN, Gran Sasso Science Institute, I-67100 L’Aquila, Italy'], 11, 9));
    const refs = referencesFromPages([page([HEAD(370, 50), ...rows]), affiliations]).refs;
    expect(refs).toHaveLength(9);
    expect(refs[8]?.text).toBe('A. Author9, Phys. Rev. D 9, 19 (2015).');
  });

  // Springer LNCS sets its running head lower than most styles, so it is not near the page edge.
  test('a running head with a page number at the top of the next page is not part of the entry it interrupts', () => {
    const A4 = { width: 595, height: 842 };
    const head = (n: number): Row => (n % 2 === 1 ? { x: 265, y: 101, text: `Automatic Normalization of Word Variations ${n}`, size: 9 } : { x: 135, y: 101, text: `${n} Rajat Singh, Nurendra Choudhary and Manish Shrivastava`, size: 9 });
    const numbered = (from: number): string[] => Array.from({ length: 4 }, (_, i) => `${from + i}. Author${from + i}, A.: A title for work ${from + i}. In: Proceedings. pp. 1–10 (2015)`);
    const p8 = page([head(8), ...column(135, 127, ['Body text of the paper on its eighth page.', 'More body text.'], 11, 9)], A4);
    const p9 = page([head(9), ...column(135, 127, ['Body text of the paper.', 'References'], 11, 9), ...column(135, 160, numbered(1), 11, 9)], A4);
    const p10 = page(
      [
        head(10),
        ...column(135, 127, numbered(5), 11, 9),
        ...column(135, 171, ['9. Sharma, S., Srinivas, P., Balabantaray, R.C.: Text normalization of code mix and', 'sentiment analysis. In: Advances in Computing, Communications and Informatics', '(ICACCI), 2015 International Conference on. pp. 1468–1473. IEEE (2015)'], 11, 9),
      ],
      A4,
    );
    const p11 = page([head(11), ...column(135, 127, ['10. Socher, R., Perelygin, A., Wu, J., Chuang, J., Manning, C.D., Ng, A., Potts, C.:', 'Recursive deep models for semantic compositionality over a sentiment treebank.'], 11, 9)], A4);
    const refs = referencesFromPages([p8, p9, p10, p11]).refs;
    expect(refs.find((r) => r.label === '9.')?.text).toBe(
      'Sharma, S., Srinivas, P., Balabantaray, R.C.: Text normalization of code mix and sentiment analysis. In: Advances in Computing, Communications and Informatics (ICACCI), 2015 International Conference on. pp. 1468–1473. IEEE (2015)',
    );
    expect(refs.map((r) => r.text).join(' ')).not.toMatch(/Automatic Normalization|Shrivastava/);
  });

  test.each(['Acknowledgements', 'Acknowledgments', 'ACKNOWLEDGMENTS', 'Author contributions', 'Competing interests', 'Data availability', 'Additional information'])(
    'the list ends at the heading %j on the next page',
    (heading) => {
      const list = Array.from({ length: 6 }, (_, i) => `${i + 1}. Author${i}, A. et al. A title of work ${i}. Phys. Rev. Lett. 121, 02430${i} (2018).`);
      const first = page([HEAD(400), ...column(72, 430, list, 11, 12)]);
      const second = page([{ x: 72, y: 100, text: heading, size: 12 }, ...column(72, 128, ['This work is partially supported by funding from the Australian Research Council through an', 'ARC Future Fellowship project (FT130100778) and a Discovery project (DP130102956).'], 11, 12)]);
      const refs = referencesFromPages([first, second]).refs;
      expect(refs).toHaveLength(6);
      expect(refs[5]?.text).toBe('Author5, A. et al. A title of work 5. Phys. Rev. Lett. 121, 024305 (2018).');
    },
  );

  test('a reference line that starts with one of those words is not taken for the heading', () => {
    const list = ['1. Author, A. A first title of work. Nature 1, 2 (2018).', '2. Author, B. A second title of a work on', 'Acknowledgements in scientific papers. Scientometrics 3, 4 (2019).', '3. Author, C. A third title. Science 5, 6 (2020).'];
    const refs = referencesFromPages([page([HEAD(), ...column(72, 130, list)])]).refs;
    expect(refs).toHaveLength(3);
    expect(refs[1]?.text).toBe('Author, B. A second title of a work on Acknowledgements in scientific papers. Scientometrics 3, 4 (2019).');
  });
});
