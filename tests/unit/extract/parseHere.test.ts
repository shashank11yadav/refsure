import { Window } from 'happy-dom';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { parseHere } from '../../../src/extract/parseHere';
import { pageBytes, pageText } from '../helpers/pages';

// parseHere uses the DOMParser of the page it runs in; here that is happy-dom's, set up to load nothing.
beforeAll(() => {
  const window = new Window({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, enableImageFileLoading: false } });
  vi.stubGlobal('DOMParser', window.DOMParser);
});
afterEach(() => vi.restoreAllMocks());

describe('parseHere', () => {
  test('arXiv HTML text is parsed into references', async () => {
    const result = await parseHere({ kind: 'arxiv-html-text', html: pageText('arxiv-2402.03664v5.html') });
    expect(result.refs).toHaveLength(71);
    expect(result.refs[4]).toMatchObject({ index: 5, label: '[5]', anchorId: 'bib.bib5' });
    expect(result.confidence).toBe(1);
  });

  test('HTML without a bibliography gives no references and zero confidence', async () => {
    expect(await parseHere({ kind: 'arxiv-html-text', html: '<html><body><p>No list.</p></body></html>' })).toEqual({ refs: [], confidence: 0 });
  });

  test('hostile HTML is read as text and nothing in it runs', async () => {
    const html =
      '<ul><li class="ltx_bibitem"><span class="ltx_bibblock">&lt;img src=x onerror=alert(1)&gt;<script>globalThis.__ran = true</script></span></li></ul>';
    const result = await parseHere({ kind: 'arxiv-html-text', html });
    expect(result.refs[0]?.text).toBe('<img src=x onerror=alert(1)>');
    expect((globalThis as { __ran?: boolean }).__ran).toBeUndefined();
  });

  test('a PDF is parsed into references', async () => {
    const result = await parseHere({ kind: 'pdf', data: pageBytes('arxiv-2402.03664v5-numeric.pdf') });
    expect(result.refs).toHaveLength(71);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});
