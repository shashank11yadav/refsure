# RefSure

RefSure is a free browser extension for Chrome, Edge and Firefox. It checks the references of a paper against public scholarly databases and marks each one, so you can see which ones deserve a second look.

It works on:

- arXiv papers (the HTML version, the abstract page, or the PDF).
- Public papers on OpenReview. RefSure finds the paper's arXiv version and checks that. The panel says "Checked using the arXiv version".

It runs in Chrome and Edge 140 or later, and in Firefox 140 or later on the desktop.

No result is a guess: each comes from a database lookup or a stated rule, with a reason you can read.

## The six statuses

| Status | What it means |
|---|---|
| Verified | Found, and the title, authors and year match. |
| Details differ | Found a close match, but something differs, such as the year or the authors. Both versions are shown side by side. |
| Wrong ID | The paper's DOI or arXiv ID (its permanent identifier) exists, but it belongs to a different paper than the title says. |
| Retracted | The matched paper has been formally retracted. A link to the notice is shown. |
| Not found | No close match in Crossref, arXiv, OpenReview or OpenAlex. Some real works (reports, theses, some proceedings) are not in these databases, so look it up by hand. This means "not in these databases". It does not mean the reference is wrong. |
| Can't check | Not something RefSure can look up (a website or a book, say), or a lookup did not work. |

When a lookup source is unavailable or out of budget, the reference becomes Can't check. It never becomes Not found.

## How to use it

1. Open a paper on arXiv, or a public paper on OpenReview.
2. Click the RefSure button in the toolbar. The side panel opens (a sidebar in Firefox) and the check starts.
3. Results appear one by one. References that need a look are listed first, and a progress bar shows how far the check has come.

In the panel you can:

- Filter the list by status.
- Expand a row to see the reason, the cited details next to the found details, and a link to the matched paper.
- Copy a plain-text report.
- Export the results as CSV or JSON.
- Stop a check, or re-check a paper.
- Reopen a paper you have checked before and see its last results at once (history, which you can turn off and clear).

On arXiv HTML pages RefSure also puts a small badge after each reference. Hover for the reason. Click a badge to open that row in the panel. "Show on page" in the panel scrolls to the reference. Badges are drawn on HTML pages only. Abstract pages, PDFs and OpenReview pages show results in the panel only.

Automatic checking is available in the panel settings, separately for arXiv and OpenReview. It is off by default, so nothing is sent until you click.

## What it checks against

| Source | Used for |
|---|---|
| Crossref | DOIs, title search, journal citations without a title, retraction notices |
| arXiv | arXiv IDs, title search, and the paper's own HTML or PDF |
| OpenReview (public search) | Title search |
| OpenAlex | Title search (last, because it is metered), DOIs, retraction flags |
| DBLP | Title search. Optional and best-effort: its API often answers with a bot challenge, so a result never depends on it. |

OpenAlex gives each network address a small free daily budget of searches (about 100). If it runs out, the references that needed it become Can't check, and a later check can fill them in. The budget is shared by everyone on the same network address. You can raise it by adding your own free OpenAlex API key under Settings, Advanced. The key is stored only on your device and is sent only to OpenAlex.

## Limits

- It takes time. The databases allow only a few requests per second, and arXiv one every three seconds. A full 40-reference check usually takes one to two minutes. In the one timed run the quickest full check took about 30 seconds and the slowest about six minutes; RefSure now sends a few more requests, so a check takes a little longer than that. Results stream in as they arrive, and the first one usually shows within a few seconds.
- PDF-only papers are Beta. References read from a PDF can be misread, so the panel labels those checks Beta.
- Not every real reference is in these databases. Reports, theses, company technical papers, books, web pages, datasets, legislation, some workshop proceedings and some older journals are often not indexed. Such a reference comes out as Not found or Can't check. Not found means "not in these databases", not "made up". Look it up by hand before drawing a conclusion. A titled paper from before 1970 that nothing matched is Can't check, since many journals of those years are not indexed.
- Physics-style citations without a title (for example `Phys. Rev. Lett. 98, 100401 (2007)`) are looked up in Crossref by journal, volume and first page. They are marked Verified only when exactly one record matches all of those. Otherwise they stay Can't check: this path never gives Not found or Wrong ID. When a title stands in front of the journal's name, it is compared with the record's, so another title gives Details differ.
- Talks, keynotes, tutorials and slides are Can't check: they have no record to look up. That includes a talk named as such before its title or in a sentence of its own, and a talk about software at a technology meeting cited with its code repository. A talk cited exactly the way a paper is, with a conference name and nothing saying it is a talk, can still come out as Not found.
- Some citation styles are still misread. A conference paper in the Elsevier style "Title, in: Venue, Year, pp.", a course report cited with numbers like a volume and page, and a newspaper named "Journal" can come out as Not found. `docs/BACKLOG.md` lists these and the other known limits.
- The other way round, an invented citation written exactly as one of the shapes above (a talk, a paper from before 1970, a paper credited to a research group or consortium) comes out as Can't check, not Not found.
- The accuracy test below measured only the first 40 references of each paper. RefSure itself does not stop at 40.
- Confidential OpenReview submissions are never checked. If a page is not clearly public, nothing is sent anywhere, not even the title.
- Private windows are off. RefSure does not run in private or incognito windows.

