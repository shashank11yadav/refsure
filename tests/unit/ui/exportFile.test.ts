import { afterEach, describe, expect, test, vi } from 'vitest';
import { downloadText, safeFileName } from '../../../src/ui/exportFile';
import { makeDom } from '../helpers/dom';

afterEach(() => vi.restoreAllMocks());

describe('downloadText', () => {
  test('clicks a temporary a[download] on a blob URL, then removes it and revokes the URL', async () => {
    const { win, doc } = makeDom();
    const created: Blob[] = [];
    vi.spyOn(win.URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as unknown as Blob);
      return 'blob:test-1';
    });
    const revoke = vi.spyOn(win.URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const seen: { download: string | null; href: string | null; inDom: boolean }[] = [];
    doc.addEventListener('click', (event) => {
      const a = event.target as HTMLAnchorElement;
      seen.push({ download: a.getAttribute('download'), href: a.getAttribute('href'), inDom: doc.body.contains(a) });
      event.preventDefault();
    });
    downloadText(doc, 'refsure-test.json', 'application/json', '{"a":1}');
    expect(seen).toEqual([{ download: 'refsure-test.json', href: 'blob:test-1', inDom: true }]);
    expect(doc.querySelector('a[download]')).toBeNull();
    expect(created[0]?.type).toBe('application/json');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(revoke).toHaveBeenCalledWith('blob:test-1');
  });

  test('a CSV starts with a byte-order mark so spreadsheets read accents correctly', async () => {
    const { win, doc } = makeDom();
    const created: Blob[] = [];
    vi.spyOn(win.URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as unknown as Blob);
      return 'blob:test-2';
    });
    vi.spyOn(win.URL, 'revokeObjectURL').mockImplementation(() => undefined);
    doc.addEventListener('click', (event) => event.preventDefault());
    downloadText(doc, 'x.csv', 'text/csv', 'a,b');
    expect(await created[0]?.text()).toBe('﻿a,b');
  });
});

describe('safeFileName', () => {
  test('keeps letters, digits, dot and dash only', () => {
    expect(safeFileName('arxiv:1706.03762', 'csv')).toBe('refsure-arxiv-1706.03762.csv');
    expect(safeFileName('openreview:../../etc/passwd', 'json')).not.toMatch(/[/\\:]/);
  });
});
