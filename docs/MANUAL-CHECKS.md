# Manual checks (Chrome, Firefox, Edge, real OpenReview pages)

What the automated tests cannot do: they run Chromium (Chrome's engine) with the built extension, with the network
faked, and they cannot click the toolbar button or open the real side panel. Everything below is done by hand, once
per release, in the real browsers. Each check says what to do and what you should see. Write down anything that is
different; a screenshot of each browser's panel is welcome.

Use Chrome or Edge 140 or later and Firefox 140 or later (desktop); older versions refuse to install RefSure.

Build first (from the project folder):

```bash
npm ci
npm run build          # makes .output/chrome-mv3, .output/edge-mv3 and .output/firefox-mv3
npm run zip            # makes the store packages in .output/; the Chrome test below unpacks refsure-0.1.0-chrome.zip
```

Then run `npx web-ext@10.8.0 lint --source-dir .output/firefox-mv3` (npx downloads web-ext 10.8.0 from the npm
registry; it is not a project dependency). It should report 0 errors and two warnings, both about pdf.js's own
`import(this.workerSrc)`.

## Papers to try

| Name | Where | Why |
|---|---|---|
| A. An arXiv HTML paper | `https://arxiv.org/html/1706.03762` ("Attention Is All You Need", 40 references) | Inline badges, the full panel |
| B. A PDF-only arXiv paper | `https://arxiv.org/abs/1602.03837` (the LIGO paper of 2016; it has no HTML version) | PDF reading (pdf.js worker), the Beta label, physics-style references |
| C. A public OpenReview forum page | Any ICLR paper's forum page that you can open without logging in, for example the page of a paper that also has an arXiv version. Take the address from the paper's own page on `openreview.net` | The page reader is tested against forum pages saved by hand (tests/fixtures/pages/README.md); this check confirms the live site still matches them |
| D. A confidential OpenReview page | Only if you have reviewer access: a submission you are assigned to review | Nothing may be sent anywhere |

## Chrome: the full test before submitting

Test the exact package that goes to the store. Unpack it into a folder of its own:

```bash
mkdir -p ~/Downloads/refsure-chrome-test
unzip -o .output/refsure-0.1.0-chrome.zip -d ~/Downloads/refsure-chrome-test
```

### 1. Install

1. Open `chrome://extensions`, switch on **Developer mode** (top right), press **Load unpacked** and choose
   `~/Downloads/refsure-chrome-test`.
2. **See:** the RefSure card with no red **Errors** button. Press **Details**: site access lists only arxiv.org,
   export.arxiv.org, openreview.net, api2.openreview.net, api.crossref.org, api.openalex.org and dblp.org, and
   **Allow in Incognito** is off and cannot be turned on.
3. Pin the RefSure button: puzzle-piece icon in the toolbar, then the pin next to RefSure.

### 2. The basics on a well-known paper

Open `https://arxiv.org/html/1706.03762` ("Attention Is All You Need") and click the RefSure button.

- The side panel opens on the right and the check starts. Results arrive one by one, problems listed first.
- Coloured pills appear after each reference on the page. Hover one: its reason shows. Click one: that row opens in
  the panel.
- In the panel: the filter chips narrow the list; opening a row shows the cited details next to the details found;
  **Show on page** scrolls to the reference and outlines its pill; the link opens the matched paper.
- Most references should be Verified. Write down any Not found and look it up by hand.

### 3. Papers with known results

These references were looked up by hand, so you know what each row should say. Open the HTML page, run the check,
and find the row by its number.

| Page | Row | Should say |
|---|---|---|
| `https://arxiv.org/html/2610.27412` | 26 (Petrovic et al., CeCoIn5) | Verified |
| same page | 39 (NIMS SuperCon database) | Can't check: the identifier leads to a dataset |
| `https://arxiv.org/html/2610.41111` | 13 ("Dropoutunet") | Wrong ID: the arXiv number belongs to another paper (correct) |
| `https://arxiv.org/html/2610.39147` | 4 (Banzhaf, Rutgers Law Review, 1965) | Can't check: published before 1970 |
| `https://arxiv.org/html/2610.39072` | 20 (Macklin, Warp, GTC talk) | Can't check: reads as a talk |
| `https://arxiv.org/html/2610.41107` | wav2vec 2.0 and Terada and von Luxburg | Not found: a known limit (Elsevier "in:" style). The reason should tell you to look it up by hand |

### 4. A PDF-only paper

Open `https://arxiv.org/abs/1602.03837` (the LIGO paper of 2016, no HTML version) and click the button.

- A **Beta** label with one line of help; no pills on the page and no **Show on page**.
- About 118 references; it takes a few minutes. Mostly Verified, the rest Can't check (web pages, reports, old
  journals). There should be no Not found; write down any you see.

### 5. A public OpenReview paper

On `https://openreview.net`, search for "Dynamic Channel Pruning: Feature Boosting and Suppression" and open its
ICLR 2019 forum page (no login needed). Click the button.

- **See:** "Checked using the arXiv version (arXiv:1810.05331)" and results.
- Known limit: row 10 (Hassibi, Stork and Wolff, "Optimal brain surgeon", NIPS 1993) is Not found, because those
  proceedings are not indexed.

### 6. Buttons and settings

- **Copy report**, then paste into any text field: a plain-text report.
- **Export CSV** and **Export JSON**: two files download; the CSV opens in a spreadsheet with accented names intact.
- **Stop** during a check: it stops and keeps the results so far.
- Open a paper you checked earlier: its last results show at once. **Settings**, then **Clear history**: they are
  gone.
