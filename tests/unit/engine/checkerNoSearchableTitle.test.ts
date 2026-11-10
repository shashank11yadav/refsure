import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));
// The parser never hands over a title without letters or digits, so the engine's own guard is exercised
// by giving it one directly.
vi.mock('../../../src/core/parseCitation', () => ({
  parseCitation: vi.fn((ref: { text: string }) => ({ raw: ref.text, title: '??? --- !!!', authors: ['roe', 'smith'], year: 2019, kind: 'paper', confidence: 0.9, ...(ref.text.includes('doi') && { doi: '10.1000/xyz123' }) })),
}));

import { checkReference } from '../../../src/engine/checker';
import { makeDeps, mockSources, ref } from '../helpers/engine';

describe('an adapter that sends no request is not a search', () => {
  test('a title with no letters or digits and no identifier is Can\'t check, nothing is sent or cached', async () => {
    const sources = mockSources();
    const deps = makeDeps(sources);
    const r = await checkReference(ref(1, 'junk'), deps, new AbortController().signal);
    expect(r.status).toBe('cant_check');
    for (const s of Object.values(sources)) expect(s.search).not.toHaveBeenCalled();
    expect(deps.cache.sets).toEqual([]);
  });

  test('with a DOI that resolves nowhere the unsearched sources keep it from being Not found', async () => {
    const sources = mockSources();
    const deps = makeDeps(sources);
    const r = await checkReference(ref(1, 'junk doi'), deps, new AbortController().signal);
    expect(r.status).toBe('cant_check');
    for (const s of Object.values(sources)) expect(s.search).not.toHaveBeenCalled();
    expect(r.sourcesSearched).not.toContain('arxiv');
    expect(deps.cache.sets).toEqual([]);
  });
});
