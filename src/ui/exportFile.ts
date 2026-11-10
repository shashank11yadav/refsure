// Saving a file without the `downloads` permission: a Blob behind a temporary <a download> that is
// clicked once and thrown away (SECURITY.md section 3).

const REVOKE_AFTER_MS = 1000;
const BYTE_ORDER_MARK = '﻿';

/** `refsure-arxiv-1706.03762.csv`: only letters, digits, dot and dash, so a paper key can never form a path. */
export function safeFileName(paperKey: string, extension: 'csv' | 'json'): string {
  const base = paperKey.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^[-.]+|-+$/g, '').replace(/\.{2,}/g, '.');
  return `refsure-${base === '' ? 'paper' : base}.${extension}`;
}

export function downloadText(doc: Document, filename: string, mime: string, content: string): void {
  const view = doc.defaultView;
  if (view === null) return;
  // Excel reads a CSV as the local code page unless the file starts with a byte-order mark.
  const body = mime === 'text/csv' ? BYTE_ORDER_MARK + content : content;
  const url = view.URL.createObjectURL(new view.Blob([body], { type: mime }));
  const link = doc.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.setAttribute('hidden', '');
  doc.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Not at once: some browsers start reading the blob a moment after the click.
    setTimeout(() => view.URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}
