# Accuracy results

Produced by `npm run eval` (scripts/eval.ts). The first 40 references of each paper are checked; this scoring used only the stored answers. Crossref used the public pool (no contact address).

## Real papers against the quality bar

| Path | Papers read | References checked | Verified / Details differ / Wrong ID / Retracted / Not found / Can't check |
| --- | --- | --- | --- |
| arXiv HTML | 16/16 | 633 | 553 / 23 / 0 / 0 / 4 / 53 |
| arXiv PDF-only | 11/11 | 280 | 219 / 22 / 0 / 0 / 3 / 36 |
| OpenReview (via arXiv) | 9/9 | 341 | 318 / 8 / 0 / 0 / 2 / 13 |
| PDF paths (PDF-only + OpenReview) | 20/20 | 621 | 537 / 30 / 0 / 0 / 5 / 49 |
| arXiv HTML held-out (partly tuned on) | 8/8 | 302 | 269 / 11 / 0 / 0 / 4 / 18 |
| arXiv HTML held-out 2 (partly tuned on) | 8/8 | 277 | 242 / 11 / 0 / 0 / 0 / 24 |
| arXiv HTML held-out 3 (partly tuned on) | 8/8 | 292 | 273 / 8 / 0 / 0 / 3 / 8 |
| arXiv HTML held-out 4 (partly tuned on) | 8/8 | 304 | 277 / 7 / 0 / 0 / 1 / 19 |
| arXiv HTML held-out 5 (partly tuned on) | 8/8 | 270 | 234 / 6 / 0 / 0 / 0 / 30 |
| arXiv HTML held-out 6 (never tuned on) | 8/8 | 289 | 255 / 6 / 1 / 0 / 5 / 22 |
| arXiv PDF physics held-out (partly tuned on) | 4/4 | 152 | 137 / 3 / 0 / 0 / 0 / 12 |

| Path | Not found + Wrong ID (as labelled) | after inspection | bar | Details differ | bar | Can't check | bar | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arXiv HTML | 4 (0.6%) | 3 (0.5%) | ≤ 1% | 23 (3.6%) | ≤ 5% | 53 (8.4%) | ≤ 10% | meets the bar |
| arXiv PDF-only | 3 (1.1%) | 2 (0.7%) | ≤ 2% | 22 (7.9%) | ≤ 8% | 36 (12.9%) | ≤ 25% | meets the bar |
| OpenReview (via arXiv) | 2 (0.6%) | 2 (0.6%) | ≤ 2% | 8 (2.3%) | ≤ 8% | 13 (3.8%) | ≤ 25% | meets the bar |
| PDF paths (PDF-only + OpenReview) | 5 (0.8%) | 4 (0.6%) | ≤ 2% | 30 (4.8%) | ≤ 8% | 49 (7.9%) | ≤ 25% | meets the bar |
| arXiv HTML held-out (partly tuned on) | 4 (1.3%) | 1 (0.3%) | ≤ 1% | 11 (3.6%) | ≤ 5% | 18 (6.0%) | ≤ 10% | meets the bar |
| arXiv HTML held-out 2 (partly tuned on) | 0 (0.0%) | 0 (0.0%) | ≤ 1% | 11 (4.0%) | ≤ 5% | 24 (8.7%) | ≤ 10% | meets the bar |
| arXiv HTML held-out 3 (partly tuned on) | 3 (1.0%) | 0 (0.0%) | ≤ 1% | 8 (2.7%) | ≤ 5% | 8 (2.7%) | ≤ 10% | meets the bar |
| arXiv HTML held-out 4 (partly tuned on) | 1 (0.3%) | 1 (0.3%) | ≤ 1% | 7 (2.3%) | ≤ 5% | 19 (6.3%) | ≤ 10% | meets the bar |
| arXiv HTML held-out 5 (partly tuned on) | 0 (0.0%) | 0 (0.0%) | ≤ 1% | 6 (2.2%) | ≤ 5% | 30 (11.1%) | ≤ 10% | MISSES the bar |
| arXiv HTML held-out 6 (never tuned on) | 6 (2.1%) | 5 (1.7%) | ≤ 1% | 6 (2.1%) | ≤ 5% | 22 (7.6%) | ≤ 10% | MISSES the bar |
| arXiv PDF physics held-out (partly tuned on) | 0 (0.0%) | 0 (0.0%) | ≤ 2% | 3 (2.0%) | ≤ 8% | 12 (7.9%) | ≤ 25% | meets the bar |

