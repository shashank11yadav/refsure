import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { runtime: { id: 'ext-id', getURL: (path: string) => `chrome-extension://ext-id${path}` } } }));

import { limitedNotice } from '../../../src/ui/banner';
import { renderRow } from '../../../src/ui/resultRow';
import { renderHeader } from '../../../src/ui/summary';
import { readyTitle, usableTabTitle } from '../../../src/ui/title';
import { byText, click, flush, makeDom, text } from '../helpers/dom';
import { doneEvent, makeHarness, resultEvent, started } from '../helpers/panelHarness';
import { counts, paper, result, summaryOf } from '../helpers/results';

const { doc } = makeDom();

describe('tab titles', () => {
  test('a file name is not a title', () => {
    for (const name of ['pdf', 'PDF', '1706.03762.pdf', '1706.03762v7', 'paper.html']) expect(usableTabTitle(name), name).toBeUndefined();
    expect(usableTabTitle('Attention Is All You Need')).toBe('Attention Is All You Need');
    expect(usableTabTitle('Deep PDF parsing')).toBe('Deep PDF parsing');
  });

  test('the ready title falls back to the arXiv id, and to nothing for OpenReview', () => {
    expect(readyTitle('pdf', 'arxiv:1706.03762')).toBe('arXiv:1706.03762');
    expect(readyTitle('pdf', 'openreview:abc123XYZ')).toBeUndefined();
    expect(readyTitle('[1706.03762] Attention Is All You Need', 'arxiv:1706.03762')).toBe('Attention Is All You Need');
  });

  test('the ready screen shows the cleaned title', async () => {
    const h = await makeHarness({ tab: { id: 7, url: 'https://openreview.net/forum?id=abc123XYZ', title: 'A Handmade Confidential Submission | OpenReview' } });
    expect(h.root.querySelector('.ready-title')?.textContent).toBe('A Handmade Confidential Submission');
  });

  test('on a PDF tab named "pdf" the ready screen names the paper by its arXiv id', async () => {
    const h = await makeHarness({ tab: { id: 7, url: 'https://arxiv.org/pdf/1706.03762v7', title: 'pdf' } });
    expect(h.root.querySelector('.ready-title')?.textContent).toBe('arXiv:1706.03762');
  });

  test('a PDF paper known only by its id takes a real tab title for its header, but never a file name', async () => {
    const pdfPaper = paper({ title: 'arXiv:1706.03762', origin: 'arxiv-pdf', viaPdf: true, url: 'https://arxiv.org/pdf/1706.03762v7' });
    const good = await makeHarness({ tab: { id: 7, url: 'https://arxiv.org/pdf/1706.03762v7', title: 'Attention Is All You Need' } });
    await good.emit(started(pdfPaper, 1));
    expect(good.root.querySelector('h1.paper-title')?.textContent).toBe('Attention Is All You Need');
    const bad = await makeHarness({ tab: { id: 7, url: 'https://arxiv.org/pdf/1706.03762v7', title: 'pdf' } });
    await bad.emit(started(pdfPaper, 1));
    expect(bad.root.querySelector('h1.paper-title')?.textContent).toBe('arXiv:1706.03762');
  });

  test('a title the background read is kept', async () => {
    const h = await makeHarness({ tab: { id: 7, url: 'https://arxiv.org/html/1706.03762v7', title: 'Something else | OpenReview' } });
    await h.emit(started(paper(), 1));
    expect(h.root.querySelector('h1.paper-title')?.textContent).toBe('Attention Is All You Need');
  });
});

describe('the small print', () => {
  test('says "only to", and that nothing about the reader is sent but their own OpenAlex key', async () => {
    const h = await makeHarness();
    expect(text(h.root)).toContain(
      "Only this paper's reference details are sent, and only to Crossref, OpenAlex, arXiv, OpenReview and DBLP. Nothing about you is sent, apart from your own OpenAlex key if you added one, which goes only to OpenAlex.",
    );
  });
});

