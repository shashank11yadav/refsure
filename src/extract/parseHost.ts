// Where papers get parsed. HTML needs a DOM and PDFs need a DOM plus Workers, and the
// Chrome/Edge service worker has neither, so there the work is sent to an offscreen
// document; Firefox's background page has both and parses in place.

import { browser } from 'wxt/browser';
import { LIMITS } from '../config';
import { extensionUrl } from './extensionUrl';
import {
  PARSE_TIMEOUT_MS,
  type ParseRequest,
  type ParseResult,
  readWireResponse,
  toWireRequest,
} from './offscreenProtocol';
import { PdfReadError } from './readError';

const OFFSCREEN_PATH = 'offscreen.html';
const JUSTIFICATION = 'Parses the HTML or PDF of the paper the user is checking, to read its reference list. Needs a DOM parser and a worker for PDF text.';

// Wait a little longer than pdf.js itself may take, so its own timeout answers first when it can.
const REPLY_TIMEOUT_MS = PARSE_TIMEOUT_MS + 5000;
// A hidden page with pdf.js loaded is worth closing when nobody is using it.
const IDLE_CLOSE_MS = 60_000;
// Creating the page is quick; a call that hangs is as good as a failure.
const CREATE_TIMEOUT_MS = 10_000;

export interface OffscreenApi {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
}

export interface HostDeps {
  /** 'direct' parses in this page (Firefox); 'offscreen' messages the offscreen document. */
  mode: 'direct' | 'offscreen';
  parseDirect(request: ParseRequest): Promise<ParseResult>;
  offscreen?: OffscreenApi | undefined;
  /** Whether an offscreen document is already open. */
  hasOffscreenDocument?(): Promise<boolean>;
  sendMessage?(message: unknown): Promise<unknown>;
}

function assertWithinLimits(request: ParseRequest): void {
  const size = request.kind === 'pdf' ? request.data.byteLength : request.html.length;
  const limit = request.kind === 'pdf' ? LIMITS.maxPdfBytes : LIMITS.maxHtmlBytes;
  if (size > limit) throw new Error('This paper is too large to read');
}

export function createParseInHost(deps: HostDeps): (request: ParseRequest) => Promise<ParseResult> {
  let opening: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let inFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Each request in flight registers how to fail it, so one timeout fails them all alike.
  const flights = new Set<(error: Error) => void>();

  async function open(): Promise<void> {
    const offscreen = deps.offscreen;
    if (!offscreen) throw new Error('Offscreen documents are not available here');
    // A document that is still closing must finish closing first, or we would message a page that is going away.
    await closing;
    if (await deps.hasOffscreenDocument?.()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PdfReadError('The paper reader did not start', 'timeout')), CREATE_TIMEOUT_MS);
    });
    try {
      await Promise.race([offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: ['DOM_PARSER', 'WORKERS'], justification: JUSTIFICATION }), hung]);
    } catch (error) {
      // A concurrent caller (or an earlier run of the service worker) got there first.
      if (!(error instanceof Error && /single offscreen/i.test(error.message))) throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // One shared attempt, so simultaneous requests cannot each try to create the document.
  function ensureOffscreen(): Promise<void> {
    opening ??= open().finally(() => {
      opening = undefined;
    });
    return opening;
  }

  // Closing can fail (nothing open, or already closed): either way the next call recreates it as needed.
  function closeOffscreen(): Promise<void> {
    closing ??= (async () => {
      await deps.offscreen?.closeDocument().catch(() => undefined);
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  }

  function armIdleClose(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void closeOffscreen(), IDLE_CLOSE_MS);
  }

  // The page may be stuck: fail everything waiting on it with the same clear error, then close it so the next request starts fresh.
  function failAll(): void {
    const error = new PdfReadError('Reading this paper took too long', 'timeout');
    for (const fail of [...flights]) fail(error);
    void closeOffscreen();
  }

  async function askOffscreen(request: ParseRequest): Promise<ParseResult> {
    if (!deps.sendMessage) throw new Error('Messaging is not available here');
    await ensureOffscreen();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fail: (error: Error) => void = () => undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      fail = reject;
      timer = setTimeout(failAll, REPLY_TIMEOUT_MS);
    });
    flights.add(fail);
    try {
      const reply = readWireResponse(await Promise.race([deps.sendMessage(toWireRequest(request)), failed]));
      if (!reply) throw new Error('The paper reader sent an unexpected reply');
      if (!reply.ok) throw reply.reason === undefined ? new Error(reply.error) : new PdfReadError(reply.error, reply.reason);
      return { refs: reply.refs, confidence: reply.confidence };
    } finally {
      clearTimeout(timer);
      flights.delete(fail);
    }
  }

  // Firefox parses in this page, where a stuck worker would otherwise hang the check for ever.
  async function parseDirectly(request: ParseRequest): Promise<ParseResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PdfReadError('Reading this paper took too long', 'timeout')), REPLY_TIMEOUT_MS);
    });
    try {
      return await Promise.race([deps.parseDirect(request), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  return async (request) => {
    assertWithinLimits(request);
    if (deps.mode === 'direct') return parseDirectly(request);
    inFlight++;
    clearTimeout(idleTimer);
    try {
      return await askOffscreen(request);
    } finally {
      inFlight--;
      if (inFlight === 0) armIdleClose();
    }
  };
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [extensionUrl(`/${OFFSCREEN_PATH}`)],
  });
  return contexts.length > 0;
}

async function parseDirect(request: ParseRequest): Promise<ParseResult> {
  // Only Firefox builds keep this branch (and with it pdf.js); Chrome and Edge builds parse in the offscreen document.
  if (import.meta.env.FIREFOX) {
    const { parseHere } = await import('./parseHere');
    return parseHere(request);
  }
  throw new Error('Direct parsing is only available in Firefox builds');
}

let shared: ((request: ParseRequest) => Promise<ParseResult>) | undefined;

/**
 * Reads the references of an arXiv HTML page (given as text) or of a PDF (given as bytes).
 * Chrome and Edge: through an offscreen document. Firefox: in the background page itself.
 */
export function parseInHost(request: ParseRequest): Promise<ParseResult> {
  shared ??= createParseInHost({
    mode: import.meta.env.FIREFOX ? 'direct' : 'offscreen',
    parseDirect,
    offscreen: import.meta.env.FIREFOX ? undefined : (browser.offscreen as unknown as OffscreenApi),
    hasOffscreenDocument,
    sendMessage: (message) => browser.runtime.sendMessage(message),
  });
  return shared(request);
}
