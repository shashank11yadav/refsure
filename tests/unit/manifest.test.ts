import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, inject, test } from 'vitest';
import { ALLOWED_HOST_PATTERNS, ALLOWED_ORIGINS } from '../../src/config';
import { networkViolations } from './helpers/builtNetwork';

// Inspects the manifest of each browser target as WXT actually builds it. If this test needs editing to pass,
// the manifest has drifted from SECURITY.md section 3: fix the manifest.
type Manifest = {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  externally_connectable?: unknown;
  content_security_policy?: { extension_pages?: string };
  side_panel?: { default_path?: string };
  sidebar_action?: { default_panel?: string };
  background?: Record<string, unknown>;
  content_scripts?: { matches?: string[]; js?: string[]; all_frames?: boolean; run_at?: string }[];
  web_accessible_resources?: unknown;
  name?: string;
  incognito?: string;
  minimum_chrome_version?: string;
  action?: { default_title?: string; default_icon?: Record<string, string> };
  browser_specific_settings?: {
    gecko?: { id?: string; strict_min_version?: string; data_collection_permissions?: { required?: string[]; optional?: string[] } };
    gecko_android?: { strict_min_version?: string };
  };
};

// Spelled out on purpose (not derived from config) so a drift in either direction fails.
const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
  "connect-src 'self' https://arxiv.org https://export.arxiv.org " +
  'https://api2.openreview.net https://api.crossref.org https://api.openalex.org https://dblp.org';

const FORBIDDEN_PERMISSIONS = [
  'tabs',
  'cookies',
  'webRequest',
  'webRequestBlocking',
  'scripting',
  'history',
  'downloads',
  'identity',
  'nativeMessaging',
  'clipboardRead',
];

// The only two pages RefSure ever puts a script on, one content script each.
const CONTENT_SCRIPT_MATCHES = ['https://arxiv.org/html/*', 'https://openreview.net/forum*'];

const outRoot = inject('builtRoot');
const manifests: Record<'chrome' | 'edge' | 'firefox', Manifest> = {} as never;

// The build is made once for the whole run (tests/globalSetup.ts).
beforeAll(() => {
  for (const browser of ['chrome', 'edge', 'firefox'] as const) {
    const dirName = browser === 'firefox' ? 'firefox-mv3' : `${browser}-mv3`;
    manifests[browser] = JSON.parse(readFileSync(join(outRoot, browser, dirName, 'manifest.json'), 'utf8')) as Manifest;
  }
});

describe('chrome manifest', () => {
  test('permissions are exactly the allowed set', () => {
    const chrome = manifests.chrome;
    expect(new Set(chrome.permissions)).toEqual(new Set(['storage', 'activeTab', 'sidePanel', 'offscreen']));
    expect(new Set(chrome.host_permissions)).toEqual(new Set(ALLOWED_HOST_PATTERNS));
    expect(chrome.externally_connectable).toBeUndefined();
    expect(chrome.content_security_policy?.extension_pages).toBe(EXPECTED_CSP);
  });

  test('uses side_panel', () => {
    expect(manifests.chrome.side_panel?.default_path).toBeTruthy();
    expect(manifests.chrome.sidebar_action).toBeUndefined();
  });

  // The bundled pdf.js calls Uint8Array.prototype.toHex, which Chrome has from 140 (the side panel needs only 116).
  test('requires Chrome 140', () => {
    expect(manifests.chrome.minimum_chrome_version).toBe('140');
  });
});

describe('edge manifest', () => {
  test('matches the chrome permission set and CSP', () => {
    const edge = manifests.edge;
    expect(new Set(edge.permissions)).toEqual(new Set(['storage', 'activeTab', 'sidePanel', 'offscreen']));
    expect(new Set(edge.host_permissions)).toEqual(new Set(ALLOWED_HOST_PATTERNS));
    expect(edge.externally_connectable).toBeUndefined();
    expect(edge.content_security_policy?.extension_pages).toBe(EXPECTED_CSP);
  });

  test('requires the same Chromium floor as Chrome', () => {
    expect(manifests.edge.minimum_chrome_version).toBe('140');
  });
});

