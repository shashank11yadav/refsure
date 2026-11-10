// Static check of emitted JS for network access outside src/sources/http.ts.
//
// Only http.ts writes the options block `credentials: 'omit', referrerPolicy:
// 'no-referrer'` next to its fetch() call, and that block survives minification
// (string values and property order are kept). So in any file, every fetch(
// call must be matched by one such block; a surplus fetch( is a stray call,
// such as the module-preload polyfill Vite adds by default.

const FETCH_CALL = /\bfetch\s*\(/g;
const GUARDED_OPTIONS = /credentials\s*:\s*["'`]omit["'`]\s*,\s*referrerPolicy\s*:\s*["'`]no-referrer["'`]/g;

const FORBIDDEN_APIS: readonly [string, RegExp][] = [
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\s*\(/],
  ['EventSource', /\bEventSource\s*\(/],
  ['sendBeacon', /\bsendBeacon\b/],
];

export function scanBundle(code: string): { fetchCalls: number; guardedSites: number } {
  return {
    fetchCalls: code.match(FETCH_CALL)?.length ?? 0,
    guardedSites: code.match(GUARDED_OPTIONS)?.length ?? 0,
  };
}

/** Human-readable problems found in one built file; empty when it is clean. */
export function networkViolations(code: string): string[] {
  const problems: string[] = [];
  const { fetchCalls, guardedSites } = scanBundle(code);
  if (fetchCalls > guardedSites) {
    problems.push(`${fetchCalls} fetch() call(s) but only ${guardedSites} from the guarded HTTP layer`);
  }
  for (const [name, pattern] of FORBIDDEN_APIS) {
    if (pattern.test(code)) problems.push(`${name} is used`);
  }
  return problems;
}
