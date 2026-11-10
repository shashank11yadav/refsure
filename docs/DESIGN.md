# RefSure design

What RefSure does, how it decides each result, and the limits it works within. Security rules are in
`SECURITY.md`; measured accuracy is in `tests/eval/RESULTS.md`.

## 1. Purpose

Reports in 2025 and 2026 found invented references in published papers. Most checkers make you paste or upload a
reference list instead of checking the page you are reading.

RefSure lets a reader or reviewer click once on an arXiv or OpenReview paper and see which references are real, which
have wrong details and which were retracted, each with the reason.

The one thing it must not do is accuse a real paper with false confidence. When it is unsure, it says it couldn't
check, never that a reference is fake.

## 2. Who it is for

Students, researchers and peer reviewers reading papers on arXiv and OpenReview. Authors writing in Overleaf or Google
Docs, and journal editorial desks, are not served.

## 3. What it does

1. Works on public arXiv and OpenReview paper pages. Confidential OpenReview submissions (visible only to logged-in
   reviewers) are not checked: the panel says the submission isn't public, so it was not checked and nothing was sent.
   RefSure never uses the user's OpenReview login.
2. Checks three things for every reference:
   - Exists: a real record matches the citation.
   - Details match: title, authors and year agree with the record.
   - Retracted: the matched work has been retracted. Corrections and expressions of concern are shown as notes when
     the data has them.
3. Shows a side panel with totals and a reason for each reference, and, on arXiv HTML pages, a small badge next to
   each reference on the page.
4. Runs when the user clicks. Automatic checking on arXiv and on OpenReview are separate settings, both off by default.
5. In the panel: copy a plain-text report, open the matched paper (DOI, arXiv or OpenReview link), export CSV and
   JSON, and reopen past checks from local history (which can be turned off and cleared).
6. Ships for Chrome and Edge 140 or later and Firefox 140 or later. Brave, Opera and Arc should run the Chrome build
   (not tested).
7. Results stream in as they arrive, and the first usually shows within a few seconds. A full check of 40 references
   takes one to two minutes, because the databases' rate limits set the pace. Speed never overrides an API's terms.

## 4. Non-goals

- No language models, in the cloud or on the device. No result is a guess: each comes from a database lookup or a
  stated rule, with a reason you can read.
- No judgement of whether the cited paper supports the claim it is cited for.
- No backend server, no user accounts, no sign-in, no payments.
- No Overleaf, Google Docs, journal sites or arbitrary pages.
- No Safari and no mobile browsers.

## 5. Anti-goals (failure even if it technically works)

- Labelling a real reference "fake" or "hallucinated". User-facing wording is
  always "Not found in Crossref, arXiv, OpenReview or OpenAlex", never an accusation.
- Sending anything about the user (identity, browsing history, other tabs) to
  anyone. Only reference text and identifiers go to the public lookup services,
  and only after the user clicks (or turns on automatic checking).
- Any telemetry, analytics, ads, affiliate links or remote code.
- Breaking or visibly slowing arXiv or OpenReview pages.
- Requesting broad permissions ("read all your data on all websites").
- A cluttered or jargon-heavy UI. A first-time user must understand the
  result without reading docs.

## 6. Constraints

- Manifest V3 on all three browsers. No remotely hosted code; strict CSP.
- Free public data sources only, called directly from the extension: the Crossref REST API, the OpenAlex API, the
  arXiv API, the DBLP API (computer science, including ML conferences missing from Crossref) and the public OpenReview
  API (papers published on OpenReview, such as ICLR). No API key ships in the extension. Limits as measured on
  2026-10-21 (details in `docs/API-NOTES.md`); at runtime the response headers win over these numbers:
  - Crossref: public pool about 1 request per second; the "polite" pool (requests with a `mailto`) 3 per second.
  - OpenAlex: without a key, one shared budget of $0.10 a day per IP address; a search costs $0.001 and lookups by ID
    are free. A free user key raises the budget to $1 a day.
  - arXiv: about one request every 3 seconds; many IDs go in one request.
  - DBLP: the API answers with an anti-bot challenge page instead of JSON, so DBLP is optional and best-effort. It is
    used when it returns valid JSON and is never required for a Not found.
  - Public OpenReview API (`api2.openreview.net`): its search works without login. Single-paper routes and PDFs sit
    behind a bot challenge.
- API contact: RefSure identifies itself to Crossref with the project's address, the constant `CONTACT_EMAIL` in
  `src/config.ts`. Never a user's details.
- The store listings need a privacy disclosure, and it must be true and short (`docs/STORE-LISTING.md`).
- The code stays readable and builds with one command.

## 7. How it works

### 7.1 Where references come from

| Page | How references are read | Inline badges? |
|---|---|---|
| arXiv HTML paper (`arxiv.org/html/<id>`) | Parse the rendered bibliography list in the page | Yes |
| arXiv abstract page (`arxiv.org/abs/<id>`) | Fetch that paper's arXiv HTML version and parse its bibliography | No: side panel only, with a link "Open the HTML version" to see badges |
| arXiv paper with no HTML version, checked from its abstract page | Fetch the PDF and extract the reference section | No: side panel only |
| arXiv PDF (`arxiv.org/pdf/<id>`) | Fetch the PDF and extract the reference section | No: side panel only |
| Public OpenReview forum page (`openreview.net/forum?id=…`) | OpenReview's single-paper API and PDF downloads are behind an anti-bot challenge (measured 2026-10-21), and sending the user's cookies is forbidden. So: the content script reads the paper title and its "readers" visibility from the page; only if the page shows the paper is readable by everyone, RefSure finds the same paper on arXiv (title search) and checks that version's references | No: side panel only, labelled "Checked using the arXiv version" |
| Public OpenReview paper with no arXiv version | Not checked; the panel says RefSure reads OpenReview papers through their arXiv version and found none | - |
| Confidential OpenReview submission (or visibility unclear) | Not checked; the panel says the submission isn't public, so it was not checked and nothing was sent (not even the title) | - |
| OpenReview PDF (`openreview.net/pdf?id=…`) | Not checked: the PDF viewer cannot show whether the paper is public. The panel asks for the forum page instead | - |

