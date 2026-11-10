// Build step that makes pdf.js text-only. RefSure gives pdf.js bytes it already holds and
// reads text from them; it never needs pdf.js to fetch anything, draw, or run in Node. So the
// parts of pdf.js that do those things are removed from what ships, and the built-bundle
// network check in tests/unit/manifest.test.ts can stay strict:
//
//  - Node code path: `isNodeJS` becomes the constant false, so the Node-only canvas, file and
//    stream code (and its `@napi-rs/canvas` require) is dead and dropped by the minifier.
//  - Network code: pdf.js's own `fetch(...)` and XMLHttpRequest uses (loading a document by
//    URL, fonts, CMaps, wasm) are renamed to identifiers that do not exist, so reaching one
//    throws instead of making a request. XRef's `fetch` method is renamed along with them,
//    everywhere it is defined and called, so the document code keeps working.
//
// This is defence in depth, not the control. The real controls are the extension CSP's
// `connect-src` allowlist (SECURITY.md section 3) and that pdf.js is only ever given bytes
// (src/extract/pdfjsRuntime.ts), never an address. The rewrite is a text rewrite of someone
// else's code, so it is guarded three ways, each failing the build loudly:
//  1. `verifyPdfjsSources` accepts only the exact reviewed pdf.js version and the exact bytes
//     of the three files rewritten, so any upgrade forces a fresh review of this file.
//  2. Each rewrite checks that it found what it expected.
//  3. `assertNoNetworkIdentifiers` parses the result and fails if any `fetch` or
//     `XMLHttpRequest` identifier is left, so a partial rename cannot ship.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Plugin, parseAst } from 'vite';

export const EXPECTED_PDFJS_VERSION = '6.4.299';

// SHA-256 of the pdfjs-dist files rewritten below, as reviewed for EXPECTED_PDFJS_VERSION.
// build/pdf.mjs is bundled by Vite; build/pdf.worker.min.mjs is the worker file that ships, as an asset
// for the Chrome/Edge offscreen page and at a fixed path for Firefox (`emitWorkerAt`). build/pdf.worker.mjs
// is not shipped; its pin stays so that importing it would still be guarded.
const REVIEWED_SOURCES: Readonly<Record<string, string>> = {
  'build/pdf.mjs': 'dd13af821c9c3e1778653340d6539a1ba07bc56cba40073a4c727864cf0c232a',
  'build/pdf.worker.mjs': '07ceb740d746e5d9012fcf9f27d5c7dea09f7d2f5e74f5c8109e5787551a2333',
  'build/pdf.worker.min.mjs': '9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18',
};

/** Throws unless the installed pdf.js is exactly the reviewed one. `read` takes a path inside pdfjs-dist. */
export function verifyPdfjsSources(read: (relativePath: string) => Buffer): void {
  const version = (JSON.parse(read('package.json').toString('utf8')) as { version?: unknown }).version;
  if (version !== EXPECTED_PDFJS_VERSION) {
    throw new Error(`pdf.js build: pdfjs-dist is ${String(version)}, but scripts/pdfjsBuild.ts was reviewed for ${EXPECTED_PDFJS_VERSION}; check the rewrite again and update the pins`);
  }
  for (const [file, expected] of Object.entries(REVIEWED_SOURCES)) {
    let actual: string;
    try {
      actual = createHash('sha256').update(read(file)).digest('hex');
    } catch {
      throw new Error(`pdf.js build: cannot read pdfjs-dist/${file}`);
    }
    if (actual !== expected) throw new Error(`pdf.js build: pdfjs-dist/${file} differs from the reviewed file; check the rewrite again and update the pins`);
  }
}

function installedPdfjsReader(): (relativePath: string) => Buffer {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  return (relativePath) => readFileSync(join(root, relativePath));
}