| Path | Can't check | lookup budget used up | not a paper (website, software, book) | not listed (no venue, talk, report, before 1970, ePrint) | reference not readable | identifier not confirmed | a source could not answer | other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arXiv HTML | 53 | 0 | 29 | 14 | 10 | 0 | 0 | 0 |
| arXiv PDF-only | 36 | 0 | 15 | 12 | 9 | 0 | 0 | 0 |
| OpenReview (via arXiv) | 13 | 0 | 8 | 2 | 3 | 0 | 0 | 0 |
| PDF paths (PDF-only + OpenReview) | 49 | 0 | 23 | 14 | 12 | 0 | 0 | 0 |
| arXiv HTML held-out (partly tuned on) | 18 | 0 | 14 | 2 | 2 | 0 | 0 | 0 |
| arXiv HTML held-out 2 (partly tuned on) | 24 | 0 | 16 | 5 | 3 | 0 | 0 | 0 |
| arXiv HTML held-out 3 (partly tuned on) | 8 | 0 | 5 | 3 | 0 | 0 | 0 | 0 |
| arXiv HTML held-out 4 (partly tuned on) | 19 | 0 | 12 | 2 | 4 | 0 | 0 | 1 |
| arXiv HTML held-out 5 (partly tuned on) | 30 | 0 | 8 | 16 | 6 | 0 | 0 | 0 |
| arXiv HTML held-out 6 (never tuned on) | 22 | 0 | 17 | 3 | 1 | 1 | 0 | 0 |
| arXiv PDF physics held-out (partly tuned on) | 12 | 0 | 0 | 8 | 4 | 0 | 0 | 0 |

| Path | Can't check (all) | out of scope (judged by hand) | engine shortfall (books included) | lookup budget | a source not answering |
| --- | --- | --- | --- | --- | --- |
| arXiv HTML | 53 | 21 | 32 (5.1%) | 0 | 0 |
| arXiv PDF-only | 36 | 16 | 20 (7.1%) | 0 | 0 |
| OpenReview (via arXiv) | 13 | 3 | 10 (2.9%) | 0 | 0 |
| PDF paths (PDF-only + OpenReview) | 49 | 19 | 30 (4.8%) | 0 | 0 |
| arXiv HTML held-out (partly tuned on) | 18 | 3 | 15 (5.0%) | 0 | 0 |
| arXiv HTML held-out 2 (partly tuned on) | 24 | 12 | 12 (4.3%) | 0 | 0 |
| arXiv HTML held-out 3 (partly tuned on) | 8 | 5 | 3 (1.0%) | 0 | 0 |
| arXiv HTML held-out 4 (partly tuned on) | 19 | 12 | 7 (2.3%) | 0 | 0 |
| arXiv HTML held-out 5 (partly tuned on) | 30 | 27 | 3 (1.1%) | 0 | 0 |
| arXiv HTML held-out 6 (never tuned on) | 22 | 9 | 13 (4.5%) | 0 | 0 |
| arXiv PDF physics held-out (partly tuned on) | 12 | 2 | 10 (6.6%) | 0 | 0 |

The held-out rows are arXiv HTML papers chosen by the same method as the arXiv HTML row, each set from a later window than the one before (tests/eval/README.md): six sets of 8 papers, all scored here. Each is held to the arXiv HTML bar but not counted in the arXiv HTML row or in the exit code. Fixes were drawn from held-out sets 1 to 5, so they are no longer blind; held-out 6 has never been tuned on. The physics held-out row is 4 physics papers read from their PDF, chosen from a later window for their many title-less journal citations; fixes were drawn from it too, so it is partly tuned on. It is held to the arXiv PDF-only bar but not counted in the PDF rows or in the exit code. 4 of them are scored here.

"Not found + Wrong ID after inspection" counts only the references that, once looked up by hand, turned out to be real works. Every Not found and Wrong ID on a real paper has been inspected.

