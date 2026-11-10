import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const DIR = new URL('../../fixtures/pages/', import.meta.url);

/** A saved page, byte for byte. */
export function pageText(name: string): string {
  return readFileSync(new URL(name, DIR), 'utf8');
}

/** A saved PDF as a standalone ArrayBuffer (what fetchBytes returns). */
export function pageBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(new URL(name, DIR));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Parses HTML into an inert document, the way the extension does (DOMParser:
 * no script runs, nothing is fetched). The extra settings keep the test DOM from
 * touching the network even if a fixture links to remote files.
 */
export function parseHtml(html: string): Document {
  const window = new Window({
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      enableImageFileLoading: false,
      navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
    },
  });
  return new window.DOMParser().parseFromString(html, 'text/html') as unknown as Document;
}

/** A page with just a bibliography holding the given `<li>` markup. */
export function bibliographyWith(items: string): Document {
  return parseHtml(`<!doctype html><html><body><section class="ltx_bibliography"><ul class="ltx_biblist">${items}</ul></section></body></html>`);
}
