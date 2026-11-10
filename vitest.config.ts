import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run in Node, where pdf.js must be its legacy build (the normal build warns and
// lacks Node fixes). Production code imports 'pdfjs-dist' and its worker URL; here they become the
// legacy build, and the worker's URL a path that Node's fake-worker loader can import.
const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url$/, replacement: path('./tests/unit/helpers/pdfWorkerUrl.ts') },
      { find: /^pdfjs-dist$/, replacement: path('./node_modules/pdfjs-dist/legacy/build/pdf.mjs') },
    ],
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // Builds the extension once for the tests that inspect it (see the file).
    globalSetup: ['tests/globalSetup.ts'],
    environment: 'node',
  },
});
