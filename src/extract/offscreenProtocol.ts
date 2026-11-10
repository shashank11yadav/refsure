// The messages between the background and the offscreen document (Chrome, Edge), and the
// checks each side applies before using one (SECURITY.md section 5). Pure functions: the
// browser APIs are touched only in parseHost.ts and the offscreen entrypoint.
//
// Chrome sends extension messages as JSON, which cannot carry an ArrayBuffer, so PDF bytes
// travel as base64 text.

import { LIMITS } from '../config';
import { isRecord } from '../core/coerce';
import type { RawReference } from '../core/types';
import { ANCHOR_ID } from './domText';
import { PDF_READ_REASONS, PdfReadError, type PdfReadReason } from './readError';

export const OFFSCREEN_TARGET = 'refsure-offscreen';

/** The longest pdf.js may spend on one paper; the host waits a little longer than this for the reply. */
export const PARSE_TIMEOUT_MS = 60_000;

export type ParseRequest = { kind: 'arxiv-html-text'; html: string } | { kind: 'pdf'; data: ArrayBuffer };
export interface ParseResult {
  refs: RawReference[];
  confidence: number;
}

export type WireRequest =
  | { target: typeof OFFSCREEN_TARGET; type: 'parse'; kind: 'arxiv-html-text'; html: string }
  | { target: typeof OFFSCREEN_TARGET; type: 'parse'; kind: 'pdf'; dataBase64: string };

// `reason` travels only with a PdfReadError, whose message is written to be shown: JSON drops the error's class,
// and without it the background would show a generic message instead of "This PDF is password protected".
export type WireResponse = ({ ok: true } & ParseResult) | { ok: false; error: string; reason?: PdfReadReason };

const MAX_BASE64_CHARS = Math.ceil(LIMITS.maxPdfBytes / 3) * 4;
const MAX_ERROR_CHARS = 200;
const MAX_REFERENCES = 2000;
const MAX_TEXT_CHARS = 5000;
const MAX_LABEL_CHARS = 100;
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  return btoa(parts.join(''));
}

/** Undefined when the text is not valid base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

export function toWireRequest(request: ParseRequest): WireRequest {
  if (request.kind === 'pdf') {
    return { target: OFFSCREEN_TARGET, type: 'parse', kind: 'pdf', dataBase64: bytesToBase64(new Uint8Array(request.data)) };
  }
  return { target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html: request.html };
}

/** A request message with the right shape and sizes, or undefined. Unknown messages are dropped silently. */
export function readWireRequest(value: unknown): WireRequest | undefined {
  if (!isRecord(value) || value['target'] !== OFFSCREEN_TARGET || value['type'] !== 'parse') return undefined;
  if (value['kind'] === 'arxiv-html-text') {
    const html = value['html'];
    return typeof html === 'string' && html.length <= LIMITS.maxHtmlBytes
      ? { target: OFFSCREEN_TARGET, type: 'parse', kind: 'arxiv-html-text', html }
      : undefined;
  }
  if (value['kind'] === 'pdf') {
    const dataBase64 = value['dataBase64'];
    return typeof dataBase64 === 'string' && dataBase64.length <= MAX_BASE64_CHARS
      ? { target: OFFSCREEN_TARGET, type: 'parse', kind: 'pdf', dataBase64 }
      : undefined;
  }
  return undefined;
}

/**
 * Whether a message came from one of the extension's own pages or its background, not from
 * another extension, a web page or one of our content scripts (those carry a tab). The sender
 * must state an address inside the extension's own origin; no address is not good enough.
 */
export function isFromOwnBackground(sender: { id?: string | undefined; tab?: unknown; url?: string | undefined }, runtimeId: string, extensionBase: string): boolean {
  if (sender.id === undefined || sender.id !== runtimeId || sender.tab !== undefined) return false;
  return sender.url !== undefined && sender.url.startsWith(extensionBase);
}

function readReference(value: unknown, position: number): RawReference | undefined {
  if (!isRecord(value)) return undefined;
  const { index, label, text, blocks, anchorId, partial } = value;
  if (index !== position || typeof label !== 'string' || label.length > MAX_LABEL_CHARS) return undefined;
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) return undefined;
  const ref: RawReference = { index: position, label, text };
  if (blocks !== undefined) {
    if (!Array.isArray(blocks) || blocks.length > 100 || !blocks.every((b) => typeof b === 'string' && b.length <= MAX_TEXT_CHARS)) return undefined;
    ref.blocks = blocks as string[];
  }
  if (anchorId !== undefined) {
    if (typeof anchorId !== 'string' || !ANCHOR_ID.test(anchorId)) return undefined;
    ref.anchorId = anchorId;
  }
  if (partial !== undefined) {
    if (partial !== true) return undefined;
    ref.partial = true;
  }
  return ref;
}

/** A reply with the right shape, or undefined. */
export function readWireResponse(value: unknown): WireResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (value['ok'] === false) {
    const { error, reason } = value;
    if (typeof error !== 'string') return undefined;
    if (reason === undefined) return { ok: false, error: error.slice(0, MAX_ERROR_CHARS) };
    const known = PDF_READ_REASONS.find((r) => r === reason);
    return known === undefined ? undefined : { ok: false, error: error.slice(0, MAX_ERROR_CHARS), reason: known };
  }
  const { refs, confidence } = value;
  if (value['ok'] !== true || !Array.isArray(refs) || refs.length > MAX_REFERENCES) return undefined;
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return undefined;
  const read: RawReference[] = [];
  for (const [i, item] of refs.entries()) {
    const ref = readReference(item, i + 1);
    if (!ref) return undefined;
    read.push(ref);
  }
  return { ok: true, refs: read, confidence };
}

export function failure(error: unknown): WireResponse {
  const message = (error instanceof Error ? error.message : 'Could not read this paper').slice(0, MAX_ERROR_CHARS);
  return error instanceof PdfReadError ? { ok: false, error: message, reason: error.reason } : { ok: false, error: message };
}
