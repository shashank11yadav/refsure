# Backlog

Known issues and ideas left for later. None of them blocks a release. The evidence for the accuracy items is in
`tests/eval/RESULTS.md`, under the cases looked up by hand.

**Where accuracy stands.** The newest held-out set, never tuned on, misses the arXiv HTML bar on Not found + Wrong ID:
5 real references of 289 are Not found (1.7%, where the bar allows two). Items 1 to 4 are those five. The held-out set
before it now misses on Can't check: 30 of 270 (11.1%, where the bar is 10%), though 27 of the 30 are works no database
lists. Fixes were drawn from that set, so it can no longer judge one.

**Judging an accuracy fix.** Judge it on a fresh held-out set chosen blind by the method in `tests/eval/README.md`, from
papers submitted after the newest held-out set (its last arXiv id is 2610.41684). A set that a fix was drawn from is no
longer blind: items 1 to 4, 7 and 8 come from the newest set, so a fix drawn from them needs a seventh held-out set.
Every fix needs failing tests first, and adversarial tests showing that no invented or altered citation newly reaches
Verified.

## Accuracy: open

1. **The Elsevier style "Title, in: Venue, Vol., Year, pp." keeps the venue in the title** (false Not found). Terada
   and von Luxburg, "Local ordinal embedding, in: International Conference on Machine Learning, 2014, pp. ...", and
   Baevski et al., "wav2vec 2.0: ..., in: Advances in Neural Information Processing Systems, ...": the comma before
   "in:" is not read as the end of the title, so every search carries the conference name and finds nothing. In the
   same paper the style gives three Details differ. A fix must keep an invented title before ", in:" from reaching
   Verified.

2. **A formula in the title and a journal name cut to "Phys"** (false Not found). Kawamura and Das Sarma,
   "Phonon-scattering-limited electron mobilities in AlxGa1-xAs/GaAs heterojunctions", Phys. Rev. B 45, 3612 (1992).
   Crossref stores the formula as MathML, so no title search ranks the record, and in the "(Year) Title. Journal Vol
   (Issue), pp." style it is cited in, the parser reads the journal as "Phys", so the lookup by journal, volume and page
   never runs.

3. **A course report cited like a journal** (false Not found). Le and Yang, "Tiny ImageNet visual recognition
   challenge", Stanford CS 231N (2015), cited "CS 231N 7 (7) (2015) 3". It is in no database, but the numbers read as a
   volume and page, so it is Not found instead of Can't check.

4. **A newspaper named "Journal"** (false Not found). Climate Leadership Council, "Economists' Statement on Carbon
   Dividends", The Wall Street Journal, 2019, cited with its wsj.com address, reads as a journal paper. A fix must not
   let an invented paper in a real journal escape Not found.

5. **The lookup by journal, volume and page misses records Crossref holds** (Can't check, the safe direction).
   "Astrophys. J. Lett. 915, L12 (2021)" is in Crossref (10.3847/2041-8213/ac03b8), but the bibliographic search with
   the cited locator does not rank that journal's records, so the reason says no record was found there. "Front. Phys.
   (Beijing) 21, 016300 (2026)" still says "Couldn't read this reference reliably", because Crossref answers with
   Frontiers in Physics records. Asking with `query.container-title` and an abbreviation does not help: it returns
   unrelated journals.

6. **A regulatory filing gets the vague reason** (low). An SEC filing whose author is "U.S. Securities and Exchange
   Commission" is Can't check, as it should be, but with "Couldn't read this reference reliably" instead of a reason
   that says it reads as an organisation's document.

7. **Other Can't check that a lookup could settle** (low). On the newest held-out set: eight books (Crossref holds most
   of them), three SSRN and ECB working papers, "Phys. Rev. A 36, 3479(R)" (unreadable because of the "(R)"), and "Natl.
   Sci. Rev. 7, 254 (2020), arXiv:1811.12840", whose arXiv record is the same work from 2018 and so is "identifier not
   confirmed".

