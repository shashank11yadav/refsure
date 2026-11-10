# Accuracy evaluation

`npm run eval` runs the extension's real engine (the same `src/` code, unchanged) against the real lookup
services and scores it against the quality bar in `docs/DESIGN.md` section 10. The latest numbers are in
[RESULTS.md](RESULTS.md). This folder holds the data and the by-hand judgements; the code is in
`scripts/eval.ts` and `scripts/eval/`.

## Running it

```bash
npm run eval                        # run what is missing, then score; exits 1 if the arXiv HTML bar is missed
npm run eval -- --max-refs 60       # check the first 60 references of each paper (default 40)
npm run eval -- --offline --rerun   # recompute from the stored answers only (use after changing src/core/thresholds.ts)
npm run eval -- --only html         # html, holdout, holdout2, holdout3, holdout4, holdout5, holdout6, pdf, physics, openreview, retracted, corrupted, controls (comma separated)
npm run eval -- --list-flagged      # Not found / Wrong ID / Retracted on real papers that nobody has looked at yet
```

* Real network: only the allowlisted scholarly APIs and `arxiv.org` (the paper pages and PDFs). It is slow on purpose:
  the per-source rate limiters of the extension apply (arXiv: one request per 3 s; OpenAlex without a key has a
  budget of about 100 searches a day for the whole network address).
* Every answer is stored in `tests/eval/.cache/` (not committed), so a stopped run resumes where it stopped and a
  finished one can be scored again without asking the services. Only answers worth keeping are stored (200, 404, 410);
  rate-limit and server errors never are.
* Crossref is used through its public pool unless the environment variable `REFSURE_CONTACT_EMAIL` is set to
  an address you own, which then goes into Crossref's `mailto` parameter. The contact address in `src/config.ts`
  is removed from the requests.
* The first `--max-refs` references of each paper, in the paper's own order, are checked (a deterministic sample, to
  keep the run within the time budget). Papers with fewer references are checked whole.
* Timings (time until 90% of the results had arrived) are only meaningful for a paper whose answers were all fetched
  live in that run; for a re-score from the cache the timings measured earlier are kept.

## The data: `dataset.json`

