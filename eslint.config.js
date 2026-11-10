import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Safety rails from SECURITY.md section 4. These are errors, not warnings:
// a failing lint blocks the commit. Do not add disable comments to get
// around them; fix the code instead.
//
// ESLint replaces (does not merge) a rule's options when a later config
// block sets the same rule, so each block below lists every ban it needs.
const DOM_SINK_BANS = [
  { property: 'innerHTML', message: 'Never build DOM from strings. Use textContent / createElement (SECURITY.md section 4).' },
  { property: 'outerHTML', message: 'Never build DOM from strings. Use textContent / createElement (SECURITY.md section 4).' },
  { property: 'insertAdjacentHTML', message: 'Never build DOM from strings. Use textContent / createElement (SECURITY.md section 4).' },
  { object: 'document', property: 'write', message: 'document.write is banned (SECURITY.md section 4).' },
  { object: 'document', property: 'writeln', message: 'document.writeln is banned (SECURITY.md section 4).' },
  { property: 'createContextualFragment', message: 'Never build DOM from strings (SECURITY.md section 4).' },
  { property: 'setHTMLUnsafe', message: 'Never build DOM from strings (SECURITY.md section 4).' },
  { property: 'parseHTMLUnsafe', message: 'Never build DOM from strings (SECURITY.md section 4).' },
  { object: 'window', property: 'eval', message: 'Dynamic code is banned (SECURITY.md section 4).' },
  { object: 'self', property: 'eval', message: 'Dynamic code is banned (SECURITY.md section 4).' },
  { object: 'globalThis', property: 'eval', message: 'Dynamic code is banned (SECURITY.md section 4).' },
];

const NETWORK_MESSAGE = 'All network access goes through src/sources/http.ts (SECURITY.md section 3).';

const DIRECT_NETWORK_PROPERTY_BANS = [
  { object: 'window', property: 'fetch', message: NETWORK_MESSAGE },
  { object: 'globalThis', property: 'fetch', message: NETWORK_MESSAGE },
  { object: 'self', property: 'fetch', message: NETWORK_MESSAGE },
  { object: 'navigator', property: 'sendBeacon', message: NETWORK_MESSAGE },
];

const DIRECT_NETWORK_GLOBAL_BANS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
  name,
  message: NETWORK_MESSAGE,
}));

// Every file type that can ship in the extension (or be bundled into it).
const SOURCE_FILES = ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];

export default tseslint.config(
  // eslint-disable comments are ignored (and reported), so a rail cannot be switched off in place.
  { linterOptions: { noInlineConfig: true } },
  { ignores: ['.*/**', '.output/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // no-implied-eval only sees setTimeout(string) when it knows these globals.
    languageOptions: {
      globals: { setTimeout: 'readonly', setInterval: 'readonly', setImmediate: 'readonly', execScript: 'readonly' },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-properties': ['error', ...DOM_SINK_BANS],
    },
  },
  {
    // Production code may not touch the network directly.
    files: SOURCE_FILES,
    rules: {
      'no-restricted-properties': ['error', ...DOM_SINK_BANS, ...DIRECT_NETWORK_PROPERTY_BANS],
      'no-restricted-globals': ['error', ...DIRECT_NETWORK_GLOBAL_BANS],
    },
  },
  {
    // The one place allowed to call fetch (allowlist, timeouts, size caps).
    files: ['src/sources/http.ts'],
    rules: {
      'no-restricted-properties': ['error', ...DOM_SINK_BANS],
      'no-restricted-globals': 'off',
    },
  },
);
