# Store listing: RefSure

Text for the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons (AMO). The owner submits it; nothing here has been published.

## Chrome Web Store: step by step

Checked against the Chrome Web Store documentation and blog on 10 November 2026, including the policy update of
1 July 2026 (enforced from 1 August 2026) and the review update of 20 August 2026. The dashboard is at
https://chrome.google.com/webstore/devconsole.

1. **Before you start**
   - Push the code first, so `PRIVACY.md` has a public address to give as the privacy policy URL.
   - Turn on 2-step verification for the Google account you will publish with. The store requires it.
   - Choose that account with care: its email cannot be changed later.
   - Registration is open only in the countries and regions the store lists.
2. **Register.** Open the dashboard and accept the developer agreement and policies. Pay the one-time registration
   fee; the dashboard shows the amount (US$5 at the time of writing).
3. **Account page.**
   - Set the publisher name; it is shown as "Offered by".
   - Add a contact email and verify it with the link the store sends.
   - No physical address is needed for a free extension.
4. **Upload.** Build the zips from a clean checkout: `npm run zip` packs untracked files under `src/` and `public/`
   too, so either `git status --porcelain --ignored src public` prints nothing, or build in a fresh worktree of
   `release/v1` (`git worktree add ../refsure-release release/v1`, then `npm ci && npm run verify && npm run zip`
   there). Choose "Add new item" and upload `.output/refsure-0.1.0-chrome.zip`. The name, version and short
   description come from the manifest and cannot be edited in the dashboard; a fix means a new version and zip.
   The store runs automatic install checks on every uploaded draft; if one fails, fix it and upload again before
   submitting.
5. **Store listing tab.**
   - Paste the long description below and choose the category (Productivity).
   - Upload the 128x128 store icon (`public/icons/128.png`) and 1 to 5 screenshots at 1280x800. The icon and one
     screenshot are the only required images.
   - A 440x280 small promo tile is optional, but listings without one are shown after those that have one.
   - Optional: the homepage or support URL (the GitHub repository).
6. **Privacy tab.**
   - Paste the single purpose and one justification per permission and per host from the tables below.
   - Remote code: "No, I am not using remote code."
   - Data usage: tick Website content only, then tick the three certification boxes (no sale of data, no use outside
     the single purpose, no use for credit or lending).
   - Privacy policy: the public link to `PRIVACY.md`.
   - Everything here must match `PRIVACY.md` and what the extension does, or the extension can be removed.
   - The store also wants the data handling shown inside the extension, not only in the listing or the policy.
     RefSure does this: the panel states what is sent and to which databases next to the "Check references" button,
     nothing is sent before that click, and the welcome page repeats it.
7. **Distribution tab.** Free, all regions. Visibility: Public; Unlisted (anyone with the link can install); or
   Private (only the trusted testers set on the Account page). The review is the same for all three.
8. **Test instructions tab.** Leave it empty: no login or paid account is needed to test RefSure.
9. **Submit for review.**
   - Review usually takes a few days and can take a few weeks. New developers and new extensions take longer. Contact
     support if it is still pending after three weeks.
   - To choose the release moment, untick "publish automatically after review". You then have 30 days to publish
     before the submission goes back to draft.
   - A new publisher can have two published extensions; more can be requested in the dashboard.

## Name

RefSure

Before submitting, check that no extension in the store already uses the name.

## Short description (Chrome limit: 132 characters)

Chrome shows the manifest's `description` as the short description; it cannot be typed in the dashboard. It is set in
`wxt.config.ts`:

```
Checks the references on public arXiv and OpenReview papers against public databases. The developer receives nothing.
```

That is 117 characters. `package.json` carries the same text. To change it, change both and build a new version. Do not add "nothing is collected" to it (see "Privacy practices" below).

## Long description

