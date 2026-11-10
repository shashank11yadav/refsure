// The offscreen document: a hidden extension page with a DOM and Workers, where the
// Chrome/Edge service worker has the paper's HTML or PDF read. It answers only the
// extension's own background, and only for a request that passes the shape checks.

import { browser } from 'wxt/browser';
import { failure, isFromOwnBackground, base64ToBytes, readWireRequest, type WireResponse } from '../../extract/offscreenProtocol';
import { extensionUrl } from '../../extract/extensionUrl';
import { parseHere } from '../../extract/parseHere';

async function answer(message: unknown): Promise<WireResponse | undefined> {
  const request = readWireRequest(message);
  if (!request) return undefined;
  try {
    if (request.kind === 'arxiv-html-text') return { ok: true, ...(await parseHere({ kind: 'arxiv-html-text', html: request.html })) };
    const bytes = base64ToBytes(request.dataBase64);
    if (!bytes) return { ok: false, error: 'The PDF data was damaged in transit' };
    return { ok: true, ...(await parseHere({ kind: 'pdf', data: bytes.buffer })) };
  } catch (error) {
    return failure(error);
  }
}

browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isFromOwnBackground(sender, browser.runtime.id, extensionUrl('/'))) return false;
  // Answering only well-formed requests: anything else gets no reply, as if nobody listened.
  if (!readWireRequest(message)) return false;
  void answer(message).then(sendResponse);
  return true;
});
