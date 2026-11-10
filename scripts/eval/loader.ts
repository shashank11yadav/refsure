// Module hooks for `npm run eval`: they let the extension's own source run in Node, unchanged.
//  * `import.meta.env` is Vite's, so it is replaced with the values of a Chrome build.
//  * pdf.js is its legacy build (the normal build does not run in Node), and the worker import that Vite
//    turns into a URL becomes the path of the legacy worker, like the unit tests (vitest.config.ts).
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = pathToFileURL(`${ROOT}src/`).href;
const LEGACY = pathToFileURL(`${ROOT}node_modules/pdfjs-dist/legacy/build/pdf.mjs`).href;
const WORKER_MODULE = pathToFileURL(`${ROOT}scripts/eval/pdfWorkerUrl.ts`).href;
const ENV = '({ FIREFOX: false, CHROME: true, EDGE: false, BROWSER: "chrome", MODE: "eval", DEV: false, PROD: true })';

/** Call once, before the extension's modules are imported. */
export function installEvalHooks(): void {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'pdfjs-dist') return { url: LEGACY, shortCircuit: true };
      if (specifier === 'pdfjs-dist/build/pdf.worker.min.mjs?url' || specifier === 'pdfjs-dist/build/pdf.worker.min.mjs') return { url: WORKER_MODULE, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      const loaded = next(url, context);
      if (!url.startsWith(SRC) || loaded.source === undefined || loaded.source === null) return loaded;
      const text = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
      return { ...loaded, source: text.replaceAll('import.meta.env', ENV) };
    },
  });
}