```
RefSure checks the references of a paper against public scholarly databases and tells you which ones deserve a second look.

Open a paper on arXiv, or a public paper on OpenReview, and click the RefSure button in the toolbar. A side panel opens and the check starts. Results appear one by one, with the references that need a look listed first.

Each reference gets one of six results, each with a reason you can read:
- Verified: found, and the title, authors and year match.
- Details differ: found a close match, but something differs, such as the year or the authors.
- Wrong ID: the paper's DOI or arXiv ID (its permanent identifier) exists, but it belongs to a different paper than the title says.
- Retracted: the matched paper has been formally retracted.
- Not found: no close match in Crossref, arXiv, OpenReview or OpenAlex. Some real works (reports, theses, some proceedings) are not in these databases, so look it up by hand.
- Can't check: not something RefSure can look up (a website or a book, say), or a lookup did not work.

What you can do:
- Filter the list by result and open any row to see the cited details next to the details found.
- Follow a link to the matched paper or to the retraction notice.
- Copy a plain-text report, or export CSV or JSON.
- See small badges after each reference on arXiv HTML pages.
- Reopen a paper you checked before and see its last results at once. History is optional and can be cleared.

Where it looks: Crossref, arXiv, the public OpenReview search, OpenAlex and, when it answers, DBLP. You can add your own free OpenAlex key in the settings to raise OpenAlex's daily search budget.

Good to know:
- It takes time. The databases allow only a few requests per second (arXiv one every three seconds), so a paper with 40 references usually takes one to two minutes. Results stream in as they arrive.
- Not found means "not in these databases". Reports, theses, company papers, books, some workshop proceedings and some older journals are often not indexed, so a real reference can come out as Not found. Look it up by hand before drawing a conclusion.
- References read from a PDF can be misread. Those checks are labelled Beta.
- Confidential OpenReview submissions are never checked. If a page is not clearly public, nothing is sent.
- RefSure does not run in private windows.
- No result is a guess: each comes from a database lookup or a stated rule, with a reason you can read.

Privacy: when you run a check, the reference details of that paper (titles, authors, years, DOIs, arXiv IDs) are sent to the databases above. The developer receives nothing: no analytics, no ads, no account. Settings, history and cache stay on your device. Automatic checking is off by default.
```

## Category suggestion

- Chrome Web Store: Productivity (alternative: Education).
- Edge Add-ons: Productivity.
- Firefox Add-ons: Search Tools or Other (Firefox has no category for scholarly tools; choose the closest at submission).

## Single purpose

RefSure checks the references of the arXiv or public OpenReview paper the user is reading against public scholarly databases and shows the result for each reference.

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Keeps the user's settings, the optional history of past checks and a short-lived cache of lookup answers, on the device only. Nothing uses sync storage. |
| `activeTab` | Lets the toolbar click act on the tab the user is looking at. |
| `sidePanel` (Chrome, Edge) | Shows the results in the browser's side panel. |
| `sidebar_action` (Firefox) | Shows the results in the browser's sidebar. Firefox has no `sidePanel`. |
| `offscreen` (Chrome, Edge only) | Reads the downloaded HTML or PDF of the paper in an offscreen document, because the extension's service worker has no DOM. Firefox does not need it. |

Host access (the network allowlist). Each one is requested as `https://<host>/*`, and the extension's content security policy limits requests to the same list:

| Host | Justification |
|---|---|
| `arxiv.org` | Reads the HTML version or the PDF of the arXiv paper being checked, and shows badges on its HTML page. |
| `export.arxiv.org` | arXiv's lookup API: looks up arXiv IDs and searches titles. |
| `openreview.net` | Reads the title and visibility of the public OpenReview paper page being checked, so it checks only papers shown as public. |
| `api2.openreview.net` | OpenReview's public search, to find cited papers by title. No login and no cookies are used. |
| `api.crossref.org` | Looks up DOIs, searches titles and journal citations, and finds retraction notices. Receives the project's contact address as `mailto`, as Crossref asks. |
| `api.openalex.org` | Looks up DOIs, searches titles and reads retraction flags. Receives the user's own OpenAlex key only if the user entered one. |
| `dblp.org` | Searches computer-science titles. Optional and best-effort. |