## Accuracy

On papers it has never seen, RefSure missed one of its own accuracy targets in the latest test: on 289 references of eight fresh arXiv papers, 5 correct references (1.7%) came out Not found, where the target allows 1% (two references). It met the other two targets on those papers.

These numbers come from `npm run eval`, which runs the real checker against the real services. The full tables, with every Not found and Wrong ID looked up by hand, are in [`tests/eval/RESULTS.md`](tests/eval/RESULTS.md). The latest run (3 November 2026) used 88 real papers and up to the first 40 references of each, 3,140 references in all. One reference is about 0.16% of the main HTML sample and about 0.35% of a held-out set of eight papers, so treat the percentages as rough.

The targets are our own, from `docs/DESIGN.md` section 10. "Not found / Wrong ID" counts only references that turned out to be real works, after inspection by hand.

| Path | Not found / Wrong ID | Details differ | Can't check | Targets |
|---|---|---|---|---|
| Fresh arXiv HTML papers, never tuned on (289 references, 8 papers) | 5 (1.7%), target 1% or less | 6 (2.1%), target 5% or less | 22 (7.6%), target 10% or less | Missed one of three, by three references |
| arXiv HTML, the previous fresh set, partly tuned on (270 references, 8 papers) | 0, target 1% or less | 6 (2.2%), target 5% or less | 30 (11.1%), target 10% or less | Missed one of three, by three references |
| arXiv HTML, an earlier fresh set, partly tuned on (304 references, 8 papers) | 1 (0.3%), target 1% or less | 7 (2.3%), target 5% or less | 19 (6.3%), target 10% or less | Met all three |
| arXiv HTML, tuned on (633 references, 16 papers) | 3 (0.5%), target 1% or less | 23 (3.6%), target 5% or less | 53 (8.4%), target 10% or less | Met all three |
| arXiv PDF-only, tuned on (280 references, 11 papers) | 2 (0.7%), target 2% or less | 22 (7.9%), target 8% or less | 36 (12.9%), target 25% or less | Met all three |
| OpenReview via arXiv, tuned on (341 references, 9 papers) | 2 (0.6%), target 2% or less | 8 (2.3%), target 8% or less | 13 (3.8%), target 25% or less | Met all three |