describe('the HTML version line', () => {
  const model = (p = paper({ origin: 'arxiv-abs', url: 'https://arxiv.org/abs/1706.03762' })) => ({ paper: p, title: 'T', phase: 'done' as const, done: 1, total: 1, counts: counts([result()]), beta: false });

  test('an abstract page checked through its HTML version links to it', () => {
    const header = renderHeader(doc, model());
    const link = header.querySelector<HTMLAnchorElement>('.html-version a');
    expect(link?.getAttribute('href')).toBe('https://arxiv.org/html/1706.03762');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(text(header.querySelector('.html-version') as Element)).toBe('Open the HTML version to see a badge next to each reference');
  });

  test('not when the references came from the PDF, from an HTML page, or from OpenReview', () => {
    expect(renderHeader(doc, model(paper({ origin: 'arxiv-abs', viaPdf: true }))).querySelector('.html-version')).toBeNull();
    expect(renderHeader(doc, model(paper())).querySelector('.html-version')).toBeNull();
    expect(renderHeader(doc, model(paper({ key: 'openreview:abc123XYZ', origin: 'openreview' }))).querySelector('.html-version')).toBeNull();
  });

  test('built from a valid id only', () => {
    expect(renderHeader(doc, model(paper({ origin: 'arxiv-abs', key: 'arxiv:../../evil' }))).querySelector('.html-version')).toBeNull();
    expect(renderHeader(doc, model(paper({ origin: 'arxiv-abs', key: 'arxiv:1706.03762/../x' }))).querySelector('.html-version')).toBeNull();
  });
});

describe('result rows', () => {
  const opts = { expanded: true, canScroll: false, onToggle: vi.fn(), onSelect: vi.fn() };

  test('the matched record is shown when details differ, next to the differences', () => {
    const row = renderRow(
      doc,
      result({
        index: 3,
        status: 'details_differ',
        diffs: [{ field: 'year', cited: '2017', actual: '2021' }],
        match: { source: 'crossref', title: 'Attention Is All You Need', authors: ['vaswani'], year: 2021, isRetracted: false, notes: [] },
      }),
      opts,
    );
    expect(row.querySelector('.diff')).not.toBeNull();
    expect(row.querySelector('.matched')?.textContent).toBe('Matched record: Attention Is All You Need (2021) · Crossref');
  });

  test('the matched-paper link says which reference it belongs to', () => {
    const row = renderRow(doc, result({ index: 12, label: '[12]', links: [{ label: 'DOI', url: 'https://doi.org/10.1000/xyz' }, { label: 'arXiv', url: 'https://arxiv.org/abs/1706.03762' }] }), { ...opts, expanded: false });
    const links = [...row.querySelectorAll('a')];
    expect(links[0]?.textContent).toBe('Open matched paper');
    expect(links[0]?.getAttribute('aria-label')).toBe('Open matched paper for reference [12]');
    expect(links[1]?.getAttribute('aria-label')).toBeNull();
  });

  test('a short numeric label is used as the number', () => {
    const row = renderRow(doc, result({ index: 12, label: '12', links: [{ label: 'DOI', url: 'https://doi.org/10.1000/xyz' }] }), { ...opts, expanded: false });
    expect(row.querySelector('a')?.getAttribute('aria-label')).toBe('Open matched paper for reference 12');
  });
});

describe('the limit notice', () => {
  test('only OpenAlex mentions a key', () => {
    expect(limitedNotice('openalex').text).toContain('add your own free OpenAlex key in Settings → Advanced');
    for (const source of ['crossref', 'arxiv', 'openreview', 'dblp'] as const) expect(limitedNotice(source).text, source).not.toMatch(/key/i);
    expect(limitedNotice('dblp').text).toBe("DBLP's lookup limit is reached for now, so some references will show as Can't check. Try again later.");
  });
});

describe('a finished run is untouched by all of this', () => {
  test('a done run still offers Copy report and no partial marker', async () => {
    const h = await makeHarness();
    await h.emit(started(paper(), 1));
    await h.emit(resultEvent(result({ index: 1 })));
    await h.emit(doneEvent(summaryOf(paper(), [result({ index: 1 })])));
    click(byText(h.root, 'button', 'Copy report'));
    await flush();
    expect(h.copied[0]).not.toContain('Stopped after');
    click(byText(h.root, 'button', 'Export JSON'));
    expect(JSON.parse(h.downloads[0]?.content ?? '{}')).not.toHaveProperty('partial');
    expect(h.downloads[0]?.name).toBe('refsure-arxiv-1706.03762.json');
  });
});