8. **Details differ against another work** (low; no accusation). Ashcroft and Mermin's book "Solid state physics" is
   matched with a 1976 trip report of a similar title, and an ACER technical report with a book chapter.

## Accuracy: accepted limits

9. **Unindexed journals, proceedings and reports of 1970 or later are Not found** when OpenAlex answers and DBLP is
   blocked by its bot check: EAMT 2022, some PMLR volumes, workshops, company reports, and journals of those years no
   database holds (Burnashev, Problems of Information Transmission, 1976). To the engine a real one and an invented
   paper look the same. A fix would need a list of unindexed journals or years, with adversarial tests showing that
   invented papers still reach Not found.

10. **A chapter cited with its pages alone is read as a paper.** "D. V. Cross On judgments of magnitude. In Social
    Attitudes and Psychophysical Measurement, pp. 73–88." has the exact shape natbib gives PMLR and other proceedings,
    so it can be Not found; so can a chapter cited with a publisher alone ("In Algorithmic Learning Theory, pp. 1–20.
    Springer"). The other way round, an invented paper cited as a chapter with editors, or as "In Handbook of ..., pp.
    ... <Publisher>", is Can't check.

11. **An invented paper in exactly an accepted shape is Can't check, not Not found.** Real works of these shapes are in
    no database, so each is Can't check when nothing matches: a talk named as such before its title or in a sentence of
    its own, with no pages or volume ("Invited talk: ...", "Keynote talk. In Proceedings of ..."); a titled paper of
    before 1970 with no identifier and no later year; a talk about software at a technology meeting, cited with its code
    repository; a paper credited to a research group named where the title goes (a consortium, a collaboration,
    "Investigators", a research, study, writing or trial group, a research network); a venue that is only a version
    number ("0.9.2"). An invented citation dressed exactly so escapes Not found.

12. **"Technology Conference" also names research meetings.** The software-talk rule reads any "... Technology
    Conference" as a technology meeting, which covers some with indexed proceedings (Electronic Components and
    Technology Conference, Offshore Technology Conference). An invented paper cited there with a repository link, and no
    "In ..." or pages, is Can't check.

13. **A one-word dotted title before a DOI, against a record with no journal name.** In a journal citation with no
    title, the words in front of the journal's name are compared as a title once one of the record's journal names
    fits. When the record has none, a word shaped like part of a journal's name ("Inflation." before a DOI in the page's
    place) is still taken for the journal, so such an altered citation can be Verified.

14. **Greek look-alike pairs that differ in meaning.** A one-letter Latin word counts as the Greek letter the other
    title has in the same place, so pairs that are really different words ("p-junctions" and "π-junctions", "Hepatitis
    B" and "Hepatitis β", "s-wave" and "σ-wave") compare as equal. An altered citation of that kind with the real
    authors and year can be Verified. The rule is there for Greek letters lost from PDF text.

15. **A journal name with a comma inside stays in the title** (Details differ at worst). In SIAM style the comma is the
    only mark between title and journal, and the end of a title can look the same, so "Ann. Inst. Henri Poincaré,
    Probab. Stat." is not read as a journal. It is never Verified on a shortened title.

16. **A wrong journal or volume alone does not make Details differ.** With the right DOI, or the right title, authors
    and year, a citation that names another volume or journal is Verified ("Nucl. Phys. B538, <DOI>" for B537; a
    SIAM-style "Deep learning, Nat. Mach. Intell., 521 (2015)" against the Nature paper).

## Network

17. **A last source that keeps asking for 30-second waits makes a run slow to stop** (low). When every other required
    source is off for the run and the last one answers each request with 429 and "Retry-After: 30", each lookup keeps
    its three retries and honours every wait, so the run stops only after about 11 minutes, with few requests sent. The
    user can stop it. A quicker stop would count a rate limit that carries a Retry-After as down at once.

## Not planned

**Semantic Scholar.** It would need a new network origin, its licence is partly non-commercial, and keys may not be
shared, so it is not planned.
