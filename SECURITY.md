# RefSure security policy

Every change to RefSure follows these rules. A change that needs to break
one is discussed first, not merged. "MUST" marks a rule whose violation
blocks a release.

## 1. What we protect

| Asset | Why it matters |
|---|---|
| The user's browsing (which papers they read) | Private; must not reach anyone except the lookup services, and only after consent |
| Confidential OpenReview submissions | Reviewers are bound by confidentiality; we never check them |
| The user's optional OpenAlex API key | A credential; theft lets others spend the user's quota |
| The integrity of results | A wrong "Retracted"/"Not found" badge can damage a real author's reputation |
| The arXiv / OpenReview pages themselves | We must never break or alter them beyond adding our badges |
| The extension's update channel and build | A compromised build reaches every user |

## 2. Threat model

| Threat | Example | Required defence |
|---|---|---|
| Malicious page content | A reference string containing `<img onerror=…>` or a crafted title | Treat as text only (section 4) |
| Malicious / spoofed API response | Compromised or MITM'd API returns HTML, huge payloads, wrong types | HTTPS only, schema validation, size and time limits (section 3) |
| Web page talking to the extension | A site sends `postMessage` or tries `runtime.sendMessage` | Validate sender on every message (section 5) |
| Instructions hidden in data | A reference saying "ignore previous instructions…" | Text like any other: nothing in RefSure interprets it. Anyone working on the code treats such text in fixtures as data too |
| Supply-chain attack | A dependency update ships malware | Minimal, pinned, audited deps; lockfile (section 6) |
| Permission creep | A feature quietly adds `<all_urls>` or `tabs` | Manifest test pins exact permissions (section 3) |
| Privacy leak | Sending the page URL, cookies or user identity to an API | `credentials: 'omit'`, no referrer, only citation data leaves (section 7) |
| Accusation error | A real paper marked "Not found" because an API was down | "Not found" only after all required sources succeed (DESIGN section 7.2) |
| Extension sale / hijack later | A future owner adds tracking | Out of scope for code; covered by the release checklist (section 9) |

## 3. Permissions and network

The manifest MUST request exactly these and nothing else (a unit test
asserts this list):

| Permission | Why |
|---|---|
| `storage` | Settings, cache, history (local only) |
| `activeTab` | Act on the tab the user clicked on |
| `sidePanel` (Chrome/Edge) / `sidebar_action` (Firefox) | Results panel |
| `offscreen` (Chrome/Edge only) | Parse fetched HTML/PDF where the service worker has no DOM |

Host permissions (seven patterns, `ALLOWED_HOST_PATTERNS` in `src/config.ts`):

```
https://arxiv.org/*
https://export.arxiv.org/*
https://openreview.net/*
https://api2.openreview.net/*
https://api.crossref.org/*
https://api.openalex.org/*
https://dblp.org/*
```

The **network allowlist** is narrower: the same list **without `https://openreview.net`**, so six
origins (`ALLOWED_ORIGINS`). Code MUST NOT contact any origin outside it. `openreview.net/*` is a host
permission only because the browser hides a tab's address from an extension without one (the panel and
the background read the OpenReview forum tab's address) and the content script runs on that page. Nothing
is ever fetched from `openreview.net`: OpenReview's search is `api2.openreview.net`, and the forum page is
read in place by the content script. A fetch to `openreview.net` is therefore refused by `http.ts` and by
the CSP, not allowed.

Forbidden: `<all_urls>`, `*://*/*`, `tabs`, `cookies`, `webRequest`,
`scripting` with broad hosts, `history`, `downloads` (exports use an
`<a download>` blob link), `identity`, `nativeMessaging`, `clipboardRead`.

Network rules (enforced in `src/sources/http.ts`):
- MUST reject any URL whose origin is not in `ALLOWED_ORIGINS` (`src/config.ts`; the six network origins above), and any non-`https:` URL.
- Redirects are enforced twice. In a browser, the extension CSP `connect-src` (section 6) blocks a redirect to
  an origin outside the allowlist before any request is sent; `http.ts` sees an opaque `TypeError`, treats it as
  a `network` failure, and retries only the original allowlisted URL (at most 3 times). The second layer is for
  environments without that CSP: `http.ts` re-checks the final URL of every response, never retries a request
  that was redirected out of the allowlist, and does not trust a response that reports no URL.
- MUST send `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`. We never send cookies, including OpenReview login cookies.
- MUST use a timeout (default 15 s; PDFs 30 s) via `AbortController`.
- MUST cap response size: JSON/XML 5 MB, HTML 10 MB, PDF 30 MB. Abort beyond.
- MUST check `Content-Type` (the part before `;`): a JSON request accepts only JSON types and an XML request only
  XML types, `+json` and `+xml` suffix types included; an HTML page (`text/html`) is refused for both. A non-JSON
  answer from a JSON API (for example a bot-challenge page) is a `SourceError('unavailable')`, never parsed.
