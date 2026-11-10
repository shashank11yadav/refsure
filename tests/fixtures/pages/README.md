# Page and PDF fixtures

Used by `tests/unit/extract/` and `tests/e2e/`. Nothing here is fetched at test time.

## arXiv HTML pages

Saved from `https://arxiv.org/html/<id>` (served as `text/html; charset=utf-8`). They are LaTeXML output, so every
bibliography is `li.ltx_bibitem` with a `.ltx_tag_bibitem` label and `.ltx_bibblock` parts. Every paper here is
openly licensed; titles, authors, licences and changes are in `../ATTRIBUTION.md`.

| File | Paper | References | Why it is here |
|---|---|---|---|
| `arxiv-2402.03664v5.html` | Partial Gromov-Wasserstein Metric (ICLR 2025) | 71 | Numeric `[n]` labels, `bib.bibN` ids in order; the default paper of the e2e tests. Saved 2026-11-09 and trimmed: sections 2 to 5 and the appendices are removed, the introduction, conclusion and the whole bibliography are as served |
| `arxiv-2312.11805.html` | Gemini report | 136 | 100+ references, author-year labels ("Alayrac et al. (2022)"). Saved 2026-10-21, unmodified |
| `arxiv-2610.28627.html` | Matrix multiplication from polynomial packings | 13 | **Alphanumeric labels** (`[BCRL79]`, `[ADV+25]`, `[Ope26a]`), the "+" is a `<sup>` inside the tag; ids are `bib.bibxN`; MathML in titles. Saved 2026-10-21, unmodified |
| `arxiv-2503.00258.html` | Decoupling Content and Expression (author-year, ACL style) | 67 | HTML twin of the two-column author-year PDF below (cross-check). Saved 2026-10-26 by the evaluation's cache, unmodified |
| `arxiv-2401.00036.html` | Discrete Distribution Networks (ICLR 2025) | 43 | HTML twin of the ICLR PDF below (cross-check). Saved 2026-11-09, unmodified |
| `arxiv-invented-screenshots.handmade.html` | an invented paper | 14 | Written by hand in the same markup for `tests/e2e/screenshots.spec.ts`: the authors, title, references, venues and identifiers are all made up, so no real person or paper is shown with a status in the screenshots |

## arXiv PDFs

Downloaded on 2026-11-09 from `https://arxiv.org/pdf/<id>`; arXiv serves them as `content-type: application/pdf`,
which `fetchBytes` requires. To keep them small, all but one are trimmed to the pages around the reference list:
the kept pages are copied byte for byte (fonts, text and its positions unchanged), and pictures on them are replaced
by a blank one-pixel image (pdf.js reads no text from pictures). `../ATTRIBUTION.md` lists the pages kept.

| File | Paper | Style | Expected references | How the count was confirmed |
|---|---|---|---|---|
| `arxiv-2402.03664v5-numeric.pdf` | Partial Gromov-Wasserstein Metric (ICLR 2025) | one column, `[n]` labels | **71** | Equals the 71 `li.ltx_bibitem` of the HTML page; every entry matches its HTML twin (title similarity >= 0.9) |
| `arxiv-2503.00260-twocol-numeric.pdf` | Seeing A 3D World in A Grain of Sand (CVPR style) | two columns, `[n]` labels with back-references ("2, 3") | **42** | Labels run [1] to [42] without a gap across both columns; the list follows the supplementary pages; each entry is its HTML version's entry plus the back-references |
| `arxiv-2503.00258-twocol-authoryear.pdf` | Decoupling Content and Expression (ACL style) | two columns, author-year, hanging indent, no labels; appendix after the list | **67** | Equals the 67 bibitems of the HTML page; each entry matches its twin. Not trimmed |
| `arxiv-2610.39097-authoryear.pdf` | Measuring Longer-Horizon Leveraged ETF Performance | one column, surname-first author-year, hanging indent; the list runs over a page break, a page number under the last entry of each page | **21** | The list is alphabetical (Avellaneda ... Vanguard) and all 21 entries were checked by eye; the tests read only the PDF |
| `iclr-2401.00036-authoryear.pdf` | Discrete Distribution Networks (ICLR 2025) | one column, author-year, hanging indent, running head on every page, `URL ...` in entries | **43** | Equals the 43 bibitems of the HTML page; each entry matches its twin (>= 0.85) |