describe('firefox manifest', () => {
  test('has no offscreen and uses sidebar_action', () => {
    const firefox = manifests.firefox;
    expect(new Set(firefox.permissions)).toEqual(new Set(['storage', 'activeTab']));
    expect(new Set(firefox.host_permissions)).toEqual(new Set(ALLOWED_HOST_PATTERNS));
    expect(firefox.sidebar_action?.default_panel).toBeTruthy();
    expect(firefox.side_panel).toBeUndefined();
    expect(firefox.externally_connectable).toBeUndefined();
    expect(firefox.content_security_policy?.extension_pages).toBe(EXPECTED_CSP);
    expect(firefox.minimum_chrome_version).toBeUndefined();
  });

  test('declares an extension id and honest data collection (reference text goes to lookup services)', () => {
    const gecko = manifests.firefox.browser_specific_settings?.gecko;
    expect(gecko?.id).toBe('{d5793b66-7905-49f1-93d5-48f456578f2d}');
    expect(gecko?.data_collection_permissions).toEqual({ required: ['websiteContent'], optional: [] });
  });

  test('requires Firefox 140, the first release that knows data_collection_permissions on desktop', () => {
    expect(manifests.firefox.browser_specific_settings?.gecko?.strict_min_version).toBe('140.0');
  });

  // Firefox for Android has no sidebar, so RefSure is not offered there; this only keeps the
  // Android floor at the first release that knows data_collection_permissions (web-ext lint).
  test('sets the Android floor to Firefox 142, the first Android release that knows data_collection_permissions', () => {
    expect(manifests.firefox.browser_specific_settings?.gecko_android?.strict_min_version).toBe('142.0');
  });
});