The last table splits Can't check for diagnosis; the bar is held to the all-in share. *Out of scope* are references judged by hand (`outOfScope` in inspection.json) as something no database lookup could check: web pages, software, datasets, talks, theses, reports, journals no database holds, a reference garbled in the paper itself. A title-less conference citation ("EMNLP (2014)", "NIPS pp. 1389–1399") is engine shortfall: Crossref or the pages could still identify it. *Engine shortfall* is every other Can't check that is not about the budget, books included (Crossref holds most of them; the engine's own "not a paper" label is no judgement). *Lookup budget* is OpenAlex's daily limit or a rate limit. *A source not answering* is a source that could not answer, broke its contract or gave a record with no title (in an offline re-score also: an answer that was never stored); it is kept apart from the budget because it can hide a source or engine bug.

OpenAlex was consulted for 228 references of the real papers; 0 references became Can't check because its free daily budget ran out (counted in the Can't check numbers above, and listed separately as "lookup budget used up").

## Time until 90% of the results had arrived (arXiv HTML papers)

These times come from the first live run, the only one in which every request of a paper really went out; they are kept when a later run answers from the disk cache. The engine has since added requests (ten Crossref answers instead of five, a second page when comments crowd the first, lookups for journal citations without a title), so a live check today takes somewhat longer. The times were not measured again.

| Paper | References checked | Until 90% of results | First result | Until all |
| --- | --- | --- | --- | --- |
| arxiv-html:2503.00258 | 40 | not measured (answers came from the cache) |  |  |
| arxiv-html:2503.05793 | 40 | 75.9 s | 4.8 s | 80.1 s |
| arxiv-html:2503.00260 | 40 | 67.9 s | 1.8 s | 71.9 s |
| arxiv-html:2503.00266 | 34 | 52.9 s | 0.4 s | 55.9 s |
| arxiv-html:2504.01995 | 40 | not measured (answers came from the cache) |  |  |
| arxiv-html:2503.00273 | 40 | 53.4 s | 1.2 s | 62.7 s |
| arxiv-html:2503.01913 | 40 | not measured (answers came from the cache) |  |  |
| arxiv-html:2505.00243 | 39 | not measured (answers came from the cache) |  |  |
| arxiv-html:2503.00312 | 40 | not measured (answers came from the cache) |  |  |
| arxiv-html:2503.00346 | 40 | 22.4 s | 0.3 s | 30.6 s |
| arxiv-html:2503.00475 | 40 | not measured (answers came from the cache) |  |  |
| arxiv-html:2503.00612 | 40 | 234.8 s | 6.3 s | 295.0 s |
| arxiv-html:2503.00632 | 40 | 327.7 s | 0.0 s | 360.8 s |
| arxiv-html:2503.00271 | 40 | 46.1 s | 0.4 s | 48.8 s |
| arxiv-html:2503.00252 | 40 | not measured (answers came from the cache) |  |  |
| arxiv-html:2503.00272 | 40 | 103.4 s | 0.4 s | 136.6 s |

## Corrupted citations and known retractions

| Set | Flagged | Rate | Bar |
| --- | --- | --- | --- |
| Corrupted citations (any status but Verified) | 46/46 | 100.0% | ≥ 90% |
|   wrong_year | 10/10 | 100.0% |  |
|   swapped_authors | 10/10 | 100.0% |  |
|   wrong_doi | 10/10 | 100.0% |  |
|   invented_title | 10/10 | 100.0% |  |
|   hallucinated | 6/6 | 100.0% |  |
| Retracted papers (status Retracted) | 15/15 | 100.0% | 100% |
|   cited with their DOI | 8/8 | 100.0% |  |
|   cited without a DOI | 7/7 | 100.0% |  |
| Controls (correct citations, Verified) | 15/15 | 100.0% | informational |

0 of the corrupted citations came back as Can't check because the OpenAlex budget was used up (they count as flagged).

## Not found, Wrong ID and Retracted on real papers, looked up by hand