const NODE_FLAG = /const isNodeJS = [^;\n]+;/g;
const FETCH_CALL = /(?<![\w$])fetch(?=\s*\()/g;
const XHR = /(?<![\w$])XMLHttpRequest(?![\w$])/g;
const FETCH_REPLACEMENT = 'fetchDisabledByRefSure';
const XHR_REPLACEMENT = 'XMLHttpRequestDisabledByRefSure';

export function stripPdfjsNodePath(code: string): string {
  const found = code.match(NODE_FLAG)?.length ?? 0;
  if (found !== 1) throw new Error(`pdf.js build: expected one "const isNodeJS" declaration, found ${found}`);
  return code.replace(NODE_FLAG, 'const isNodeJS = false;');
}

export function stripPdfjsNetwork(code: string): string {
  if (!FETCH_CALL.test(code)) throw new Error('pdf.js build: found no fetch() calls to rename; the pdf.js code has changed');
  FETCH_CALL.lastIndex = 0;
  return code.replace(FETCH_CALL, FETCH_REPLACEMENT).replace(XHR, XHR_REPLACEMENT);
}

const NETWORK_NAMES = new Set(['fetch', 'XMLHttpRequest']);

/**
 * Parses `code` and throws if any identifier (a name, a property, a destructured binding) is
 * `fetch` or `XMLHttpRequest`. Text inside strings, templates and comments is not an identifier,
 * so it is not counted. Walks with an explicit stack: the code is large and deeply nested.
 */
export function assertNoNetworkIdentifiers(code: string): void {
  const stack: unknown[] = [parseAst(code)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    } else if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      if (record['type'] === 'Identifier' && typeof record['name'] === 'string' && NETWORK_NAMES.has(record['name'])) {
        throw new Error(`pdf.js build: the identifier "${record['name']}" is still present after the rewrite`);
      }
      for (const value of Object.values(record)) if (typeof value === 'object' && value !== null) stack.push(value);
    }
  }
}

/** The whole rewrite for one pdf.js file: Node path (main module only), network code, then the check. */
export function rewritePdfjs(code: string, options: { nodePath: boolean }): string {
  const rewritten = stripPdfjsNetwork(options.nodePath ? stripPdfjsNodePath(code) : code);
  assertNoNetworkIdentifiers(rewritten);
  return rewritten;
}

// pdf.js's main module, and its main-thread worker module (not shipped, but still rewritten if bundled).
const PDFJS_MODULE = /node_modules[\\/]pdfjs-dist[\\/]build[\\/]pdf(?:\.worker)?\.mjs$/;
const WORKER_ASSET = /(?:^|\/)pdf\.worker(?:\.min)?-[\w-]+\.mjs$/;

let verified = false;

// The module that sets pdf.js up. A build that contains it is one that runs pdf.js, so it needs the worker file.
const PDFJS_RUNTIME = /[\\/]src[\\/]extract[\\/]pdfjsRuntime\.ts$/;

export interface PdfjsTextOnlyOptions {
  /**
   * Emit pdf.js's worker as a file at this fixed path (relative to the output root), in any build that
   * contains the pdf.js runtime module. Firefox needs it: its background script build inlines imported
   * assets, so the worker could not be a file by import. Chrome and Edge leave this unset and import
   * the worker as a hashed asset in the offscreen build.
   */
  emitWorkerAt?: string | undefined;
}

/** Vite plugin applying the rewrites to pdf.js's modules and to its worker file when that is emitted as an asset. */
export function pdfjsTextOnly(options: PdfjsTextOnlyOptions = {}): Plugin {
  // WXT builds each group of entry points on its own; each build says for itself whether it runs pdf.js.
  let usesRuntime = false;
  return {
    name: 'refsure-pdfjs-text-only',
    enforce: 'pre',
    buildStart() {
      usesRuntime = false;
      if (verified) return;
      verifyPdfjsSources(installedPdfjsReader());
      verified = true;
    },
    transform(code, id) {
      const path = id.split('?')[0] ?? '';
      if (PDFJS_RUNTIME.test(path)) usesRuntime = true;
      if (!PDFJS_MODULE.test(path)) return null;
      return { code: rewritePdfjs(code, { nodePath: true }), map: null };
    },
    generateBundle(_options, bundle) {
      let patched = 0;
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type !== 'asset' || !WORKER_ASSET.test(name)) continue;
        const source = typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source);
        file.source = rewritePdfjs(source, { nodePath: false });
        patched++;
      }
      // The worker is only emitted when something imports it; no import means nothing to patch.
      if (patched > 1) throw new Error('pdf.js build: more than one worker file was emitted');
      if (options.emitWorkerAt !== undefined && usesRuntime) {
        // Same file, same hash check (buildStart), same rewrite as the Chrome worker asset.
        const worker = installedPdfjsReader()('build/pdf.worker.min.mjs').toString('utf8');
        this.emitFile({ type: 'asset', fileName: options.emitWorkerAt, source: rewritePdfjs(worker, { nodePath: false }) });
      }
    },
  };
}