describe('every browser', () => {
  // The store limits a description to 132 characters; the wording must not claim that nothing leaves the machine.
  test.each(['chrome', 'edge', 'firefox'] as const)('%s: the description fits the store limit and says what the developer receives', (browser) => {
    const description = (manifests[browser] as { description?: string }).description ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(132);
    expect(description).toContain('The developer receives nothing.');
    expect(description).toContain('public arXiv and OpenReview papers');
    expect(description).not.toMatch(/nothing is collected/i);
  });

  test.each(['chrome', 'edge', 'firefox'] as const)('%s: the extension is switched off in private windows', (browser) => {
    expect(manifests[browser].incognito).toBe('not_allowed');
  });

  // Host permissions keep openreview.net (tab addresses, the content script); only the network allowlist drops it.
  test.each(['chrome', 'edge', 'firefox'] as const)('%s: the CSP has a default-src and never lets the page connect to openreview.net itself', (browser) => {
    const csp = manifests[browser].content_security_policy?.extension_pages ?? '';
    expect(csp.startsWith("default-src 'self'; ")).toBe(true);
    expect(/connect-src ([^;]+)/.exec(csp)?.[1]?.split(' ')).not.toContain('https://openreview.net');
    expect(manifests[browser].host_permissions).toContain('https://openreview.net/*');
  });

  test.each(['chrome', 'edge', 'firefox'] as const)('%s: CSP connect-src lists exactly the allowed origins', (browser) => {
    const csp = manifests[browser].content_security_policy?.extension_pages ?? '';
    expect(csp).toBe(EXPECTED_CSP);
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1]?.split(' ') ?? [];
    expect(connect.filter((entry) => entry !== "'self'").sort()).toEqual([...ALLOWED_ORIGINS].sort());
  });

  test.each(['chrome', 'edge', 'firefox'] as const)('%s: no <all_urls> or forbidden permission anywhere', (browser) => {
    const manifest = manifests[browser];
    const requested = [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
      ...(manifest.host_permissions ?? []),
      ...(manifest.optional_host_permissions ?? []),
      ...(manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []),
    ];
    for (const entry of requested) {
      expect(entry, `${browser} requests ${entry}`).not.toBe('<all_urls>');
      expect(entry, `${browser} requests ${entry}`).not.toMatch(/^\*:\/\/\*\/\*$/);
      expect(FORBIDDEN_PERMISSIONS, `${browser} requests ${entry}`).not.toContain(entry);
    }
    expect(manifest.optional_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions ?? []).toEqual([]);
  });

  test.each(['chrome', 'edge', 'firefox'] as const)('%s: exactly two content scripts, on the arXiv HTML and OpenReview forum pages, top frame only', (browser) => {
    const scripts = manifests[browser].content_scripts ?? [];
    expect(scripts.map((script) => script.matches ?? [])).toHaveLength(2);
    expect(scripts.flatMap((script) => script.matches ?? []).sort()).toEqual([...CONTENT_SCRIPT_MATCHES].sort());
    // Each script has exactly one match pattern: no extra pages ride along.
    for (const script of scripts) expect(script.matches).toHaveLength(1);
    // Top frame only: a script never runs inside an embedded frame.
    for (const script of scripts) expect(script.all_frames ?? false).toBe(false);
    // document_idle is the browsers' default, so WXT may leave the key out.
    for (const script of scripts) expect(script.run_at ?? 'document_idle').toBe('document_idle');
  });

  // WXT's start-up message would hand the page the extension id; each script switches it off.
  test.each(['chrome', 'edge', 'firefox'] as const)('%s: both content scripts are built with the start-up postMessage switched off', (browser) => {
    const dirName = browser === 'firefox' ? 'firefox-mv3' : `${browser}-mv3`;
    for (const file of ['arxiv.js', 'openreview.js']) {
      const text = readFileSync(join(outRoot, browser, dirName, 'content-scripts', file), 'utf8');
      expect(text, `${file} keeps WXT's start-up postMessage on`).toMatch(/noScriptStartedPostMessage\s*:\s*(!0|true)/);
    }
  });

  test.each(['chrome', 'edge', 'firefox'] as const)('%s: production build ships no source maps', (browser) => {
    const dirName = browser === 'firefox' ? 'firefox-mv3' : `${browser}-mv3`;
    const files = readdirSync(join(outRoot, browser, dirName), { recursive: true, encoding: 'utf8' });
    expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
    // A leftover "//# sourceMappingURL" comment is a smell even without the .map file.
    for (const file of files.filter((f) => /\.(js|html|mjs|css)$/.test(f))) {
      const text = readFileSync(join(outRoot, browser, dirName, file), 'utf8');
      expect(text, `${file} references a source map`).not.toContain('sourceMappingURL');
    }
  });

  // The network may only be reached from src/sources/http.ts (SECURITY.md section 3).
  // Per built file, every fetch() must be matched by http.ts's own options block and
  // the other network APIs must not appear (see helpers/builtNetwork.ts; builtNetwork.test.ts
  // proves the rule catches a stray fetch bundled beside http.ts).
  test.each(['chrome', 'edge', 'firefox'] as const)('%s: built JS reaches the network only through the guarded HTTP layer', (browser) => {
    const dirName = browser === 'firefox' ? 'firefox-mv3' : `${browser}-mv3`;
    const files = readdirSync(join(outRoot, browser, dirName), { recursive: true, encoding: 'utf8' });
    const scripts = files.filter((f) => /\.(js|mjs|html)$/.test(f));
    expect(scripts.length).toBeGreaterThan(0);
    for (const file of scripts) {
      const text = readFileSync(join(outRoot, browser, dirName, file), 'utf8');
      expect(networkViolations(text), file).toEqual([]);
    }
  });

  test.each(['chrome', 'edge', 'firefox'] as const)('%s: has a toolbar action with title and icons', (browser) => {
    const action = manifests[browser].action;
    expect(action?.default_title).toBe('Check references with RefSure');
    expect(Object.keys(action?.default_icon ?? {}).sort()).toEqual(['128', '16', '32', '48']);
  });

  test.each(['chrome', 'edge', 'firefox'] as const)('%s: named RefSure', (browser) => {
    expect(manifests[browser].name).toBe('RefSure');
  });
});