The first row is the fairest guide to what you will see on a paper RefSure has never met: eight arXiv papers from late October 2026, picked by a fixed rule before anything was run on them, and not used for any fix. The other rows are papers the checker was improved against, so they flatter it. The second and third rows were fresh sets too, until fixes were drawn from them. Three older fresh sets, each used for fixes later, also met all three targets, and so did four physics papers read from their PDF and partly tuned on (no Not found, 2.0% Details differ, 7.9% Can't check against the PDF targets).

What the fresh papers show:

- Not found + Wrong ID misses the target by three references. The five correct references that came out Not found are two conference papers cited in the Elsevier style "Title, in: Venue, Year, pp." (the conference name was read into the title, so every search carried it), a physics paper whose title holds a chemical formula and whose journal name was cut short, a course report cited with numbers that read as a volume and page, and a newspaper statement in The Wall Street Journal. The one Wrong ID is right: the cited arXiv number belongs to another paper, and no work of the cited title could be found.
- Details differ: three of the six come from the same Elsevier style. The others are matches with another work (a textbook matched to a report with a similar title, a technical report matched to a book chapter) and a year that differs between a working paper and its book chapter.
- Can't check: 9 of the 22 are things no database lists (a blog post, documentation and project sites, a data page, reports, software). The other 13 (4.5%) are works RefSure could have checked: mostly books and working papers, plus one reference it could not read and one whose identifier it could not confirm.
- On the previous fresh set no correct reference comes out Not found, and Can't check is 30 of 270 (11.1%), over the 10% target. 27 of the 30 are things no database lists (model cards, code repositories, web pages, reports, a regulatory filing, a position paper, a software talk, two journals from before 1970 that no database holds).

Other measures from the same run:

- Deliberately altered citations (wrong year, swapped authors, wrong DOI, invented title): 46 of 46 were flagged as something other than Verified, against a target of 90%.
- Known retracted papers: 15 of 15 reported Retracted, against a target of 100%. That includes the 7 cited without a DOI.
- Correct control citations: 15 of 15 Verified.
- No correct reference in any sample was reported Wrong ID, and no reference of a real paper was reported Retracted.
- The thresholds in `src/core/thresholds.ts` were not loosened to reach these numbers.
- A full 40-reference check takes one to two minutes. The limit is the databases' request rates, not the extension.

## Privacy

RefSure has no server and no account. The developer receives nothing from your browser: no analytics, no telemetry, no ads, no crash reports.

When you run a check, the reference details of that paper (titles, authors, years, DOIs and arXiv IDs) are sent to the public databases listed above, and the OpenReview paper's title is sent to arXiv to find its arXiv version. No cookies and no referrer are sent. Settings, history and a lookup cache stay on your device, and you can turn history off and clear it.

Because reference text does leave your browser for those databases, the Firefox build declares website content as collected data. The full policy is in [PRIVACY.md](PRIVACY.md).

## Development

Requires npm and Node.js 22 (22.13 or later), 24, or 26 and later. Node 25 is not supported; `.nvmrc` names 26.

```bash
npm ci               # install the pinned dependencies
npm run dev          # Chrome dev build with live reload
npm run dev:firefox  # Firefox dev build
npm run build        # production builds for Chrome, Edge and Firefox into .output/
npm run zip          # store packages for Chrome, Edge and Firefox, plus the Firefox sources zip, into .output/
npm run verify       # typecheck, lint, unit tests and dependency audit
npx playwright install chromium  # once, before the first end-to-end run
npm run test:e2e     # end-to-end tests in Chromium; the network is faked
npm run eval         # accuracy test against the real services (slow, rate-limited)
```

`npm run eval` is the only command, besides the live check in the extension itself, that contacts real services. It keeps its answers in `tests/eval/.cache` so a stopped run can resume.

### Rebuild the Firefox package from its sources zip

Built and checked with Node.js 26.8 and npm 11.19. From the unpacked sources zip:

```bash
npm ci
npx wxt build -b firefox
```

The result in `.output/firefox-mv3` is the same, file for file, as the contents of `refsure-<version>-firefox.zip`.

### Load the build by hand

After `npm run build`:

- **Chrome:** open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and pick `.output/chrome-mv3`.
- **Edge:** open `edge://extensions`, turn on Developer mode, choose "Load unpacked" and pick `.output/edge-mv3`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose "Load Temporary Add-on" and pick `.output/firefox-mv3/manifest.json`. A temporary add-on is removed when Firefox closes.

Pin the RefSure button from the browser's extensions menu if you cannot see it. [`docs/MANUAL-CHECKS.md`](docs/MANUAL-CHECKS.md) lists what to check by hand in each browser.

### Where things are

- `docs/DESIGN.md`: what RefSure does and why.
- `SECURITY.md`: permissions, network allowlist and review checklist.
- `docs/STORE-LISTING.md`: text for the store listings.
- `docs/BACKLOG.md`: known issues and ideas left for later.
- `src/config.ts`: every constant that security or rate limits depend on.

## Notes for maintainers

- `CONTACT_EMAIL` in `src/config.ts` (yshashank7575@gmail.com) is the project's address. It is sent to Crossref with each request and is public in `PRIVACY.md` and the store listings. To change it, edit every place that names it: `src/config.ts`, `tests/unit/config.test.ts`, `PRIVACY.md` (Contact), `SECURITY.md` (sections 9 and 10), `docs/STORE-LISTING.md` (Support contact) and this file.
- The Firefox add-on id is `{d5793b66-7905-49f1-93d5-48f456578f2d}`. It must never change after the first upload.
- Private windows are off (`incognito: "not_allowed"`). Turn them on only after deciding what RefSure should store there.
- The screenshots in `docs/screenshots` come from the end-to-end tests. The result screenshots show an invented paper, with references made up so that every status appears; they are not findings about any real paper.

## Licence

RefSure is released under the MIT License (`LICENSE`). The bundled pdf.js is under the Apache License 2.0; its notice
and licence text, with WXT's MIT notice, are in `public/THIRD_PARTY_NOTICES.txt`, which ships in every package. The
test fixtures are third-party works under their own licences, listed in `tests/fixtures/ATTRIBUTION.md`.