- MUST honour `Retry-After` and `x-rate-limit-*` headers; never retry more than 3 times; exponential backoff.
  A `Retry-After` longer than a request waits (30 s) blocks that source until the stated time, at most one hour, in
  memory only (a restarted service worker forgets it). A later, shorter `Retry-After` never shortens a block. A
  blocked request fails at once, unsent. OpenAlex's id lookups and searches share a block, since they reach the same
  host; the one exception is a 429 on a search, OpenAlex's metered daily search budget, which pauses only the searches
  and leaves the free id lookups alone. Nothing clears a block by hand and no probe request is sent: Try again and
  Re-check during it send nothing to that source (for that exception, no search), and the panel names the source and
  the local time the wait ends instead. The one reset, `resetNetworkStateForTests` in `http.ts`,
  does nothing outside a unit-test run, and no extension code calls it (a unit test checks that no other source file names it).
- `http.ts` refuses any request to a non-OpenAlex origin whose URL contains the OpenAlex key (the stored value
  or an `api_key` parameter).
- The OpenAlex key, if set, is sent only to `api.openalex.org`, as a query parameter required by that API, and is never logged, exported or shown in full in the UI (show last 4 characters).

## 4. Rendering untrusted data

All of these are untrusted: page DOM, PDF text, every API response field,
values read back from storage.

- MUST render with `textContent`, `createElement`, `setAttribute` for
  safe attributes only. MUST NOT use `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `eval`, `new Function`,
  `setTimeout(string)`.
- Links built from data MUST be constructed from validated identifiers
  (DOI matching `^10\.\d{4,9}/\S+$`, arXiv IDs matching the arXiv ID
  pattern, OpenAlex work ids `^W\d{1,15}$`, DBLP record keys of the
  documented `kind/segment/segment` shape) to fixed bases (`https://doi.org/`,
  `https://arxiv.org/abs/`, `https://openreview.net/forum?id=`, and, only for
  a match that has no DOI, arXiv or OpenReview link, `https://openalex.org/works/`
  and `https://dblp.org/rec/`), and open with
  `rel="noopener noreferrer"` and `target="_blank"`. Never use a URL taken
  directly from an API response or page. A link is opened by the reader's
  click, never fetched by the extension, so a link host is not a host
  permission or a network origin (section 3): `openalex.org` is neither.
- Inline badges live inside a **closed Shadow DOM** host element appended to
  each reference. The content script MUST NOT modify any other part of the
  page, read form fields, or read anything outside the bibliography and
  page title.
- CSV export MUST neutralise formula injection: prefix cells that start
  with `=`, `+`, `-`, `@`, tab or CR with `'`, and quote every cell (a spreadsheet whose list
  separator is `;` would otherwise split an unquoted cell and start a formula in its second half).
- ESLint rules `no-eval`, `no-implied-eval`, `no-new-func` and a ban on
  `innerHTML`/`outerHTML`/`insertAdjacentHTML` (via `no-restricted-properties`) MUST be on and set to error.

## 5. Messaging between parts of the extension

- Every `runtime.onMessage` / port handler MUST check `sender.id === browser.runtime.id`.
- Messages from content scripts MUST come from a tab whose URL matches
  `https://arxiv.org/*` or `https://openreview.net/*`.
- The content scripts MUST set `noScriptStartedPostMessage: true`, so WXT does not post the extension id to
  the page's own scripts at start-up, and the arXiv script MUST ignore `pagehide` and `pageshow` events that
  are not `isTrusted` (a page script can dispatch them).
- Every message MUST be validated against its type (discriminated union in
  `src/messaging.ts`) before use; unknown types are dropped silently.
- Panel commands (`check:start`, `check:cancel`, `history:get`, `history:clear`, `badge:take`) and the panel port are
  accepted only from the side panel page (`sidepanel.html`), not from other extension pages such as
  `offscreen.html`.