The brief asks for two public OpenReview PDFs. OpenReview's PDF downloads sit behind a bot
challenge that RefSure must not bypass (DESIGN section 7.1), so ICLR papers stand in: their arXiv copies use the
ICLR reference style (`iclr-2401.00036-authoryear.pdf`, and the `[n]` variant in `arxiv-2402.03664v5-numeric.pdf`).

## OpenReview pages

A real OpenReview page cannot be fetched by a script (bot challenge), so two kinds of fixture
exercise `readOpenReviewPage`: real forum pages saved by hand from a browser, and pages written by
hand (`*.handmade.html`) for the cases no real page shows.

### Real pages (saved 2026-10-29, trimmed)

Saved from Chrome ("Webpage, Complete") while not signed in, then trimmed by a script: external
scripts, stylesheets and most rows of the page data removed, two replies kept, and every
commenter's and author's name and profile id replaced by placeholders (`Author One`,
`~Commenter_One1`, ...); abstracts and reply texts are placeholders too. The paper titles, forum and
note ids, venue groups, dates and layout are as saved.

| File | Page | What it showed |
|---|---|---|
| `openreview-iclr2021-legacy-forum.html` | ICLR 2021 forum `YicbFdNTTy`, legacy forum layout, loaded directly | No `__NEXT_DATA__`. The data comes as Next.js app-router chunks, `self.__next_f.push([1,"..."])`; joined, they are rows `<hex id>:<JSON>` (or `I[...]`, `HL[...]`), and one row holds the forum note as `forumNote` with `"readers":["everyone"]` and `content.title` a plain string. The router-state row nests 26 levels deep. No `.readers` element: the paper's line is `<span class="item">Readers: <span class="readers-icon ..."></span> Everyone</span>` in `#note_YicbFdNTTy .meta_row`. Each reply has its own "Readers: Everyone" item, and the reply filter row holds a "Visible To" list with `value="everyone"` |
| `openreview-iclr2025-forum.html` | ICLR 2025 forum `imT03YXlG2`, newer layout, reached from the venue page inside the site | The chunks are the venue page's (the tab's first load) and hold no forum note; they include a text row (`26:T<hex byte length>,<text>`, no line end). The header is `.forum-container > .forum-note` with `.forum-title` (its pdf link names the forum id) and `.forum-meta`, whose `<span class="readers item">` reads `Everyone` with no "Readers:" prefix. Replies carry `<span class="readers">Everyone</span>`; the reply filter a `readers-filter` toggle "Everyone". The `citation_title` meta holds the title |
| `openreview-iclr2025-forum-hard-load.html` | ICLR 2025 forum `odjMSBSWRt`, newer layout, loaded directly (a hard reload) | Same markup as above, but the chunks are the forum page's own: one row holds `forumNote` in the API v2 shape (`"readers":["everyone"]`, `content.title.value`), and next to it the page's `query` object `{"id":"odjMSBSWRt"}`, which carries the forum id but no note keys and so is no copy of the note. Data and label agree |

The same forum, reached from the venue page inside the site, read like `openreview-iclr2025-forum.html`
(venue chunks, label alone) and was not kept.

### What the reader relies on

1. Page data: `<script id="__NEXT_DATA__" type="application/json">`, and the app router's
   `self.__next_f` scripts, both read when present. The chunks are joined and split into rows; text rows
   are skipped by their byte length, and anything unreadable (a script that is not a plain push, a push
   of another kind, a row that is not JSON, a row cut short, data over the size limit) makes the page
   unclear. The reader walks all of it (capped; React trees get a deeper cap) and treats every object
   whose `id` equals the address's forum id, and that has note-like keys (`readers`, `forum`, `content`,
   ...), as a copy of the note, whatever its `forum` says.