- **Settings**: automatic checking is off by default. Turn it on, open another arXiv paper: the check starts by
  itself. Turn it off again. Leave the OpenAlex key empty.

### 7. Edge cases

- **Leaving a paper:** start the LIGO check, then open another page in the same tab. Nothing is left behind in the
  panel or on the new page.
- **Not a paper:** open `https://en.wikipedia.org` and click the button: "RefSure works on arXiv and OpenReview
  papers", and nothing is sent.
- **No network:** start a check and turn Wi-Fi off. The remaining rows become Can't check with **Try again**. Turn
  Wi-Fi on and press **Try again**: the check finishes.
- **Dark mode:** switch your computer to dark mode. The panel and the pills stay readable.
- **Narrow panel:** drag the panel's edge to make it narrow. No sideways scrolling.

### 8. Privacy check

On `chrome://extensions`, press **service worker** on the RefSure card. In the DevTools that open, choose
**Network**, then run a check on paper A. Every request goes to one of the seven hosts listed in step 1. Nothing goes
anywhere else, and nothing is sent before you click the button (unless automatic checking is on).

### 9. At the end

Back on `chrome://extensions`, the RefSure card still shows no red **Errors** button.

### Store screenshots

The screenshots in `docs/screenshots/` come from the end-to-end tests; the result screenshots show an invented paper.
The store takes 1280x800 (or 640x400) only: any result screenshot of another size has to be taken again at 1280x800.
The settings screenshots are ready to use.

## Firefox (about:debugging)

1. Open `about:debugging#/runtime/this-firefox` and choose **Load Temporary Add-on...**, then pick
   `.output/firefox-mv3/manifest.json`. (A temporary add-on is removed when Firefox closes.)
2. If Firefox shows a permissions or data-collection prompt, read it: it should list reading and changing data on
   arXiv, OpenReview, Crossref, OpenAlex and DBLP, and say that website content (the reference text) is sent to those
   services. Accept.
3. Open paper A. Click the RefSure toolbar button (if it is hidden, it is under the puzzle-piece menu; pin it).
   **See:** the sidebar opens with "Ready to check this paper" or starts checking; results stream in; coloured badges
   appear after each reference on the page.
   * Badges: rounded pills with an icon and a word (Verified, Details differ, Not found, ...), not unstyled text.
     Look at them in dark mode too (Firefox settings, Language and appearance, or `about:config`
     `layout.css.prefers-color-scheme.content-override` = 0 for dark).
   * Sidebar: a filter chip row, rows sorted with problems first, "Show on page" scrolls and outlines the badge.
   * Hover a badge: its reason shows as a tooltip. Click a badge: that row opens in the sidebar.
4. **Export and clipboard.** Press **Copy report** and paste it into any text field (it should be the plain-text
   report). If the clipboard is refused you should see a box with the text instead. Press **Export CSV** and
   **Export JSON**: both download a file (check the Downloads panel); the CSV opens in a spreadsheet with the
   accented letters intact.
5. Open paper B and check from its abstract page. **See:** a "Beta" label with one line of help, results with no
   inline badges and no "Show on page"; the check takes a few minutes. This is the PDF reading in Firefox
   (a module worker started from the add-on's own file). If it fails with "The PDF reader could not start" or
   "Reading this paper took too long", note exactly what the panel said and open the Browser Console
   (Ctrl+Shift+J) for the message.
6. Open paper C (OpenReview). Press the toolbar button. **See:** either "Checked using the arXiv version (arXiv:...)"
   with results, or the calm message that the paper has no arXiv version RefSure can find. Note which. Also note
   whether the page has the line "Readers: Everyone" and whether the button treats the page as public.
7. If you have reviewer access, open paper D and press the button. **See:** the "This submission isn't public..."
   message, and nothing else. Open the browser's network tools first (F12, Network) and confirm that **no request**
   goes to `api.crossref.org`, `api.openalex.org`, `export.arxiv.org`, `api2.openreview.net` or `dblp.org`.
8. Private window: the add-on should not run (the manifest says `incognito: not_allowed`); confirm it cannot be
   enabled there.

## Edge

1. Open `edge://extensions`, switch on **Developer mode**, press **Load unpacked**, and choose the folder
   `.output/edge-mv3`.
2. Pin the RefSure button. Open paper A and click it. **See:** the side panel opens on the right, the check starts,
   badges appear on the page. Repeat steps 3 to 8 above with Edge's equivalents (the side panel instead of the
   sidebar; Edge's own dark-mode setting for step 3).
3. For paper B check that the PDF reading works (Edge uses the same offscreen document as Chrome).
4. Edge may show a note about running in InPrivate windows: the extension should not be allowed there.

## What to look for, in short

| Area | You should see |
|---|---|
| Badges | Styled pills at the end of each reference on an arXiv HTML page; the page's own look untouched; the same in light and dark |
| Panel / sidebar | Opens from the toolbar button; results arrive one by one; filter chips; problems first; no horizontal scrolling at a narrow width |
| Export | CSV and JSON files download; Copy report puts text on the clipboard (or shows a box to copy from) |
| PDF reading | Paper B gets results, labelled Beta; no error about the PDF reader |
| OpenReview, public | "Checked using the arXiv version" results, or a calm "no arXiv version" message |
| OpenReview, confidential | The confidential message; no lookup request at all |
| Leaving a paper | Starting a check and then navigating elsewhere leaves nothing behind in the panel or on the other page |
| Private windows | The extension is off |

Report results to the owner as: browser and version, paper, what you saw, anything that looked wrong.