| Part | Size | How it was built |
|---|---|---|
| `arxivHtml` | 16 papers | arXiv HTML pages (`arxiv.org/html/<id>`). For each of a list of subject areas (cs.CL, cs.CV, cs.LG, stat.ML, math.CO, math.PR, hep-th, cond-mat.mes-hall, astro-ph.CO, q-bio.NC, econ.GN, cs.SE, cs.CR, eess.IV, physics.optics) the arXiv API was asked for the papers submitted from 1 March 2025 (1 April for cs.LG, 1 May for math.PR), oldest first; the first ones with an HTML version of 20 to 110 references were taken, duplicates dropped. Nothing was chosen by hand beyond that. Their own primary categories: cs.CL, cs.CY (2), cs.CV (2), cs.AI, stat.ML, math.CO, math.PR, gr-qc, hep-th (2), cond-mat.mes-hall, cond-mat.dis-nn, cs.SE, quant-ph. |
| `arxivHtmlHoldout` | 8 papers | The first held-out set, chosen on 2026-10-27; partly tuned on since (fixes for BibLaTeX entries, LoRA and TeX titles were drawn from it). The same method as `arxivHtml` from a new window: for cs.CL, cs.CV, cs.LG, math.PR, hep-th, cond-mat.mes-hall, q-bio.NC and econ.GN (in that order) the arXiv API was asked for the papers submitted from 1 September 2026, oldest first; the first one with an HTML version of 20 to 110 references (counted with the extension's own reader) was taken, duplicates dropped. Only econ.GN needed more than one try (two without HTML, one with 150 references). Nothing was chosen by hand. Ids: 2609.00515, 2609.00505, 2609.00504, 2609.22202, 2609.00517, 2609.00631, 2609.00520, 2609.02580; primary categories cs.CL, cs.CV, cs.GT, q-fin.RM, math-ph, cond-mat.mes-hall, q-bio.NC, cs.MA. Run with `--only holdout`. |
| `arxivHtmlHoldout2` | 8 papers | The second held-out set, chosen on 2026-10-28; partly tuned on since (fixes for a "Note:" field read as a venue, the "Surname, I., Title. J. Abbrev." style, a data DOI and a bracketed issue number were drawn from it). The same method from papers submitted from 1 October 2026; a candidate also had to be not withdrawn and not already in dataset.json. Only q-bio.NC needed more than one try (the first had 0 references the reader could find). Nothing was chosen by hand and the checker was not run on any candidate. Ids: 2610.00850, 2610.00848, 2610.00851, 2610.00901, 2610.00844, 2610.00877, 2610.00990, 2610.01008; primary categories cs.CR, cs.CV, cs.CV, math.PR, hep-th, cond-mat.mtrl-sci, physics.bio-ph, econ.GN. 2610.00844 and 2610.00877 had a second version by the time of the run; the check reads the current HTML. Run with `--only holdout2`. |
| `arxivHtmlHoldout3` | 8 papers | The third held-out set, chosen on 2026-10-29; partly tuned on since (fixes for a title written mostly in maths, the Nature style with a URL after the year and a part number at the end of a title were drawn from it). The same method from papers submitted from 15 October 2026. Only cond-mat.mes-hall needed more than one try (the first had no HTML version). Nothing was chosen by hand and the checker was not run on any candidate. Ids: 2610.21030, 2610.21086, 2610.21033, 2610.22417, 2610.21058, 2610.21317, 2610.21176, 2610.21711; primary categories cs.IR, cs.CV, stat.ML, math.PR, hep-th, cond-mat.str-el, cs.LG, cs.GT. Run with `--only holdout3`. |
| `arxivHtmlHoldout4` | 8 papers | The fourth held-out set, chosen on 2026-11-02; partly tuned on since (fixes for the SIAM and REVTeX styles, a note field, a titled journal reference found by its locator, a dataset DOI, a chapter and a working paper were drawn from it). The same method from papers submitted from 20 October 2026, with an arXiv id of 2610.22500 or later. Only cs.CL and math.PR needed more than one try (the first had 13 and 7 references). Nothing was chosen by hand and the checker was not run on any candidate. Ids: 2610.27435, 2610.27410, 2610.27412, 2610.27434, 2610.27420, 2610.27436, 2610.28357, 2610.27576; primary categories cs.AI, cs.CV, cond-mat.mtrl-sci, stat.CO, hep-th, cond-mat.mes-hall, q-bio.NC, econ.GN. Run with `--only holdout4`. |
| `arxivHtmlHoldout5` | 8 papers | The fifth held-out set, chosen on 2026-11-02; partly tuned on since (fixes for a titled paper from before 1970 that nothing matched, a talk about software at a technology conference, a match on an organisation's name or a buried title and a version number read as a volume were drawn from it). The same method from papers submitted from 29 October 2026, with an arXiv id of 2610.32500 or later, not already chosen. Every category's first candidate qualified. Nothing was chosen by hand and the checker was not run on any candidate. Ids: 2610.39086, 2610.39147, 2610.39072, 2610.39115, 2610.39101, 2610.39074, 2610.40280, 2610.39097; primary categories cs.CL, cs.CV, physics.comp-ph, math.PR, hep-th, cond-mat.mes-hall, cs.LG, econ.GN. Run with `--only holdout5`. |
| `arxivHtmlHoldout6` | 8 papers | The sixth held-out set, chosen on 2026-11-03 and never used to tune anything. The same method from papers submitted from 30 October 2026, with an arXiv id after 2610.40280 (2611.* counts), not already chosen. Only math.PR needed more than one try (the first had 16 references), and cs.LG's first candidate had already been chosen for cs.CL. Nothing was chosen by hand and the checker was not run on any candidate. Ids: 2610.41104, 2610.41111, 2610.41107, 2610.41128, 2610.41138, 2610.41101, 2610.41684, 2610.41103; primary categories cs.LG, cs.CV, cs.AI, math.PR, hep-th, cond-mat.mes-hall, q-bio.NC, eess.SY. Run with `--only holdout6`. |
| `arxivPdfOnly` | 11 papers | The same method for papers submitted from 2016 to 2020 (cs.LG, cs.CV, cs.CL, cond-mat.str-el, hep-ph, stat.ME, stat.ML, math.NA, physics.flu-dyn, q-bio.QM, ... windows of one month), keeping those for which `arxiv.org/html/<id>` answers 404, i.e. that can only be read from the PDF (withdrawn papers skipped). Two well-known 404 papers were added by hand: the 2016 LIGO paper (physics reference style) and Marcus 2018. The q-bio.QM paper first taken, 1805.00393, turned out withdrawn (arXiv answers 404 for its PDF) and was replaced by the next paper of the same list (q-bio.QM, submitted from 1 April 2018, oldest first): the eight papers after it all have an arXiv HTML version, so the first one whose HTML answers 404, that is not withdrawn and whose PDF gives 20 to 110 references was 1804.02628 (24 references). Primary categories: econ.EM, math.AP, stat.ME, cond-mat.str-el (2), cs.CL, cs.CY, cond-mat.other, cs.NE, gr-qc, cs.AI. |
| `pdfPhysicsHoldout` | 4 papers | Physics papers read from their PDF, chosen on 2026-11-02 to cover references with no title ("P. Astone et al., Phys. Rev. D 82, 022003 (2010)."), which the other PDF papers have almost none of; partly tuned on since (fixes for a PDF entry running into the next column or page, a DOI as the page or a bracketed erratum in a title-less citation and more journal abbreviations were drawn from it). For gr-qc, hep-ex, astro-ph.HE and nucl-th (in that order) the arXiv API was asked for the papers submitted from 20 October 2026, oldest first; the first paper with an id of 2610.22500 or later whose PDF, read with the extension's own PDF reader, gave 20 to 120 references with confidence 0.8 or more, of which at least half were title-less journal citations, not withdrawn, not in dataset.json and not in `arxivHtmlHoldout4`, was taken. gr-qc needed 11 tries, hep-ex 3, astro-ph.HE 85 (the first 40 results were exhausted, so the next page of the same query was read) and nucl-th 10 (one of them skipped unread as already chosen in hep-ex). Nothing was chosen by hand and the checker was not run on any candidate. Ids: 2610.28055, 2610.27843, 2610.31730, 2610.28399; primary categories cond-mat.mes-hall, hep-ph, astro-ph.HE, nucl-th; title-less shares 31 of 32, 20 of 23, 32 of 40, 20 of 21 references. Run with `--only physics`; read from the PDF even where an HTML version exists and held to the arXiv PDF-only bar. |
| `openreview` | 9 papers | ICLR 2019 to 2022 and NeurIPS 2022 papers, found through arXiv comments such as "Published as a conference paper at ICLR 2020", with 8 or more pages. See the OpenReview note below. |
| `retracted` | 15 papers | Formally retracted papers, each confirmed in Crossref (`updated-by` of type `retraction`, the Retraction Watch data). Seven well-known cases (Wakefield 1998, Hwang 2005, Obokata 2014, the arsenic-life paper of 2011, Séralini 2012, and two 2020 COVID-19 papers) plus eight drawn at random on 2026-10-26 from `api.crossref.org/works?filter=update-type:retraction,type:journal-article,from-pub-date:2012&sample=60`. Title, authors, year, venue and DOI come from Crossref; each is cited correctly in one of three styles, with its DOI (every second one) or without. |
| `corrupted` | 46 citations | Made from 16 real, well-known papers (DOIs and metadata checked in Crossref): 10 with a wrong year (3 to 7 years off, outside the one-year tolerance), 10 with swapped authors (the right title, another paper's authors), 10 with a wrong DOI (title, authors and year of one paper with the real DOI of an unrelated one), 10 with an invented title (real authors and venue; half also carry a made-up DOI), and 6 wholly invented citations (kind `hallucinated`) (invented but plausible authors, title, venue, year, some with a made-up DOI or arXiv number). `derivedFrom` and `note` say which. |
| `controls` | 15 citations | The same real papers cited correctly. Not part of the bar: they show whether the harness verifies well-formed real citations at all. |

Each held-out set is held to the arXiv HTML bar (the physics set to the PDF-only bar) and reported in its own row,
never counted into the main numbers or the exit code. A set stops being blind once a fix is drawn from it; the next
fix is then judged on a new set chosen the same way from a later window.

References of the real papers are not listed in the dataset: they are read from the paper (HTML or PDF) every
time, as the extension reads them, and presumed to be real, existing works. Each Not found, Wrong ID and Retracted
the engine gives on a real paper is then looked up by hand (next section); Details differ is counted as labelled.

### OpenReview papers

OpenReview's forum pages, single-paper API routes and PDFs sit behind a bot challenge that RefSure must not bypass
(DESIGN section 7.1), so the evaluation could not read any OpenReview paper itself (the public search API works) and
no OpenReview forum ids are recorded (`openreviewForum` is `null`). As in the extension, these papers are checked through their arXiv version: the references are read
from the arXiv HTML page, or from its PDF when there is none, and checked like any other. The papers are known to be
public OpenReview papers only through their venue statement on arXiv. What a real OpenReview forum page looks like
to the content script remains a manual check (docs/MANUAL-CHECKS.md).

## Judging by hand: `inspection.json`

The reference lists of real papers are presumed correct, so a Not found or Wrong ID on one is a false positive until
a person looks. For every such case (and every Retracted on a real paper) the reference was looked up in Crossref,
OpenAlex, arXiv and the web page of the paper itself, and judged:

* `real`: the reference is a genuine work, so the label was wrong (a false positive). That includes real items that
  are not in the scholarly databases at all (a book, a thesis, a web page, a news article, a talk, work in
  preparation): the design says those are Can't check, never Not found.
* `problem`: the reference really is faulty or does not exist as cited, so the label was right.

The `cause` says why the engine got it wrong (or why it was right); `note` holds what was found.

`inspection.json` maps `<run key>#<reference number>` to `{ verdict, cause, note }`. Its `outOfScope` list holds the Can't check
references judged by hand as something no database lookup could check (web pages, software, datasets, talks, theses,
reports, journals no database holds, a reference garbled in the paper itself), each as `{ case, kind, note }` with a
note that says what the reference is. A title-less conference citation ("EMNLP (2014)") is not out of scope: Crossref or
its pages could still identify it. RESULTS.md then splits Can't check into those, the engine's shortfall (everything else
that is not about the budget or a silent source, books included), the lookup budget (a limit hit) and a source not
answering (kept apart, since it can hide a source or engine bug). The bar is still held to the all-in Can't check share. The scorer counts only the
`real` ones against the Not found / Wrong ID bar. While any case is missing from the file, the scorer says so and uses the
labels as given.

## What is not covered

* Details differ is counted as labelled (every one counts against the 5% / 8% limit), not judged by hand.
* The first 40 references of each paper only (see above).
* OpenAlex's free daily budget: references that could not be searched there become Can't check, and RESULTS.md
  lists them separately.
* No OpenReview page was read (above).