2. `readers` is an array of group ids; a copy is public exactly when it contains `"everyone"`. The page is
   public only when every copy is public and the walk was complete (no cap hit); a restricted copy anywhere
   makes it confidential; unreadable `readers`, other forums' notes, a hit cap, or unreadable data make it unclear.
3. The title is `content.title.value` (newer API shape) or `content.title` (older); in the chunks a
   leading `$` is written `$$`, and any other `$` string is a reference, not a title. It is returned only
   for a public page, only if no copy's `content.title.readers` excludes everyone, and only if every copy
   that has a title agrees on it. The `citation_title` `<meta>` tag is used only when the page has no
   forum-note data and the label alone made it public; `<title>` and `og:title` are never read.
4. The label: in the legacy layout every "Readers: ..." meta item of `#note_<forumId>` (not a nested
   note's, not one inside a field of the note); in the newer layout the `.forum-meta .readers` item of
   the page's only `.forum-note`, which must read exactly `Everyone` (or `Readers: Everyone`); anything
   else there is restricted, a second `.forum-note` is restricted, and a note whose title links name
   another forum id is ignored. The first `.readers` element reading `Readers: ...` (hand-made pages)
   counts too. Any restricted line makes the label restricted. With forum-note data the label can only
   make the result less public; without it, the label alone decides.

### Hand-made pages

| File | Covers |
|---|---|
| `openreview-public.handmade.html` | Data says `["everyone"]`, label agrees: public, with title and forum id |
| `openreview-confidential.handmade.html` | Restricted readers list: confidential, no title returned |
| `openreview-nodata.handmade.html` | No embedded data, no label: unclear |
| `openreview-malformed.handmade.html` | Truncated JSON: unclear |
| `openreview-label-only.handmade.html` | No embedded data, label "Readers: Everyone", `citation_title` meta: public with that title |
| `openreview-hostile-decoys.handmade.html` | Confidential forum note surrounded by decoys: a reply and a second note that say "everyone", a `__proto__` key, "readers: everyone" in text, a public-looking label inside a reply |
| `openreview-hostile-title.handmade.html` | Public note whose title is markup (`<img onerror>`, `<script>`): returned as text |

## Manual PDF check (2026-10-21, Node, pdf.js legacy build)

Run with `extractPdfReferences` on PDFs not kept as fixtures (too large), compared entry by
entry with the same paper's arXiv HTML bibliography (title similarity >= 0.85):

| Paper | PDF size | PDF refs / HTML refs | Aligned | Time |
|---|---|---|---|---|
| GPT-3 (2005.14165, 73 pages, alphanumeric keys `[ADG+16]`) | 6.8 MB | 144 / 144 | 144 | 0.2 s |
| Llama 2 (2307.09288) | 13.7 MB | 135 / 135 | 135 | 0.3 s |
| Gemini (2312.11805) | 27.5 MB | 136 / 136 | 136 | 0.2 s |
| Chinchilla (2203.15556) | 6.0 MB | 60 / 60 | 60 | 0.3 s |
| OPT (2205.01068) | 1.8 MB | 98 / 98 | 98 | 0.1 s |
| LLaMA (2302.13971) | 0.7 MB | 82 / 82 | 82 | 0.1 s |
| DeepSeekMath (2402.03300) | 1.8 MB | 61 / 61 | 61 | 0.1 s |
| Mixtral (2401.04088) | 2.5 MB | 35 / 35 | 35 | < 0.1 s |
| Mistral 7B (2310.06825) | 3.7 MB | 29 / 29 | 29 | < 0.1 s |
| ViT (2010.11929) | 3.7 MB | 58 / 58 | 57 | 0.2 s |

ViT's last entry also carries the first lines of the table that follows it on the same page.
