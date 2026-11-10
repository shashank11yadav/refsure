// Reading a paper's references in the page that is running this code. It needs a DOM
// (DOMParser) and, for PDFs, Workers: so this runs in the offscreen document on Chrome and
// Edge and in the background page on Firefox, never in the Chrome service worker.

import { extractArxivReferences } from './arxivHtml';
import type { ParseRequest, ParseResult } from './offscreenProtocol';
import { extractPdfReferences } from './pdfReferences';

export async function parseHere(request: ParseRequest): Promise<ParseResult> {
  if (request.kind === 'pdf') return extractPdfReferences(request.data);
  // parseFromString gives an inert document: scripts do not run and nothing loads. It is only
  // read, never inserted into a page.
  const doc = new DOMParser().parseFromString(request.html, 'text/html');
  const refs = extractArxivReferences(doc);
  return { refs, confidence: refs.length > 0 ? 1 : 0 };
}