PDF text is read with pdf.js, bundled inside the extension and never loaded
from a CDN. References read from a PDF are less clean than HTML ones, so the
matcher tolerates that and leans toward "Can't check" rather than "Not found"
when the parse is uncertain.
In a two-column paper, a page whose columns sit above or below full-width lines (a wide figure, the author list under
the last references of a letter) is cut at the gutter band by band, between those lines, so the lines of two entries
are never joined across the gutter; a document set mostly in one column is not cut. Whatever the layout, an entry of a
"[n]" list that holds the label of an entry the list lacks ("[116]" inside [112]) is cut there, so two works never
share one number. In the middle of a line such a label counts only before a capital (a name or an organisation):
"Synthesis of [7] helicene" and "see also [9] for" are text. Both parts of a cut in the middle of a line may still hold
words of the other (the later part gets the continuation lines of both, the earlier one's DOI and locator included),
so neither is ever Not found, Wrong ID or Details differ (it is "Can't check" instead, as it may be mixed with the one
next to it); either can still be Verified or Retracted.
An entry carried over to the next column or page keeps the list's type size. Text in another size that opens a new
column or page inside the list (the body text or equations that fill the top of both columns when the list starts
halfway down a page) is skipped when the list resumes below it in that column, and ends the list when the column holds
nothing else; when the entry's own text follows it, nothing is skipped. A running head that carries the page number
is dropped wherever it sits, if it repeats (digits aside) on another page, and the list ends at a closing heading
(Acknowledgements, Author contributions, Competing interests, Data or Code availability, Additional information).

### 7.2 Checking one reference

#### Reading the reference

1. Parse the reference: pull out DOI, arXiv ID, title, author surnames, year,
   venue where present. A DOI in a data clause after the title ("Note: Data: Harvard Dataverse, https://doi.org/...",
   "Data available at ...", "Dataset: ...") is the data's, not the reference's: a DOI outside such a clause is used,
   and with none the title is searched. A bracketed number right after a volume ("Proc. R. Soc. B 287 (1937), 20200568") is
   its issue, not the year, when the reference gives another year (in brackets elsewhere, or standing alone before it);
   alone it is the year ("Nucl. Phys. B 360 (1991) 145"). In a journal citation with no title, a DOI where the page goes
   ("Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999)") is its identifier, and an erratum in brackets after the
   locator ("Rev. Mod. Phys. 90, 015004 (2018), [Erratum: Rev.Mod.Phys. 94, 029901 (2022)]") is a note on the same work:
   neither cuts the journal's name into a title and a venue, and a year inside an erratum bracket is never the work's
   (a title that ends up in the journal's name is read out of it with the record in hand: see the title-less journal
   citations below). A chapter cited by its book alone ("T. Nagamiya, in Solid State Physics,
   Vol. 20 (Elsevier, 1968) pp. 305–411") has no title of its own: the book's name is never compared with a record as if
   it were the chapter's title, and the reference is "Can't check" unless its identifier settles it. So is a book or
   proceedings named after a lower-case "in" whose name holds a proceedings or meeting word before its first number, with
   no journal volume and page after it ("E. Goetz et al., in Gravitational Waves: Proceedings, of the 8th Edoardo Amaldi
   Conference, Amaldi, New York, 2009."); a "title" that still
   opens with a lower-case "in" and a capital is never one that a database's silence can count against (a real title is
   capitalised: "In Defense of the Triplet Loss"). In "Surname, I., Title. J. Stat.
   Phys. 113, 389–410 (2003).", the journal opens with an abbreviation or a known journal word right after the title's full
   stop (or a comma after a lower-case word); whole words before it stay in the title, so an added sentence ("A Review.",
   "Reply.", "New Results.") is compared as part of it. A known first word counts only when the name goes on at once
   ("Theory Probab. Appl.", "Physica A", "Annals of"), and "Pt.", "Suppl.", "Corr.", "Gen.", "Vol." and the like never
   open a journal. In Nature style ("Blum, A. & Mansour, Y. From external to internal regret. Journal of Machine
   Learning Research 8, 1307–1324 (2007).") the names end with the last author's initials and a full stop; a sentence
   after them that ends in a lower-case word is the title, so the entry is searched by it rather than read as a journal
   citation with no title. The title may open in lower case or with a symbol ("k-means clustering of …", "de Sitter
   vacua …"). A journal's name half spelled out with a lower-case abbreviation ("Weil, A. J. reine angew. Math. 179, 129
   (1938).", "Prandtl, L. Zeitschrift für angew. Math. Mech. 5, 136 (1925).") reads the same way and is taken as a title
   too; no word list decides. The journal locator fallback below tells the two apart by the record. A part number after a title is part of it, with the part's own title ("Quantum Theory of
   Gravity. II. The Manifestly Covariant Theory"), so part II is never compared as part I; a numeral followed by names
   ("I. Goodfellow and Y. Bengio, editors") is an initial. Against a record, the venue keeps only the run of words that reads best, in order, as an
   abbreviation of the record's venue (each word abbreviating one of its words, with or without the full stop: "Nat
   Phys"; extra words after the last match, as in "Phys Rev E Stat Nonlin Soft Matter Phys", cost nothing; joining words
   such as "of" match nothing; of two equally good readings the later start wins, so "Science Advances. Science 113"
   keeps only "Science"). The words
   before that run go back to the title for the comparison ("... Physical Origins. Phys. Rev. Lett." against Physical
   Review Letters); with no venue on the record, or none the name abbreviates (a repository's, one in another language),
   whole words go back, but abbreviations, series letters (which match only that letter) and a journal's opening word
   followed by its name ("Physica A", "Theory Probab. Appl.") stay, except a sentence added in front of a name that is a
   journal's on its own: one word written like an abbreviation ("Models.", "Bounds.") or a journal's opening word and one
   such word ("Probability Bounds.", "Physical Origins."), before two words or more that open a journal's name ("J. Stat.
   Phys.", "Phys. Rev. Lett."), goes back. A word that opens real journals' names ("Phys.", "Ann.", "Electron.", "Bull.",
   "Br.", from a closed list) is never such a sentence, and nothing goes back when what would be left is not a journal on its
   own ("Phys. Rev.", "Ann. Stat."). An opening abbreviation that the record's venue leaves
   out ("Adv." in "Adv. Neural Inf. Process. Syst." against Neural Information Processing Systems; likewise "Proc.",
   "Conf.", "Int.", "Intl.", "Annu.", "Ann.", "Trans.", "J.") stays in the venue too; a whole word with a full stop
   ("Advances.") is a sentence and goes back. Before a publisher only the publisher's own words count
   ("Cambridge University Press"), never a sentence that ends in a full stop.
   In SIAM style ("S.-K. Au and J. L. Beck, Title, Probabilistic Eng. Mech., 16 (2001), pp. 263–277, https://...") the
   names end at the comma after the last "and <initials> <Surname>", and the title at the comma before the journal's own
   chunk, which is followed by "<volume> (<year>)" (or "(<year>)" alone) and then pages, a link or the end. Only the comma
   says where a journal named in whole words starts ("..., Asymptotic importance sampling, Structural Safety, 12 (1993)"),
   so against a record such a name stays the venue only when every word of it reads, in order, as the record's venue;
   otherwise (another venue, or none on the record) all of it goes back to the title for the comparison. An abbreviated
   name is read as any other journal abbreviation above. The journal's chunk may join its words with "and", "their",
   "its", "de", "du", "la", "et", "für", "die", "und" and the like ("Stochastic Processes and their Applications",
   "Journal de Mathématiques Pures et Appliquées", "Annales de l'Institut Fourier"), end a whole word with a colon
   ("ESAIM: Math. Model. Numer. Anal.") or hold a dotted acronym ("Proc. Natl. Acad. Sci. U.S.A."), and the title before
   it may be two words ("Deep learning, Nature, 521 (2015)"). A journal's name with a comma inside ("Ann. Inst. Henri
   Poincaré, Probab. Stat.") is not read as one: the comma is the style's only mark between title and journal, and the
   end of a title can look the same ("..., Part II. Theory, Ann. Stat."), so that chunk stays in the title (Details
   differ at worst, never Verified on a shortened title). A book's publisher named in whole words ("Springer New York",
   "Springer Science & Business Media", "John Wiley & Sons") ends its title as a publisher's name alone does, and a
   two-word title before a publisher is read. In REVTeX's arXiv style ("J. Z. Kim, O. Lesser, and D.
   Chowdhury, Title (2026), arXiv:2606.12520 [cond-mat.supr-con] .") the title ends before " (<year>), arXiv:", unless
   the chunk before the year reads as a journal's name or is a status ("in press", "to appear", "accepted", "submitted",
   "forthcoming"; "Title, Nature Physics (2024), arXiv:...", an
   accepted paper with no volume yet): that chunk is the venue, and the title ends at the comma before it. A journal
   whose name opens in lower case counts only from a closed list ("npj Quantum Mater.", "eLife", "iScience", "mBio",
   "eNeuro" and a few more), so a lower-case word at the end of a title ("..., iPhone (2024), arXiv:...") stays in it.
   A title written in TeX is compared as the databases print it: a macro with an argument is its argument
   ("\widetilde{O}" is "O"), and a Greek letter is one word however it is written ("\nu", "ν" and "nu"; a word written
   in Greek is left alone). A one-letter Latin word stands for the Greek letter it is spelled with or looks like ("a-stable"
   for "α-stable", "the k parameter" for "the κ parameter") only where the other title has that letter in the same place:
   joined by a hyphen to the same next word, or alone between the same two words; the article "a" standing alone is never
   "α". The search phrase sent to Crossref, OpenAlex, OpenReview and DBLP writes a Greek letter as the
   letter ("Fractional quantum Hall effect at ν=2+4/9"). Markup in a record's title splits no word: an inline tag joins
   what it wraps to its word ("CeCoIn<sub>5</sub>" is "CeCoIn5", so "cecoin5" cited in lower case is the same word), and
   a MathML formula is a word of its own, even when the service prints it with no space around it. A line break or a block
   tag is a space (JATS's "<jats:break/>" too), and only known markup (HTML, JATS and MathML elements; of one-letter
   names only "i" and "b") is taken out: other text between "<" and ">" ("n<k and k>m", "p<q and q>r") stays.

#### Looking it up

2. If a DOI or arXiv ID is present → look it up directly (most reliable;
   free on every source). Then compare the record's title/authors/year with
   what the citation says.
3. Otherwise → bibliographic search, cheapest and most permissive source
   first: Crossref (polite pool) → arXiv → OpenReview → DBLP (best-effort) →
   OpenAlex search last (it is metered). Stop as soon as a confident match is found.
   Score candidates on title similarity, author-surname overlap and year
   (±1 tolerance for preprint vs. published; ±2 when the work has an arXiv version, since such
   papers are often cited by a journal year two years after the posting; the year of an arXiv
   record's journal reference counts as one of the work's dates). The arXiv version must be the
   record's (the record is the arXiv one or links it): an arXiv id that only the reference gives
   opens no window and lends no date, since it may not exist or may be another work's.
   An arXiv record reached by the cited arXiv id (with no DOI cited) that differs from the reference only in its year,
   the cited year being later than the window allows, is the preprint of a work cited by its journal version: the title
   is then searched in Crossref only (no metered OpenAlex search), and a strong match there is the match instead, with
   its retraction looked up as for any strong match. A retracted record that is only a confident match is shown as Details
   differ with the note that the closest record was retracted; two copies that cannot be told apart, one retracted, are
   "Can't check" as on the ordinary path. Anything else leaves the arXiv record as the match.

#### Rate limits and waits

4. Request scheduling: one shared, per-source rate limiter and queue that
   respects each API's limits; cache every result locally (not a Can't check, and not one reached while a required
   source failed, which may have shaped it); back off on
   HTTP 429/5xx. If a source's budget is exhausted, remaining references it
   would have been needed for become "Can't check" (the lookup limit is reached;
   try again later), never "Not found".
   arXiv ids are looked up in one batch per paper; a batch that fails (a
   timeout, a server error) is asked again once in batches of ten, one
   request at a time, stopping at the first of them that fails too. A refusal
   is not asked again: a rate limit, any answer with a Retry-After (which
   also pauses the source, whatever its status), a page that is not the feed
   (a bot check) or a redirect out of the allowlist. An id that still fails
   leaves its reference to the title search: arXiv counts as failed, so that
   reference is never Not found or Wrong ID because of it.
   A service that asks, with a Retry-After, for a longer pause than a request
   waits (30 s) is not contacted again until the stated time, at most one
   hour: its later lookups fail at once, unsent and without waiting for a
   turn in its queue, and their references are
   "Can't check (try again later)", never "Not found". Nothing clears the wait
   by hand: the panel names the service and the local time RefSure tries it
   again ("Crossref asked RefSure to wait. RefSure will try it again after
   19:42"; a time that has passed is never shown), and Try again or Re-check
   during it sends nothing to that service and says the same again. A shorter
   Retry-After pauses that service's queue.

#### The six statuses

5. Classify into exactly one status:

| Status | Badge | Meaning shown to user |
|---|---|---|
| Verified | ✓ green | Found; title, authors and year match |
| Details differ | ⚠ amber | Found a close match, but the year or authors (say) differ; lists exactly what differs |
| Wrong ID | ⚠ red-amber | The DOI/arXiv ID exists but points to a different paper than the title says; shows both side by side |
| Retracted | ⛔ red | The matched work is formally retracted (links to the retraction notice) |
| Not found | ✗ grey-red | No record closely matches in any source searched; the message names the sources searched |
| Can't check | ? grey | Not a paper (website, software, book without DOI), unparseable, low-confidence PDF parse, or lookup failed/limited |

#### Rules

- "Not found" only after **every required** source (Crossref, arXiv,
  OpenReview, OpenAlex) was actually searched successfully. Any failed or
  skipped required source → "Can't check". DBLP is optional (see section 6).
- **Retracted** = a formal retraction recorded by Crossref (incl. Retraction
  Watch data) or OpenAlex `is_retracted`, for the matched work **or** its
  other version (preprint ↔ published); the reason text says which version.
  Retraction overrides all other statuses.
- arXiv **withdrawn** preprints, corrections and expressions of concern do
  **not** change the badge; they add a visible note on the row (e.g.
  "Note: withdrawn by authors on arXiv", "Note: expression of concern
  issued").
- "Details differ" and "Wrong ID" always show the citation and the matched
  record side by side.

#### Accusation guards

##### Retracted and Wrong ID

- **Retracted needs a strong match.** One of:
  - title ≥ 0.95 + genuine author agreement + year within tolerance of any known date of the work (preprint, online, print) when both are known;
  - title ≥ 0.98 with a title of ≥ 4 words when either side has no authors;
  - an identifier-only reference whose author zone is empty ("bare identifier"), or whose named authors overlap the record's authors.

  Weaker matches never trigger a retraction lookup.
- **Wrong ID needs positive evidence.** All of:
  - the identifier resolves to a usable record;
  - title similarity < 0.5;
  - the cited title has ≥ 3 real (non-boilerplate) words;
  - the citation names at least one Latin-script person, and none of those names match the record's authors.

  An empty, organisational ("OpenAI", "Gemini Team") or non-Latin author list gives no evidence, so the result is "Details differ". The same happens when the authors genuinely agree but the title differs (e.g. a translated title).
  A record its service lists as a dataset, software, a collection or another kind of work that is not a paper (Crossref's
  type, the raw type of OpenAlex's location: "dataset", "Collection", "Software") often carries a name of its own ("MDR
  SuperCon Datasheet" for "Superconducting material database"): it is never Wrong ID, and it does not stop the search by
  title. The reference is judged by its own title (or by another identifier it cites that matches); when nothing matches
  it, it is "Can't check", with a plain reason, except that a reference with a full journal locator (journal, volume,
  page, year, read with its links and DOIs taken out, so a bare DOI's "10" is not a page) is Not found once every required
  source has answered. When that DOI was its only identifier, the titled locator lookup below runs for it as for a
  reference with no identifier. A record of any text (an article, a preprint, a
  report) stays Wrong ID.
- **"Genuine author agreement"** means both author lists are non-empty and overlap. If the parser found no authors, at least two of the record's surnames must appear in the author part of the citation text. Variants count: diacritics, ue/ü, particles, the last word of the surname.

##### When a reference may be Not found

- **Not found needs a venue.** A reference that nothing matched is Not found only if it says where it was published: a
  venue word, "In ...", an identifier, a number outside its title that is not a date (volume, pages, article number)
  or a version (a "v" with a dotted number, "version 3.1", three dotted parts such as "0.9.2": which draft, not where;
  "21.3" may be a volume and issue and still counts), or, after its title, a known conference or journal acronym ("ICLR 2021", "PNAS"), a journal abbreviation ("Phys. Rev.
  Lett.", "Nat Mach Intell. 2021") or a journal's name from a curated list ("Neural Computation", "The Lancet",
  "Bioinformatics"). A name the list does not know is not a venue: "Cisco Systems", "Bureau of Labor Statistics" or
  "Uber Engineering" end like journals, and "Towards Data Science" or "Science Daily" hold a venue word. One that names none of these, or calls itself a technical report,
  white paper or manual, is "Can't check" ("Not in Crossref, arXiv, OpenReview or OpenAlex, and no journal or
  conference could be read from it: ..."): such works are often not listed there.
  A reference that says after its title that it is a talk (a talk, keynote, invited talk, tutorial, lecture, slides or
  presentation), or that names there only the "Proceedings from" a meeting (not "Proceedings from Proceedings of ..."),
  is "Can't check" too, whatever meeting it names: talks are in none of these databases. So is one that opens its title
  with such a word set off by a colon or a spaced dash ("Bottou, L. Invited talk: Two big challenges in machine
  learning. ICML 2015."). Only when nothing after the title is a page, volume or number (dates such as "7 July 2015",
  "July 6-11" or "2015-07-07" and ordinals aside; for "Proceedings from", only years, ordinals and "Month D, YYYY") and
  the reference has no identifier. A journal or "Proceedings of" volume after the title makes it a paper, unless the
  reference names itself a talk in a sentence of its own, before the title as above or after it ("Keynote talk. In
  Proceedings of ...", "Tutorial, In Proceedings of ...", "Keynote address given at ..."): a keynote or tutorial is often
  cited with the meeting's proceedings. An invented paper cited exactly so, with no pages or volume, is Can't check: a
  residual, accepted. A sentence that only opens with a talk word ("A tutorial review.", "Keynote speakers and ...") or a
  title that does ("Talk is cheap: ...") is not such a designation. Only the text after the title and the title's opening
  are read, and nothing when the parsed title cannot be found in the reference. A venue's name ("Communications Surveys
  & Tutorials", "Tutorial Abstracts", "SIGGRAPH 2019 Talks", the book series "Lecture Notes in ...") and a paper's
  designation ("oral", "spotlight", "poster", "contributed", "long" or "short" talk or presentation) are not talks;
  "invited talks" and "TED Talks" are.
  A talk about software cited with its code repository ("M. Macklin, Warp: A high-performance Python framework for GPU
  simulation and graphics. NVIDIA GPU Technology Conference (GTC), https://github.com/NVIDIA/warp, 2022.") is "Can't
  check" too: a link to GitHub, GitLab or Bitbucket, a technology meeting after the title (GTC, "... Technology
  Conference", "... Summit", "... Developer Conference", "DevDay") and, the meeting's name taken out, no proceedings,
  journal, conference acronym, identifier or number but dates. An invented paper with a repository link "In Proceedings
  of ..." or with a volume and pages stays Not found; one cited exactly as such a talk is Can't check (accepted).
  A titled paper from before 1970 that nothing matched is "Can't check" ("... it was published before 1970: older journals
  are often not indexed there"; Banzhaf, Rutgers Law Review 19, 1965; Lifshitz and Kosevich, Sov. Phys. JETP 2, 1956):
  in the evaluation's stored runs every such reference of those years is a real classic in a journal no database holds,
  while the dozens of others of those years were found. Only with no identifier, no year of 1970 or later anywhere in the
  reference, and no other work after its title (a clause opening with a word after a semicolon, or a person named after
  a separator), so an invented paper does not borrow an old year from a real reference run into it. Its journal locator
  is still looked up as for a Not found (below), and can verify it. No list of journals decides: an invented paper given
  an old year is Can't check (accepted); one with a later year stays Not found. Unindexed proceedings, workshops and
  company reports of later years (EAMT 2022, some PMLR volumes) keep their verdicts.
  A chapter cited in its book ("D. V. Cross On judgments of magnitude. In R. D. Wegener (Ed.), Social Attitudes and
  Psychophysical Measurement, pp. 73–88.": "In" and a capital right after the title, the book's pages or editors after
  it, its editors ("(Ed.)", "(eds.)", "ed. by", "edited by", "Eds.") or a publisher (a known name, or "Press", "Verlag",
  "Publishers", "Publishing") together with a book word ("Handbook", "Companion", "Encyclopedia"), and no number besides
  those pages, dates and years) is "Can't check" when nothing matched it ("Looks like a chapter in a book, ..."): these
  databases often list the book and not its chapters. Pages alone are no sign of a book: natbib cites a proceedings
  volume the same way ("In Artificial Intelligence and Statistics, pp. 1273–1282. PMLR"), and a publisher alone is how a
  proceedings volume published as a book is cited ("In Algorithmic Learning Theory, pp. 1–20. Springer, 2010."), so
  both stay Not found. A journal, proceedings or preprint word, a meeting, a book series, a volume, a conference acronym
  (PMLR among them), the name of a proceedings volume that holds no venue word ("Artificial Intelligence and
  Statistics", "Uncertainty in Artificial Intelligence", "... Learning Theory", "Medical Image Computing", "Knowledge
  Discovery", "Theory of Cryptography", "Computer Aided Verification", "Findings of the Association for Computational
  Linguistics") or a journal's name or abbreviation after "In" keeps it a paper, and Not found, so an invented journal
  paper does not escape by adding "In" (as with "In Proceedings of ..."). So is a paper in a report series ("Philosophy and
  Probability Working Paper 6", "Staff Report 1234"), with the report reason, when the text after the title, the series
  and its number taken out, names no journal, proceedings or preprint and holds no number but dates: "Journal of
  Philosophy Working Papers 12(3), 45–67" names a journal and pages and stays Not found. A series that registers a DOI
  with Crossref for every paper (NBER or N.B.E.R., the World Bank or its "Policy Research Working Paper", the IMF, IZA,
  CEPR, the Federal Reserve, FRB, FRBSF or "Finance and Economics Discussion Series", BIS, the ECB) is not one of these:
  "NBER Working Paper 12345" that nothing matched stays Not found. An invented chapter or working paper shaped
  exactly like a real one is Can't check: a residual, accepted.
  A note field ("Note: ..." after the title, the last part of an entry) is not a venue, and neither are the words and
  numbers in it (a title that opens with "Note:" is a title, not a note); nor is
  a publisher whose name holds a venue word ("Springer Nature", "Elsevier Science"). An identifier in a note still counts.
  Legislation (a designation such as "Directive (EU) 2023/959" or "Regulation (EC) No 1907/2006" as its title, or an
  official gazette after the title: "Official Journal of the European Union", "OJ L 130", "Pub. L. No. 117-169", "Public
  Law 117-169", "U.S.C.", "136 Stat."; the law journal "Public Law" is not a gazette),
  a dataset named by its identifier ("Product ID: ...", "DATASET_ID", "[Data set]") and an agency's document (OECD, IMO,
  IEA, the World Bank, the European Commission, Copernicus and the like as its only author) are "Can't check" as well when
  nothing matched them. Only with no identifier, and only when the text after the title, once the note, the gazette
  citation, the dataset codes and the document numbers ("Resolution MEPC.377(80)", "Report No. 12") are taken out, names
  no journal, proceedings, conference or preprint (nor a journal's usual first word: "Nature", "Science", "Advances in",
  "Proc.", "Trans.") and holds no number but dates. When the parser took the agency for the title, the work's own title
  is the text up to the next full stop or comma, unless that names a journal. So an invented journal paper by an agency,
  about a directive or about a dataset still names its journal and volume, and stays Not found.

##### Comparing titles and picking a match

- **A near miss by the cited authors is Details differ.** Below the candidate title score, a search result still counts
  as a close match when its title holds at least 90% of the cited title's content words (4 or more), two of the first
  three cited authors are on it and the years agree. It is never Verified or Retracted.
- **The record may show how to read the reference.** When the parser left the authors inside the title ("O.J. Ganor
  and A. Hanany, Small E(8) instantons ..., Nucl"), cut the title at a full stop, or kept a volume on it, the reference
  is read again with the record in hand, the same way for scoring candidates (when no author list was parsed), for the
  verdict and for the retraction lookup. The re-read only moves the reference's own words between its title, author
  and venue parts: the words that leave the title must be the record's authors' names (with initials and given names
  next to them) or a venue fragment, set apart from the title by the reference's punctuation. A venue fragment is at
  most three capitalised words, opening with a journal's usual first word ("Nucl", "Phys", "J") and with no comma
  inside, each abbreviated (six letters or fewer and a full stop), an acronym or a venue word, with no sequel numeral,
  "Part", notice or number word, and it must run straight into the venue the parser read
  ("Nucl" + ". Phys. B"); "a review", "revisited", "Part II", "three loops" or "Erratum" stay in the title. Words the
  parser cut off after the title stay with it for the comparison when they read as more of it and a venue follows
  them at once: a sequel, notice, number, survey or "revisited" word before any venue ("... strings. Part II, Nucl.
  Phys.", "... Erratum, Lancet", "... A survey. Nature"), an acronym that names no venue ("..., GNN. J. Mach."), a
  plain subtitle only before a conference's venue ("... need. A survey of graph applications. In NeurIPS"); notes
  ("Best paper award.", "Code and models released.") are not, and neither is BibTeX's note field ("... AI review. Note:
  arXiv preprint 2609.25525", in any case, or "Notes:"). The re-read never takes a word from the record.
- **A citation may drop a subtitle, not add one.** "X" against a record "X: Y" is a match; "X: Y" (or "X - Y")
  against a record "X" scores below the Verified threshold ("Attention is all you need: Part II", "...: a follow-up"):
  Details differ at most, and never a strong match, so another work's retraction is never shown. A correct citation
  whose record lacks its subtitle is Details differ. A main title of one or two words cited without the record's
  subtitle ("MapReduce" for "MapReduce: simplified data processing on large clusters") counts only when the cited
  authors agree as Verified needs, the cited year agrees and no title-like clause other than the record's subtitle
  follows it; it is then enough for Verified but no strong match (no retraction lookup) unless the reference also
  gives the record's volume and first page. Across sources, a candidate that agrees well enough for Verified is
  preferred to one whose title is only closer, unless it is marked retracted.
- **Some search results the cited title says nothing about.** An organisation named as the author and read as the
  title ("U.S. Securities and Exchange Commission (2026). Tidal Trust V, ...": it opens the reference, the year follows
  it, and it is an agency's name or capitalised words with an organisation's word such as "Commission", "Bank" or
  "Department") matches records titled after the organisation, never the work: no search result is matched by it. A
  research group named so (a consortium, a collaboration, "Collaborators", "Investigators", a research, study, writing,
  trial or collaborative group, a research network: "Open Science Collaboration (2015). Estimating the reproducibility
  of ...", "1000 Genomes Project Consortium (2015). ...", "SPRINT Research Group (2015). ...", "Cancer Genome Atlas
  Research Network (2008). ...") that nothing matched is Can't check, never Not found: the search had only the group's
  name. "Network" alone is not a group's word ("Graph Attention Network (2018). ..." is a title written first). The
  accepted cost is that an invented paper credited to such a group is Can't check too; an
  agency's name in the same place ("World Health Organization (2019). <title>. The Lancet ...") keeps Not found. A
  cited title found inside a record's title after words the citation does not give, and covering less than two thirds
  of it ("A path towards autonomous machine intelligence" in "Introduction to Latent Variable Energy-Based Models: A Path
  Towards Autonomous Machine Intelligence"), scores below a candidate: it is not a match on its own, though the cited
  authors and year can still make it a near miss (Details differ at most). Either way the search goes on, and with no
  other match the reference is judged as if nothing matched it (Can't check or Not found by the rules above), never
  Details differ against another work. A record that only adds a subtitle ("X" for "X: Y") or a short leading name
  ("BERT: ...") is still a match, and so is one that opens with a notice or section label ("RETRACTED ARTICLE:",
  "Retracted:", "Retraction:", "Withdrawn:", "Erratum:", "Correction:", "Perspective:", "Editorial:", "Commentary:",
  "Review:") and ends with the cited title after its last colon ("Perspective: Machine learning: protein folding at
  scale"). A record reached by the cited identifier is judged as before.
- **Same title, other work.** Candidates are ranked by a key, so the pick never depends on the order a service lists
  them in: a candidate whose authors agree with the reference ranks above any other, however much closer the other's
  title is (the cited authors' "Generative adversarial nets" of 2014, not a 2023 book chapter of that name by someone
  else); within a rank the title decides, then the authors, then the year. A record
  whose author list is implausible (every name on it has no letter or is a single Latin letter: "1", "a"; a name in any
  other script, such as a one-character Chinese family name "王", is a name) is weak evidence on a search: it ranks
  below any other candidate, is never Verified or Retracted there, its list is never shown as differing from the cited
  authors, and when its title is below the Verified threshold the reference is "Can't check", not Details differ or Not
  found. A record reached by the cited identifier is judged as any other.
- **A retracted record that is only a close match is never Verified.** A strong match is Retracted as above; any other
  match on a record marked retracted is Details differ, with the note "the closest record found has been retracted, but
  it may not be the cited work". A match whose record is itself marked retracted is never Verified while the retraction lookup cannot
  answer: it is "Can't check" ("The matched record is marked as retracted, but the retraction notice couldn't be looked
  up. Try again later"), on every path; once the lookup answers, the rules above apply.
- **A word and its negation are not the same title.** "critical" and "noncritical", "supervised" and "unsupervised"
  are a few letters apart and the opposite claim: such titles score below the Verified threshold.
- **A notice is not the work.** "Addendum to X", "Erratum: X", "Comment on X", "Reply to X" and the like are close to
  X but never the same title, in either direction.

##### Books, reports and unreadable titles

- **Books, theses, ISBN-bearing proceedings and IACR ePrints** with a real title get one Crossref title search. It can
  only make them Verified (a confident match with no field differing, never a retracted record, and a record that lists
  people, one of whom the reference names when it names anyone); anything else leaves the Can't check they had. This
  path never gives Not found, Wrong ID, Details differ or Retracted, and never uses OpenAlex. "Cambridge U. Press",
  "Univ. Press" and a page or volume after a press imprint mark a book; an author called Press ("W. H. Press, ...")
  does not.
- **The reason says what a reference calls itself.** A web reference that calls itself a report ("Virgo Project Technical
  Report No. ...", "MIT Report No. 105, ..., https://...") says "Looks like a technical report"; one marked unpublished, in
  preparation or a private communication says so instead of the book reason (a thesis keeps it). Wording only: the
  status, and the one Crossref title search such a reference may get, are as before.
- **No OpenAlex search for a "title" that could never be Not found** (names, a venue, a line cut short): OpenAlex is
  metered, and such a reference is "Can't check" (not readable) unless a free source matched it.

##### Journal citations without a title

- **Title-less journal citations** ("J. Roe, Phys. Rev. Lett. 98, 100401 (2007)") are looked up in Crossref by their text. When
  none of those answers matches (with "et al." the query is weak and errata of the same volume can fill them), Crossref is asked once
  more: for APS journals and the IOP journals whose DOIs are built from the locator (Class. Quantum Grav., New J. Phys.,
  J. Phys.: Condens. Matter, J. Phys. A, while they used six-digit article numbers), the record of that built DOI; for others,
  the same search with the first author's surname. These answers only join the candidates: a built DOI is never treated as an
  identifier the reference gave, and a record of another article fails the match below. They are
  Verified only if exactly one record has the same volume, the same first page or article number, a year within tolerance of one of its
  dates, a compatible journal name (abbreviated or in full) and, when the reference names authors, at least one matching surname;
  a retraction on such a record is reported as Retracted. Everything else stays "Can't check": this path never gives Not found or Wrong ID.
  The title-less reading takes every word in front of the volume for the journal's name, so a title written before the
  journal with a full stop, a colon or nothing between ends up there ("..., Dark matter from locked quarks. Nucl. Phys.
  B537, 443 (1999)."). With the matched record in hand (by this locator, or by a DOI in the page's place), the words in
  front of the name that the record's journal names do not account for, word by word as above, are a title however they
  are written (in capitals, as one short word): only initials, "et al.", joining words ("The European Physical Journal
  B"), the record's own surnames closed by a full stop or comma, and one publisher's acronym right before the name
  ("ACS.", "RSC.") are set aside. A title cut from the names by a comma and read as the end of the author list
  ("..., and F. Wilczek, DARK MATTER FROM LOCKED QUARKS, Nucl. Phys. B537, ...") is one too: the pieces between the last
  name and the journal that have no initial, bracket, group word ("Collaboration") or surname of the record and are more
  than one word. The title is compared as any cited title: the record's own is Verified, another one is
  Details differ (or Wrong ID, by the identifier rules, when the names are not the record's either), never Verified;
  names the record does not list keep a DOI entry's identifier-only verdict even when the title is the record's. When no
  journal name of the record fits and the words in front could be a title (anything but abbreviations, series letters,
  acronyms, initials, joining words and a journal's usual words), the reference is "Can't check".
  When Crossref answered and no record in its answers has that volume, first page and year, the reason says so ("The
  journal, volume and page were read, but no Crossref record was found there"); older, regional and smaller journals are
  often missing from Crossref. A failed request, or a record there that is another article, keeps "Couldn't read this
  reference reliably".
  The journal's name is compared word by word, each cited word abbreviating one of the name's ("Phys." for "Physical"), a
  one-letter initial only "J." or "Z." unless at least three other words of the name match ("Mon. Not. R. Astron. Soc.",
  "Proc. R. Soc. A"); the citation may leave out the place in the name ("of London") and whatever follows the series
  letter ("Proceedings of the Royal Society of London. A. Mathematical and Physical Sciences" is "Proc. R. Soc. A"), and may
  add "Lett." or "Letters" when the page is a letters page ("Astrophys. J. Lett. 528, L17" against The Astrophysical
  Journal, page L17). A short dotted word right in front of the name ("Phys.") means a longer name, so "Phys. Rev." is
  never taken for "Rev.".
  One bracketed place name after the journal's words is part of the citation's venue, not of the journal's name ("Nature
  (London) 227, 936 (1970)", "Ann. Phys. (N.Y.)", "J. Phys. (Paris)"), and the entry may end with a comma or a semicolon
  ("Phys. Rev. D 89, 024003 (2014),").
  A Nature-style entry ("Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. B 86, 104412 (2012).") is
  searched by its title; when that ends in Not found or in the unreadable Can't check (a two-word title such as
  "Geometrical frustration"), and the entry read without its title has a complete journal locator, it is looked up by
  that locator the same way. Only Verified or Retracted can come of it (or, when the locator request fails, "Can't
  check" in place of Not found), and only for a record that also carries the cited title (as Verified asks of a title), or for one whose journal name accounts for the "title": every word from the
  "title" to the volume stands in one of the record's journal names, in order, from its first word, whole or as its
  abbreviation ("Zeitschrift für anorg. Chemie" in "Zeitschrift für anorganische und allgemeine Chemie"; an initial
  right before it may open the name, "J. reine angew. Math."). The "title" is then the journal's, and the record must
  still carry the volume, page and year and list an author the entry names. An invented title on a real article's
  locator keeps the title path's verdict: the record's journal ("Physical Review B") does not account for "Emergent
  photons and the unreasonable effectiveness of math". When the title path says Not found but the "title" may be the
  journal's, the entry is "Can't check" ("Couldn't read this reference reliably") instead: a record holds the volume,
  page and year and its journal name accounts for the "title" (another author, say), or no record holds them and the
  "title" is shaped like the start of a journal's name. That shape is two to five words, the last a short lower-case
  word, at most one other lower-case word that is not a particle, and a journal's opening: either a head noun of old
  journal names first (Zeitschrift, Journal, Annals, Annalen, Archiv, Archive, Archives, Berichte, Bulletin, Comptes,
  Proceedings, Transactions, Rendiconti, Acta, Mémoires, Memoirs, Monatshefte, Nachrichten, Abhandlungen,
  Sitzungsberichte, Izvestiya: "Zeitschrift für anorg", "Archive for rational mech"), or a lower-case word right after
  a journal's initial "J." or "Z." that follows the author's own initial ("Weil, A. J. reine angew."). A short title in
  sentence case on an invented locator ("Quantum spin ice", "Primordial black holes") stays Not found. An invented
  title that opens with one of those nouns ("Journal of quantum ice") on a locator no record holds is Can't check: a
  narrow residual, accepted.
  Any other titled reference with no identifier and a complete journal locator that the title path leaves Not found
  ("C. Petrovic, ..., Heavy-fermion superconductivity in cecoin5 at 2.3 k, Journal of Physics: Condensed Matter 13, L337
  (2001).", which no title search ranked) gets one more Crossref request, by that locator: the further request above
  (the built DOI, or the search with the first author's surname), or, when that has nothing to go on (no author before
  a comma: "G. E. Hinton and R. R. Salakhutdinov. Title. Science 313, 504"), the first one; never both. A record found there counts only if
  it carries the whole locator, as above, and the cited title, as Verified asks of a title; it is then judged as any
  search match (Verified, Details differ or, as a strong match through the usual lookup, Retracted). A record at the
  locator with another title is ignored, so an invented title on a real article's locator stays Not found, and never
  Wrong ID or Details differ on the title. A request that fails leaves the reference "Can't check", as a failed source
  does.

##### Identifiers and entries that cite several works

- **Identifier-only references that contradict the identifier** (different named authors, or a year out of tolerance) → "Can't check" ("Couldn't confirm the identifier matches this reference"), never Retracted.
- **One work at a time.** An entry that cites more than one work under one number ("E. Goetz et al., in Gravitational
  Waves: Proceedings ..., 2009; E. Goetz and R. L. Savage Jr., Classical Quantum Gravity 27, 084024 (2010).") is "Can't
  check" ("This entry cites more than one work, and RefSure checks one work at a time") before any lookup: its title,
  venue, numbers and identifier may each be another work's, so read whole it is never Not found or Wrong ID, and never
  Verified on one of its works alone (it has no journal locator either). One exception keeps an appended work from
  hiding an invented one: when the entry's first part is a complete work on its own, that part alone is checked. The
  first part runs to the end of the entry's first journal locator, or of its first identifier with a year ("arXiv:...
  (2010)"), and the identifiers after it (its DOI, its arXiv id), whatever comes next: "; ", ";", ", ", ". " or " and ", then another author list or another locator. It is complete when
  that locator or identifier, with its year, is its own (no other author list and no volume and page without a year come before it, so
  a first work whose year is left out is never read with the second work's) and it has its own identifier or a credible
  title. When the cut is not clear the entry keeps the plain Can't check. Its Not found, Wrong
  ID, Retracted or Details differ stand, with a reason that says they are about the first work in the entry; its Verified
  is shown as Can't check ("The first work in this entry was found, but the entry cites more than one work ..."), and
  its Can't check as the entry's own. Such a result is not cached. A first part with no locator of its own ("E. Goetz et
  al., in Proceedings ..., 2009;", or a titled proceedings paper) keeps the plain Can't check. It cites several works when, after a semicolon that follows
  a year, a clause opens with another list of names (initials first) and goes on to a venue with a number, or when it
  holds two journal locators ("27, 084024 (2010)", "B 72 (1974) 461") with different years. An erratum, addendum,
  corrigendum, reprint or translation of the same work ("[erratum: Commun. Math. Phys. 46, 206 (1976)]", "; 74,
  019901(E) (2006)", "; B 48, 463 (1967) [erratum]", "; 84, 029901 (2011) (E)", "; Phys. Rev. D 84, 029901 (2011) (Erratum to
  ...)", "Note: [Addendum: ...]") is not a second work; nor is a bracketed
  part that holds only a journal locator, with no names and no title words ("[Int. J. Theor. Phys. 38, 1113 (1999)]",
  "[Sov. Phys. JETP 20, 1018 (1965)]"): that is the same article printed again. A note marks only itself: the note
  field, the bracket with its own locator, the locator a note word stands in or next to, or the clause that opens with
  it ("; Erratum-ibid. 96, ..."). It never hides another clause's author list, or the locator of another work: "...;
  E. Goetz and R. L. Savage Jr., Classical Quantum Gravity 27, 084024 (2010) [Erratum: ...]" still cites several works,
  and a note word in the first work's title ("machine translation") marks nothing. A bracket that names a person, even
  by surname alone ("[Smith, Phys. Rev. Lett. 107, 2 (2011)]"), is another work. A semicolon between names ("Belkin, M.; and Niyogi, P. 2003.") and Vancouver's
  "2009;36(3):4626" are not either.
- **Bare identifiers bypass the parse-confidence gate**, for references of ≤ 1000 characters. A longer one is looked up
  by its identifier only when it reads as one work: one identifier, one year, and no second list of names after the
  first one's (several references run together would otherwise be checked by one of theirs). A bracketed eprint
  ("[2201.04634]") counts only when the entry prints one.

### 7.3 Interface

- **Toolbar button**: click → opens the side panel and starts the check on
  the current tab, unless that paper already has a run (then it only opens
  the panel; Re-check forces a new run). On unsupported pages it explains
  where it works. Stop keeps the rows and badges found so far.
- **Side panel** (Chrome/Edge `sidePanel`; Firefox `sidebar_action`):
  - Header: paper title, progress bar while checking, then totals
    ("40 verified · 2 with different details · 1 not found · 1 retracted · 3 couldn't be checked").
    A stopped check counts what it checked ("5 of 40 references checked: 5 verified") in its report.
  - Notices above the list, all calm and info or warning tone:
    - A source that ran out of lookups (OpenAlex's daily budget, or a rate limit) is announced once while the check runs:
      the references it would have decided show as Can't check.
    - A required source that was down for some references, not all, is announced once when the check ends.
    - A required source that asked RefSure to wait (a long Retry-After) is named with the local time RefSure tries it
      again, while the check runs and after it ("Crossref asked RefSure to wait, so references that need it show as
      Can't check. RefSure will try it again after 19:42."), in place of its "limit reached" or "couldn't reach"
      notice, until that time has passed. When the run stops early, the "not answering" banner says it instead: "...
      Crossref asked RefSure to wait. RefSure will try it again after 19:42."
    - **Early stop:** after 5 references in a row whose required sources all failed (not clean misses, not offline), the
      run stops by itself, keeps the rows found so far, offers Try again and the partial exports, and says the databases
      are not answering and that this is not a problem with the paper. Nothing is cached or saved for such a run.
      The stop is decided only that way, so a run never stops while a required source still answers. To reach it
      sooner in a real outage, lookups are sent once each, without retries, while every required source is failing:
      each has failed two lookups in a row (lookups in flight together count once) or fails for the whole run (a
      Retry-After wait, a spent budget, a bot check seen twice). A source of the second kind never counts alone while another
      required source has not failed. Any answer, from any source, clears every count and brings the retries back.
      When every required source but one fails for the whole run and that one fails for a passing reason (a network
      error, a timeout, a server error, a rate limit with no long wait), it is the run's only way to an answer: its lookups keep their retries (within
      the same limits, every Retry-After honoured, nothing sent to a blocked source), and the stop also waits until its
      references have been failing for a minute, so a short outage of it does not end the run and a lasting one still
      does. Whatever the clock says (it can stand still or jump back), that wait also ends after twenty references in a
      row with no answer. A source counts as failing for the whole run until it answers itself; an answer from another source does not
      lift its wait, budget or bot check.
  - Filter chips by status; problems listed first.
  - Each row: reference number + short citation, status, one-line reason,
    "Open matched paper" link, expand for side-by-side details. The link is the
    match's DOI (or arXiv, or OpenReview) page; a match with none of those, found
    only in OpenAlex or DBLP, links to that record's public page
    (`openalex.org/works/W…`, `dblp.org/rec/…`), in the panel and in the exports.
  - Show on page (HTML pages) scrolls the page to that reference and briefly outlines its badge; a click on the
    row does the same.
  - Actions: Copy report · Export CSV · Export JSON · Re-check.
- **Inline badges** (arXiv HTML pages only): small, unobtrusive, placed at the end of each
  reference entry, rendered in an isolated container so the site's styles
  can't break them and they can't break the site. Hover shows the reason;
  click opens that row in the panel. On Chrome and Edge the click also opens
  the panel when it is closed (a click in the page counts as the user's action
  for `sidePanel.open`), for a tab whose run drew the badges; only the reader's
  own click counts, never one a script makes. Firefox opens the sidebar only from RefSure's own
  button, not from a click in a web page, so there the row opens only when the
  sidebar is already open.
- **Settings**: auto-check on arXiv / OpenReview (off by default), clear history, history
  on/off. A collapsed **Advanced** section holds one optional field: "Your
  own free OpenAlex API key" (stored locally only, raises the daily search
  budget). Nothing else. Turning history off also stops the result cache
  and deletes saved checks; clearing history runs in the background.
- **Private windows**: RefSure is disabled in incognito/private windows
  (`"incognito": "not_allowed"`), so nothing read privately is ever stored.
- **First-run**: a single short welcome screen: how to use RefSure, what the six results mean, and that the
  developer receives nothing (reference details go only to the listed databases).
- Accessibility: keyboard navigable, screen-reader labels on badges, colour
  never the only signal (icons + text), respects light/dark mode.

### 7.4 Storage

All local, in extension storage: cached lookup results (keyed by DOI/arXiv
ID/normalized citation, with an expiry so retractions are re-checked), past
check summaries per paper, and settings. Nothing synced to any server.
Settings can clear history and the cache, and remove the OpenAlex key.

## 8. Security posture (summary; the full rules are in SECURITY.md)

- Least privilege: host access only to arxiv.org, openreview.net and the
  lookup API domains (Crossref, OpenAlex, arXiv, DBLP, OpenReview API);
  `activeTab`, `storage`, the side panel (and `offscreen` on Chrome and Edge for
  parsing fetched HTML and PDF).
- All page content and API responses are untrusted: never inserted as HTML,
  rendered as text only, and response shapes are validated.
- No `eval`, no remote scripts, a strict extension CSP, no third-party
  analytics, minimal and pinned dependencies, a committed lockfile and a
  dependency audit in `npm run verify`.
- Network: HTTPS only, request timeouts, a concurrency limit, backoff on rate
  limits, and a polite identification to APIs as their terms ask (the project
  contact, never the user's details).

## 9. Tooling

- TypeScript (strict) and WXT, which builds the Manifest V3 packages for Chrome, Edge and Firefox.
- pdf.js (`pdfjs-dist`) reads PDFs. It is the only runtime dependency and ships inside the package.
- The panel is plain DOM, with no UI library.
- Vitest with happy-dom for unit tests, Playwright (Chromium, network faked) for end-to-end tests, ESLint with
  typescript-eslint, and tsx to run the accuracy evaluation.
- Matching thresholds live in `src/core/thresholds.ts` and are tuned against the evaluation set.

## 10. Quality bar for release

Measured by `npm run eval` (`tests/eval/README.md`) on a fixed set of real public papers (arXiv HTML, arXiv PDF-only,
and OpenReview papers read through their arXiv version), plus known-retracted papers and deliberately corrupted
citations (wrong year, swapped authors, wrong DOI, invented titles).

| Path | Real references wrongly labelled Not found / Wrong ID | Real references labelled Details differ wrongly | Can't check |
|---|---|---|---|
| arXiv HTML | ≤ 1% | ≤ 5% | ≤ 10% |
| PDF paths (arXiv PDF-only, OpenReview) | ≤ 2% | ≤ 8% | ≤ 25% |

Corrupted citations: ≥ 90% flagged (any non-Verified status). Retracted
test papers: 100% flagged Retracted.

Every check read from a PDF is labelled "Beta" in the panel, with a one-line explanation, because PDF text can be
misread. A PDF path that misses its bar therefore does not block a release. The arXiv HTML path must meet its bar on the main arXiv HTML set to ship. Held-out sets, chosen blind and
never used for tuning until a fix is drawn from them, are held to the same bar and reported apart; the README states
the latest result.