Content scripts run only on `https://arxiv.org/html/*` and `https://openreview.net/forum*`. They read the page and send nothing on their own.

Not requested: `tabs`, `cookies`, `history`, `downloads`, `scripting`, `webRequest`, all-sites access. Exports are saved through a normal download link.

## Privacy practices (store disclosure answers)

Text for the privacy field, from `SECURITY.md` section 9:

> Does not collect or transmit personal data; sends reference text to public scholarly databases when you run a check.

Use it together with the statement below, not instead of it. Reference text is website content that leaves the browser. The Firefox build already declares this (`data_collection_permissions: { required: ["websiteContent"] }`), and the Chrome and Edge answers must say the same.

- **Does the extension collect or transmit user data?** It transmits website content: reference text from the paper being checked (titles, authors, years, DOIs, arXiv IDs) goes to Crossref, arXiv, OpenReview, OpenAlex and DBLP, only when the user runs a check or has turned on automatic checking. The developer receives nothing.
- **Data types to tick (Chrome):** Website content. Do not tick personally identifiable information, health, financial, authentication, personal communications, location, web history or user activity.
- **Is data sold to third parties?** No.
- **Is data used or transferred for purposes unrelated to the single purpose?** No.
- **Is data used or transferred to determine creditworthiness or for lending?** No.
- **Analytics, ads, telemetry or crash reporting?** None.
- **Remote code?** None. All code ships in the package.
- **Firefox data collection prompt:** the build declares `websiteContent` as required. Firefox shows it to the user at install.
- **Privacy policy URL:** a public link to `PRIVACY.md`. The owner must host it.
- **Do not say** "we collect nothing", "no data leaves your browser" or "nothing is collected". Say that the developer receives nothing, and say what goes to the databases.

## Screenshots

Chrome takes up to 5 screenshots at 1280x800 (or 640x400). Suggested set:

1. Side panel with results, light mode, problems listed first.
2. A "Details differ" row expanded, cited and found side by side.
3. Inline badges on an arXiv HTML page.
4. Dark mode panel.
5. The settings page (automatic checking off, history, optional key).

Files that exist in `docs/screenshots`, all made by `tests/e2e/screenshots.spec.ts`:

- Store views at 1280x800, ready to upload: `store-light-1280.png`, `store-details-light-1280.png`,
  `store-dark-1280.png`.
- Results: `panel-light-360.png`, `panel-light-480.png`, `panel-dark-360.png`, `panel-dark-480.png`, `panel-details-light-360.png`, `page-badges-light.png`, `page-badges-dark.png`.
- Settings: `settings-light-1280.png` and `settings-dark-1280.png`, at 1280x800. They show the default switches, Advanced open and an empty OpenAlex key field, and no reference data, so they can serve as screenshot 5 as they are.

The result screenshots show an invented paper whose references were made up so that every status appears. They are not findings about any real paper or author. The store takes 1280x800 or 640x400 only, so a screenshot of another size has to be taken again at 1280x800 before upload.

## Other fields

- **Support contact:** yshashank7575@gmail.com (`CONTACT_EMAIL` in `src/config.ts`).
- **Firefox for Android:** not supported, because Android Firefox has no sidebar. Leave Android unticked on AMO. The manifest still sets `gecko_android.strict_min_version` to 142.0, so web-ext lint has no Android warning.
- **Firefox add-on id:** `{d5793b66-7905-49f1-93d5-48f456578f2d}` (`GECKO_ID` in `wxt.config.ts`). It must never change after the first upload.
- **Firefox source code for review:** AMO asks for the sources of a bundled build. `npm run zip` makes the three store packages and `refsure-<version>-sources.zip` in `.output/`. The sources zip holds only what builds the extension (`src/`, `public/`, the pdf.js build step, package and config files, README, PRIVACY, SECURITY, LICENSE); README.md says how to rebuild from it. Make the zips from a clean checkout after `npm ci && npm run verify && npm run build`.
- **Release checklist:** `SECURITY.md` section 9.
