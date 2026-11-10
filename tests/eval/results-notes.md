## Notes on these results

### How the papers were chosen

The arXiv papers were picked by a fixed rule before the checker was run on them: for a list of arXiv subject areas,
the arXiv API was asked for papers submitted from a given date, oldest first, and the first one that fit (an HTML
version with 20 to 110 references, or for the PDF sets a PDF of that size) was taken. Two PDF-only papers were added
by hand: the 2016 LIGO paper and Marcus 2018. The OpenReview papers were found through their venue statements on
arXiv ("Published as a conference paper at ICLR 2020"). `tests/eval/README.md` gives each set's window, ids and the
few candidates that were skipped.

The main sets (16 arXiv HTML papers, 11 PDF-only papers, 9 OpenReview papers read through arXiv) are the ones the
checker was improved against, so they flatter it. The held-out sets came later, each from a later window. A held-out
set is blind until a fix is drawn from it; after that it is partly tuned on, and the next set judges the fix. Only the
sixth held-out set was never used for any fix. It is the fairest guide to what a reader will see on a new paper.

### The latest run (3 November 2026)

Every group was run again in one sitting, 21:24 to 22:19 UTC, the sixth held-out set first. Requests already in the
disk cache were served from it; the rest went to the services, and the tables above were scored from the results. No
paper failed to load, no run was cut short and no source failed for any reference. OpenAlex's free daily budget never
ran out (US$0.024 of US$0.10 was spent). Crossref was used through its public pool.

In all, 3,140 references of 88 real papers were checked (up to the first 40 of each), plus 76 corrupted, retracted and
control citations. Every Not found and Wrong ID on a real paper was looked up by hand.

| Set | References | Not found + Wrong ID (real) | Details differ | Can't check | Bar |
| --- | --- | --- | --- | --- | --- |
| Held-out 6 (never tuned on) | 289 | 5 (1.7%) | 6 (2.1%) | 22 (7.6%) | arXiv HTML: misses |
| Held-out 5 (partly tuned on) | 270 | 0 | 6 (2.2%) | 30 (11.1%) | arXiv HTML: misses |
| Held-out 4 (partly tuned on) | 304 | 1 (0.3%) | 7 (2.3%) | 19 (6.3%) | arXiv HTML: meets |
| Held-out 1 to 3 (partly tuned on) | 871 | 1 (0.1%) | 30 (3.4%) | 50 (5.7%) | arXiv HTML: each meets |
| arXiv HTML (main) | 633 | 3 (0.5%) | 23 (3.6%) | 53 (8.4%) | arXiv HTML: meets |
| Physics PDF (partly tuned on) | 152 | 0 | 3 (2.0%) | 12 (7.9%) | PDF-only: meets |
| PDF-only and OpenReview (main) | 621 | 4 (0.6%) | 30 (4.8%) | 49 (7.9%) | PDF-only: meets |

- The sixth held-out set misses the arXiv HTML bar on one limit: 5 real references are Not found (1.7%, where the bar
  allows two). Details differ and Can't check meet their limits. Its one Wrong ID is right: the cited arXiv number
  belongs to another paper, and no work of the cited title could be found.
- The fifth held-out set no longer has a false Not found, but misses on Can't check (11.1% against 10%). 27 of its 30
  Can't check are things no database lists (model cards, code repositories, web pages, reports, a regulatory filing, a
  position paper, a software talk, two journals from before 1970 that no database holds).
- Corrupted citations: 46 of 46 flagged. Known retractions: 15 of 15 reported Retracted (8 cited with their DOI, 7
  without). Controls: 15 of 15 Verified.
- No real reference in any set was reported Retracted.

### Known misses

The five Not found on the sixth held-out set are real works:

- Two conference papers cited in the Elsevier style "Title, in: Venue, Vol. 33, 2020, pp. ..." (wav2vec 2.0 at
  NeurIPS 2020, Terada and von Luxburg at ICML 2014). The conference name is read into the title, so every search
  carries it and finds nothing. In the same paper this style gives three of the set's six Details differ.
- Kawamura and Das Sarma, Phys. Rev. B 45, 3612 (1992). The title holds a chemical formula, which Crossref stores as
  MathML, so no search ranks the record, and in this "(Year) Title. Journal Vol (Issue), pp." style the journal name
  is cut short, so the lookup by journal, volume and page cannot run.
- The Tiny ImageNet course report (Stanford CS 231N, 2015), in no database; its usual citation carries numbers that
  read as a volume and page.
- A newspaper statement in The Wall Street Journal, cited with its web address: the word "Journal" makes it read as
  a journal paper.

To the engine a real work that no database lists looks the same as an invented paper, which is why Not found is
worded as "not in these databases", never "made up". The other Details differ on the sixth set are matches with
another work (a textbook matched to a report with a similar title, an agency's technical report matched to a book
chapter) and one year that differs between a working paper and its book chapter. `docs/BACKLOG.md` lists the known
misreadings, with what a fix would have to guard against.

### Limits of the evaluation

- Only the first 40 references of each paper are checked. One reference is about 0.16% of the main arXiv HTML set and
  about 0.35% of a held-out set, so the percentages are rough.
- Details differ is counted as labelled, not judged by hand.
- Results depend on the day: when OpenAlex's free daily budget runs out, references it would have decided become
  Can't check instead of Not found, and DBLP meets the evaluation with a bot check.
- No OpenReview page is read. OpenReview papers are checked through their arXiv version, as the extension does; how a
  live forum page reads is a manual check (`docs/MANUAL-CHECKS.md`).
- The timings were measured in the first live run, the only one in which every request of a paper went out. Later
  versions send a few more requests, so a check today takes somewhat longer. Results stream in: the first arrives
  within seconds, and a full 40-reference check takes one to two minutes, set by the databases' rate limits.