| Case | Label | Reference (start) | After looking it up | Cause | Note |
| --- | --- | --- | --- | --- | --- |
| arxiv-html:2503.05793#32 | Not found | Q. Li, J. Ma, and Y. Ding Relationship between self-regulated learning strategies and clinical reasoning perfo | faulty reference (correct label) | not confirmed in any source | No record with this title in Crossref (title and bibliographic search with the journal filter) or arXiv. A similar real paper exists (Li, Zheng, Lajoie, Med. Sci. Educ. 33, 2023), so the entry is probably mis-cited. Left as correctly flagged. |
| arxiv-html:2503.00273#10 | Not found | Marat Valievich Burnashev. Data transmission over a discrete channel with feedback. random transmission time.  | real reference (false positive) | journal not indexed | Burnashev, Problems of Information Transmission 12(4), 1976 (a classic). Crossref has the journal only from later years; a title search finds nothing. |
| arxiv-html:2503.00632#36 | Not found | Z. Liu, M. Lu, Z. Wang, M. Jordan, and Z. Yang (2022) Welfare maximization in competitive equilibrium: reinfor | real reference (false positive) | proceedings not indexed (PMLR) | Liu, Lu, Wang, Jordan, Yang, ICML 2022, PMLR 162:13870-13911. Real; PMLR papers have no DOI and are not in Crossref, arXiv, OpenReview or OpenAlex under this title (searched by hand). |
| arxiv-html:2503.00252#27 | Not found | D. G. Ang, X. Liu, J. Tang, M. Shen, R. Ebadi and R. Walsworth, Progress toward a solid-state directional dark | real reference (false positive) | conference proceedings not indexed | Ang et al., MDvDM 2024 workshop proceedings, pp. 18-21. Real; Crossref only has the group's other directional dark matter papers (searched by hand). |
| arxiv-pdf:1903.00243#26 | Not found | B. Le Floch and P.G. LeFloch, The localized seed-to-solution projection as a parametrization of solutions to t | real reference (false positive) | preprint not posted | Le Floch and LeFloch, 'Preprint 2023': a real preprint that is not on arXiv under this title (the 2019 'seed-to-solution method' paper is the closest). |
| arxiv-pdf:1904.00690#5 | Not found | Bott. Predicting customer churn in telecom industry using multilayer preceptron neural networks: modeling and  | faulty reference (correct label) | reference garbled in the paper | The title is real: Adwan, Faris, Jaradat, Harfoushi and Ghatasheh, "Predicting customer churn in telecom industry using multilayer preceptron neural networks: modeling and analysis", Life Science Journal 11(3), 75-81, 2014 (found through another paper's reference list; that journal is in none of the databases and Crossref has no record of the title). The paper cites it as by "Bott." in "Igarss" 11(1):1-5, so author, venue, issue and pages are all wrong as cited. Left as correctly flagged. |
| arxiv-pdf:1801.00631#36 | Not found | Lighthill, J. (1973). Artificial Intelligence: A General Survey. Artificial Intelligence: a paper symposium. | real reference (false positive) | report not indexed | Lighthill, "Artificial Intelligence: A General Survey" (1973), the report to the Science Research Council. Real, in none of the databases. Not found when OpenAlex answers; Can't check when its daily budget is used up. |
| openreview:1810.05331#10 | Not found | Babak Hassibi, David G. Stork, and Gregory Wolff. Optimal brain surgeon: Extensions and performance comparison | real reference (false positive) | proceedings not indexed (NIPS 1993) | Hassibi, Stork, Wolff, "Optimal brain surgeon: extensions and performance comparisons", NIPS 6 (1993). Real; NIPS proceedings of that year are not in Crossref and not found in OpenAlex. |
| openreview:1910.00359#33 | Not found | Yurii Nesterov. A method for unconstrained convex minimization problem with the rate of convergence o (1/kˆ 2) | real reference (false positive) | journal not indexed | Nesterov, "A method for unconstrained convex minimization problem with the rate of convergence O(1/k^2)", Doklady AN SSSR 269 (1983). A classic; the journal of that year is not indexed. |
| arxiv-html:2609.00515#33 | Not found | T. Purason and A. Tättar Multilingual neural machine translation with the right amount of sharing. In Proceedi | real reference (false positive) | proceedings not indexed | Purason and Tättar, EAMT 2022 (Ghent), pp. 91-100, ACL Anthology 2022.eamt-1.12. The EAMT 2022 proceedings have no Crossref DOI and OpenAlex's search does not return the paper; Crossref returns only the authors' later papers. DBLP would know it but answers the eval with a bot check. |
| arxiv-html:2609.00505#8 | Not found | D. L. Chen and W. B. Dolan (2011) Microsoft research video description corpus. In Proceedings of the Workshop  | faulty reference (correct label) | mis-cited: a dataset's name given as the title, with a venue and pages that are not its paper's | D. L. Chen and W. B. Dolan (2011), "Microsoft research video description corpus", In Proceedings of the Workshop on Languages in Social Media, pp. 44-52. The Microsoft Research Video Description Corpus (MSVD) is a real dataset by Chen and Dolan, but its paper is "Collecting highly parallel data for paraphrase evaluation" (ACL 2011, pp. 190-200). No work of the cited title is found in Crossref, OpenAlex, arXiv or a web search; the engine's searches give only later papers about the corpus. Faulty as cited, so Not found is right; before, it was Details differ against an unrelated 2018 paper about the corpus. |
| arxiv-html:2609.00520#8 | Not found | S. J. Cruikshank, H. J. Rose, and R. Metherate (2007) Thalamocortical synaptic transmission in mouse auditory  | faulty reference (correct label) | not confirmed in any source | No such paper. Journal of Neurophysiology 98(6) has no article on pp. 3765-3780 (Crossref: pp. 3759-3769 Bremen et al., 3770-3779 Göbel and Helmchen, 3780-3790 Tolias et al.). The three authors did write "Auditory thalamocortical synaptic transmission in vitro" (J. Neurophysiol. 87, 361-384, 2002), and Crossref and OpenAlex both return that record, which differs in title and year. Left as correctly flagged. |
| arxiv-html:2609.00520#24 | Not found | N. Jajcay, J. Hlinka, J. Tinker, et al. (2022) The role of thalamus in neural mass models for the simulation o | faulty reference (correct label) | not confirmed in any source | No work with this title by Jajcay in Crossref, OpenAlex or arXiv. The cited article number (Front. Comput. Neurosci. 16, 769860, 2022, DOI 10.3389/fncom.2022.769860) belongs to Jajcay, Cakan and Obermayer, "Cross-Frequency Slow Oscillation-Spindle Coupling in a Biophysically Realistic Thalamocortical Neural Mass Model": a different title and two different co-authors (the reference has Hlinka and Tinker). Mis-cited; left as correctly flagged. |
| arxiv-html:2610.22417#2 | Not found | M. Aizenman, J. T. Chayes, L. Chayes, C. M. Newman. (1988). Discontinuity of the order parameter in one-dimens | faulty reference (correct label) | mis-cited title | The four authors' paper at J. Stat. Phys. 50(1), 1-40 (1988) is "Discontinuity of the magnetization in one-dimensional 1//x-y/^2 Ising and Potts models" (DOI 10.1007/BF01022985). The cited title ("Discontinuity of the order parameter in one-dimensional long-range percolation in the 1//i-j/^2 case") is no paper's title: it mixes that one with Aizenman and Newman's "Discontinuity of the percolation density in one dimensional 1//x-y/^2 percolation models" (Commun. Math. Phys. 1986). Crossref returned the real record second, but the titles are too far apart to match. Mis-cited, like 2609.00520#8; left as correctly flagged. |
| arxiv-html:2610.22417#36 | Not found | R. Tanaka. (2023). Long-range percolation on groups and graphs. Probab. Theory Related Fields. 185(1), 223-255 | faulty reference (correct label) | not confirmed in any source | No such article. Probab. Theory Related Fields 185 (2023), issue 1-2, has Norris, Silvestri and Turner on pp. 185-250 (Crossref); no article by Tanaka is in volume 185. Crossref (author Tanaka with long-range percolation), OpenAlex and arXiv (author Tanaka, "long-range percolation" in the abstract) have no work with this title. Left as correctly flagged. |
| arxiv-html:2610.22417#40 | Not found | J. van den Berg. (1993). A note on inequalities for increments of a monotonic function of a graph, with applic | faulty reference (correct label) | not confirmed in any source | No such article. Combin. Probab. Comput. 2(2) (1993) has Alm on pp. 115-136 and Alon and Yuster on pp. 137-144 (Crossref, whole issue listed); nothing by van den Berg. The title resembles van den Berg and Kesten, "Inequalities with applications to percolation and reliability" (J. Appl. Probab. 22, 1985), but no work with the cited title is in Crossref, OpenAlex or arXiv. Left as correctly flagged. (With #2 and #36, three of this paper's first 40 references do not exist as cited.) |
| arxiv-html:2610.28357#9 | Not found | D. V. Cross On judgments of magnitude. In Social Attitudes and Psychophysical Measurement, pp. 73–88. | real reference (false positive) | book chapter cited as "Title. In <book title>, pp." with no publisher, editor or year, read as a titled paper; no database holds the chapter | D. V. Cross, "On judgments of magnitude", in B. Wegener (ed.), Social Attitudes and Psychophysical Measurement, pp. 73-88 (Erlbaum, 1982). Crossref holds the book (Routledge reissue, DOI 10.4324/9780203780947) but no record for the chapter; OpenAlex and arXiv have nothing. Real, so Can't check by the design, not Not found. |
| arxiv-html:2610.41111#13 | Wrong ID | Akash Mishra, Akash Jain, Arindam Ghosal, et al. Dropoutunet: A deep neural network with dropout regularizatio | faulty reference (correct label) | not confirmed in any source; the arXiv number belongs to another paper | "Dropoutunet: A deep neural network with dropout regularization for semantic segmentation" (Mishra, Jain, Ghosal et al., arXiv:1804.03932, 2018). arXiv 1804.03932 is "Cooperative Energy Efficient Power Allocation Algorithm for downlink massive MIMO". No work of the cited title in Crossref (a search by hand gives other dropout papers), arXiv, OpenAlex or a web search. Faulty as cited, so Wrong ID is right. |
| arxiv-html:2610.41107#19 | Not found | Y. Terada, U. von Luxburg, Local ordinal embedding, in: International Conference on Machine Learning, 2014, pp | real reference (false positive) | Elsevier style "Title, in: Venue, Year, pp.": the conference name was read into the title, so every search carried it and found nothing | Y. Terada and U. von Luxburg, "Local ordinal embedding", ICML 2014 (PMLR 32), pp. 847-855, cited correctly. The engine searched for "Local ordinal embedding, in: International Conference on Machine Learning" in Crossref, arXiv (0 results), OpenReview and OpenAlex. A false Not found. |
| arxiv-html:2610.41107#31 | Not found | Y. Le, X. Yang, Tiny imagenet visual recognition challenge, CS 231N, Stanford University 7 (7) (2015) 3. | real reference (false positive) | course project report, in no scholarly database | Y. Le and X. Yang, "Tiny ImageNet visual recognition challenge", Stanford CS 231N course report (2015), the source of the Tiny ImageNet dataset, cited in the usual Google Scholar form "CS 231N 7 (7) (2015) 3". Real (web search), not in Crossref, arXiv or OpenAlex; the number pattern reads as a journal's volume and page, so Not found instead of Can't check. |
| arxiv-html:2610.41107#38 | Not found | A. Baevski, Y. Zhou, A. Mohamed, M. Auli, wav2vec 2.0: a framework for self-supervised learning of speech repr | real reference (false positive) | Elsevier style "Title, in: Venue, Vol., Year, pp.": the conference name was read into the title, so every search carried it and found nothing | A. Baevski, Y. Zhou, A. Mohamed, M. Auli, "wav2vec 2.0: A framework for self-supervised learning of speech representations", NeurIPS 33 (2020), pp. 12449-12460, arXiv:2006.11477. The engine's arXiv title search was "... speech representations in advances in neural information processing systems" (0 results); Crossref and OpenAlex searches with the same tail gave other wav2vec papers. A false Not found. |
| arxiv-html:2610.41101#25 | Not found | T. Kawamura and S. Das Sarma (1992) Phonon-scattering-limited electron mobilities in \mathrm{Al}_{x}\mathrm{Ga | real reference (false positive) | chemical formula in the title (MathML in Crossref's record) and the venue cut to "Phys", so no search ranked the record and no journal-locator lookup ran | T. Kawamura and S. Das Sarma, "Phonon-scattering-limited electron mobilities in AlxGa1-xAs/GaAs heterojunctions", Phys. Rev. B 45 (7), 3612-3627 (1992), DOI 10.1103/PhysRevB.45.3612 (Crossref by DOI, by hand; its title holds MathML for Al_x and Ga_{1-x}). The engine's Crossref top 10 and OpenAlex top 5 gave other AlGaAs papers. The parser reads the venue of this "(Year) Title. Journal Vol (Issue), pp." style as "Phys", so the locator lookup could not run. A false Not found. |
| arxiv-html:2610.41103#1 | Not found | Climate Leadership Council, “Economists’ Statement on Carbon Dividends - WSJ,” The Wall Street Journal, 2019.  | real reference (false positive) | news article: a newspaper named "Journal" read as a journal, despite its web address | Climate Leadership Council, "Economists' Statement on Carbon Dividends", The Wall Street Journal (January 2019), cited with its wsj.com address. A real newspaper statement, in no scholarly database; the design calls such entries Can't check, not Not found. |

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