- A `badge:clicked` from the arXiv HTML content script (top frame, on the paper its tab shows) may open the side
  panel for that tab (Chrome/Edge `sidePanel.open`, which the browser allows only while it handles a user's click),
  and only when that tab's run drew the badges on that paper. The badge sends it only for a trusted click
  (`event.isTrusted`); its shadow root is closed, so page scripts cannot reach the button. It carries only a reference
  number; it starts no check and sends nothing to any service. The click goes live to the panels that are open, and is
  held for the side panel of that tab, which may take it once (`badge:take`, side panel page only, within 10 s); it is
  never pushed to a panel that connects later, nor handed to another tab's panel.
  Firefox's sidebar is never opened this way.
  Residual risk, accepted: the page's own CSS can stretch a badge invisibly over the page and so steer the reader's
  next real click onto it. The effect is only that the panel opens and shows a row.
- Content scripts MUST NOT listen to `window.postMessage`.
- No `externally_connectable` in the manifest.

## 6. Dependencies and build

- Runtime dependencies allowed: `pdfjs-dist` only. Everything else is a dev
  dependency listed in `package.json`. Adding any dependency needs the
  maintainer's approval and a note in the commit message saying why.
- Versions pinned exactly (no `^`/`~`); `package-lock.json` committed;
  installs use `npm ci` in verification.
- `npm audit --omit=dev --audit-level=moderate` MUST pass in `npm run verify`
  (dev-only advisories are reviewed case by case). `overrides` in `package.json` pins minimatch at 11.0.5 for
  ESLint and typescript-eslint, which fixes GHSA-g3hv-75wg-m249; remove the override once both depend on a fixed
  version themselves.
- No remotely hosted code: every script, font, image and the pdf.js worker
  ship inside the package. No CDN URLs anywhere.
- Extension CSP (manifest `content_security_policy.extension_pages`), the same on
  Chrome, Edge and Firefox:
  `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self' https://arxiv.org https://export.arxiv.org https://api2.openreview.net https://api.crossref.org https://api.openalex.org https://dblp.org`.
  `default-src 'self'` means an image, style, font, media file or frame in an extension page can load only
  from the package, so an injected element could not send data out through one. The `connect-src` origins
  are generated from `ALLOWED_ORIGINS` in `src/config.ts` (via `wxt.config.ts`) and pinned by the manifest test.
- pdf.js is shipped text-only: `scripts/pdfjsBuild.ts` removes its Node code path and renames its own
  `fetch`/`XMLHttpRequest` code at build time. This is defence in depth. The real controls are the CSP
  `connect-src` allowlist above and that pdf.js is only ever given bytes, never an address. The rewrite
  is pinned to the exact pdfjs-dist version and file hashes it was reviewed against, and the build fails
  if the version changes, a rewrite finds nothing, or any `fetch`/`XMLHttpRequest` identifier is left;
  upgrading pdf.js therefore needs a fresh review of that script.
- No source maps in production builds.

## 7. Privacy

What leaves the user's device: only this, only to the allowlisted APIs,
and only after the user clicks Check (or turned on auto-check):
- citation data of the paper being checked: DOIs, arXiv IDs, titles, author
  names and years, and for a citation without a title, its journal, volume
  and page;
- the paper's own arXiv ID, to fetch its HTML or PDF from arXiv;
- for a public OpenReview paper, its title, sent to arXiv to find its arXiv
  version. No OpenReview forum ID is sent;
- the project contact email `CONTACT_EMAIL` (Crossref `mailto`), never a
  user's;
- the user's own OpenAlex key, if set, to OpenAlex only.

Never: user identity, cookies, other tabs, browsing history, analytics,
crash reporting, error reporting to any server. Logs stay in the console
and never contain the OpenAlex key.

Private windows: the manifest sets `"incognito": "not_allowed"` on Chrome, Edge and Firefox, so RefSure
does not run in private windows (pinned by the manifest test).

Local storage: settings, a result cache and check history in
`browser.storage.local`. "Clear history" MUST delete history and cache.
History can be turned off. Nothing uses `storage.sync`. On Chrome and Edge
the storage access level is set to trusted contexts, so content scripts
cannot read extension storage.

Confidential OpenReview submissions: the content script reads the
paper's visibility from the forum page itself, never through the user's
login. If the page does not show the paper as readable by everyone,
RefSure stops and shows the confidentiality message. It MUST NOT fall back
to a logged-in page or to an API call with cookies.
The page's own readers label says "public" only when it is shown to be
this paper's: on the newer layout, one of the note's own links (its pdf,
Revisions or BibTeX link, never the Versions menu) names the forum id in
the address and none names another. Nothing inside author-written content
(fields, replies, rendered markdown, typeset math) is ever read as the
label. Without that evidence the visibility is unclear and nothing is
sent.

## 8. Security review checkpoints

Before each release, a security review goes through this checklist:

- [ ] Manifest permissions and host list exactly match section 3 (test passes and was not edited to fit).
- [ ] No forbidden DOM sinks or dynamic code (grep + ESLint clean).
- [ ] Every fetch goes through `http.ts`; no direct `fetch(` elsewhere.
- [ ] All API parsers validate shape and treat missing/odd fields safely.
- [ ] Message handlers check sender and validate type.
- [ ] Links built only from validated IDs to fixed bases.
- [ ] CSV injection neutralised; exports contain no key or personal data.
- [ ] Confidential OpenReview path verified to stop.
- [ ] Error states never produce "Not found" or "Retracted".
- [ ] No new dependencies without approval; lockfile present; audit clean.
- [ ] No remote code, CDN URLs, analytics or telemetry.
- [ ] Production build has no source maps and no debug logging of data.

Findings are rated Critical / High / Medium / Low. Critical and High block
the release until they are fixed and checked again.

## 9. Release checklist (owner)

- Store privacy disclosure: "Does not collect or transmit personal data;
  sends reference text to public scholarly databases when you run a check."
- `CONTACT_EMAIL` is the project address (yshashank7575@gmail.com).
- Store accounts use 2-factor authentication; never share or sell the
  extension listing without telling users.
- Build from a clean checkout with `npm ci && npm run verify && npm run build`.

## 10. Reporting a vulnerability

Email the project contact address (yshashank7575@gmail.com) with
details. Do not open public issues for security problems.
