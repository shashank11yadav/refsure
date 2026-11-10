// What a search result's title proves about a reference. An organisation named as the author, read as the title, says
// nothing about a record titled after the organisation; a short title found inside a much longer one, after words the
// citation does not give, is another work's title more often than the cited one's. Neither is a match on its own, so the
// reference is judged as if nothing matched it. A record that only adds a subtitle, or a leading name, is still a match.
import { describe, expect, test } from 'vitest';
import { classify, isConfidentMatch, isStrongMatch, pickBest } from '../../../src/core/classify';
import { parseCitation } from '../../../src/core/parseCitation';
import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { ParsedCitation, WorkRecord } from '../../../src/core/types';

const parse = (text: string): ParsedCitation => parseCitation({ index: 1, label: '[1]', text });
const rec = (o: Partial<WorkRecord> & { title: string; authors: string[] }): WorkRecord => ({ source: 'crossref', isRetracted: false, notes: [], ...o });
const bySearch = (c: ParsedCitation, match: WorkRecord) => classify({ citation: c, match, matchedVia: 'search', searched: [...REQUIRED_SOURCES], failed: [] });

describe('an organisation named as the author is no title', () => {
  // A filing whose author the parser read as its title, found in Crossref as a reference-work entry named the same.
  const SEC = parse('U.S. Securities and Exchange Commission (2026). Tidal Trust V, post-effective amendment no. 44 to Form N-1A. SEC accession no. 0001999371-26-018439.');
  const entry = rec({ title: 'Securities and Exchange Commission', authors: [], venue: 'SpringerReference', doi: '10.1007/springerreference_2448' });

  test('the entry named after the agency is no candidate, and the reference is not Details differ against it', () => {
    expect(pickBest(SEC, [entry])).toBeUndefined();
    expect(isConfidentMatch(SEC, entry, 'search')).toBe(false);
    expect(isStrongMatch(SEC, entry, 'search')).toBe(false);
    expect(bySearch(SEC, entry).status).toBe('cant_check');
  });

  test.each([
    ['World Bank (2024). State and trends of carbon pricing 2024. Washington, DC.', 'World Bank'],
    ['U.S. Department of Energy (2022). Grid energy storage technology cost and performance assessment. Washington, DC.', 'U.S. Department of Energy'],
    ['European Central Bank, (2021). Climate-related risk and financial stability. Frankfurt.', 'European Central Bank'],
  ])('a record titled after the organisation is no match: %s', (text, name) => {
    const c = parse(text);
    const named = rec({ title: name, authors: [] });
    expect(pickBest(c, [named])).toBeUndefined();
    expect(bySearch(c, named).status).not.toBe('details_differ');
    expect(bySearch(c, named).status).not.toBe('verified');
  });

  // Consortium and collaboration papers name the group where the authors go. Read as the title, the group's name is
  // all the search had, so nothing found for it says nothing about the work: Can't check, never Not found.
  test.each([
    'Open Science Collaboration (2015). Estimating the reproducibility of psychological science. Science, 349(6251), aac4716.',
    'International Human Genome Sequencing Consortium (2001). Initial sequencing and analysis of the human genome. Nature 409, 860–921.',
    'The Gene Ontology Consortium (2019). The Gene Ontology Resource: 20 years and still GOing strong. Nucleic Acids Research, 47(D1), D330–D338.',
    'Wellcome Trust Case Control Consortium (2007). Genome-wide association study of 14,000 cases of seven common diseases and 3,000 shared controls. Nature, 447, 661–678.',
    '1000 Genomes Project Consortium (2015). A global reference for human genetic variation. Nature, 526, 68–74.',
    // Clinical and genomics groups are named with other words, and write papers the same way.
    'GBD 2019 Diseases and Injuries Collaborators (2020). Global burden of 369 diseases and injuries in 204 countries and territories. The Lancet, 396, 1204–1222.',
    'SPRINT Research Group (2015). A randomized trial of intensive versus standard blood-pressure control. N Engl J Med, 373, 2103–2116.',
    'The Diabetes Control and Complications Trial Research Group (1993). The effect of intensive treatment of diabetes on the development and progression of long-term complications. N Engl J Med, 329, 977–986.',
    'Cancer Genome Atlas Research Network (2008). Comprehensive genomic characterization defines human glioblastoma genes and core pathways. Nature, 455, 1061–1068.',
    'Writing Group for the Women\'s Health Initiative Investigators (2002). Risks and benefits of estrogen plus progestin in healthy postmenopausal women. JAMA, 288, 321–333.',
    'ALLHAT Officers and Coordinators for the ALLHAT Collaborative Research Group (2002). Major outcomes in high-risk hypertensive patients. JAMA, 288, 2981–2997.',
    'Heart Protection Study Collaborative Group (2002). MRC/BHF Heart Protection Study of cholesterol lowering with simvastatin. The Lancet, 360, 7–22.',
  ])('a group named as the author, with nothing found, is Can\'t check: %s', (text) => {
    const v = classify({ citation: parse(text), searched: [...REQUIRED_SOURCES], failed: [] });
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/research group/);
  });

  // The accepted cost: an invented paper credited to a consortium is Can't check too. An agency's name in the same
  // place keeps Not found (the core adversarial suite).
  test.each([
    'Sparse Routing Study Group (2021). Sparse mixture routing for vaccine supply chains. The Lancet 393, 12–20.',
    'Sparse Routing Research Network (2021). Sparse mixture routing for vaccine supply chains. Nature 593, 12–20.',
    'Sparse Routing Trial Investigators (2021). Sparse mixture routing for vaccine supply chains. JAMA 325, 12–20.',
  ])('an invented paper credited to a research group is Can\'t check, not Verified: %s', (text) => {
    expect(classify({ citation: parse(text), searched: [...REQUIRED_SOURCES], failed: [] }).status).toBe('cant_check');
  });

  test('an invented paper credited to a consortium is Can\'t check, not Verified', () => {
    const c = parse('Sparse Routing Consortium (2021). Sparse mixture routing for vaccine supply chains. The Lancet 393, 12–20.');
    expect(classify({ citation: c, searched: [...REQUIRED_SOURCES], failed: [] }).status).toBe('cant_check');
  });

  test('a group named as the author with a source that failed is Can\'t check for that reason', () => {
    const c = parse('Open Science Collaboration (2015). Estimating the reproducibility of psychological science. Science, 349(6251), aac4716.');
    expect(classify({ citation: c, searched: [...REQUIRED_SOURCES], failed: ['crossref'] }).reason).toMatch(/^Couldn't search Crossref/);
  });

  // An invented paper by named people is still Not found: only a group's name in the title's place is read so.
  test('an invented paper by named authors, with nothing found, is still Not found', () => {
    const c = parse('Whitfield, J., Okonkwo, R. (2015). Estimating the reproducibility of invented science. Science, 349(6251), aac4716.');
    expect(classify({ citation: c, searched: [...REQUIRED_SOURCES], failed: [] }).status).toBe('not_found');
  });

  // Controls: a title that names an organisation, cited in the title's place, is a title.
  test('a paper titled after an organisation, by named authors, is still matched', () => {
    const c = parse('Whitfield, J., Okonkwo, R. (2020). The International Monetary Fund. Journal of Economic Perspectives 34, 1–20.');
    const r = rec({ title: 'The International Monetary Fund', authors: ['whitfield', 'okonkwo'], year: 2020 });
    expect(bySearch(c, r).status).toBe('verified');
  });

  // "Network" ends many titles: written title first, "Graph Attention Network (2018)" is still a title. Only a "Research
  // Network" is a group's name.
  test('a title-first Title Case title ending in "Network" is still matched', () => {
    const c = parse('Graph Attention Network (2018). In ICLR.');
    const r = rec({ title: 'Graph Attention Network', authors: [], year: 2018 });
    expect(pickBest(c, [r])).toBe(r);
  });

  test('a title-first reference whose title is no organisation\'s name is still matched', () => {
    const c = parse('Attention is all you need for sparse mixture routing (2017). In NeurIPS.');
    const r = rec({ title: 'Attention is all you need for sparse mixture routing', authors: [], year: 2017 });
    expect(pickBest(c, [r])).toBe(r);
  });
});

describe('a short title found inside a much longer one is no match on its own', () => {
  // A position paper cited by its title, against the same author's longer paper whose subtitle repeats it.
  const LECUN = parseCitation({
    index: 1,
    label: '[1]',
    text: 'Y. LeCun A path towards autonomous machine intelligence. OpenReview [Position paper] 0.9.2.',
    blocks: ['Y. LeCun', 'A path towards autonomous machine intelligence.', 'OpenReview [Position paper] 0.9.2.'],
  });
  const longer = rec({
    source: 'arxiv',
    title: 'Introduction to Latent Variable Energy-Based Models: A Path Towards Autonomous Machine Intelligence',
    authors: ['dawid', 'lecun'],
    year: 2023,
    arxivId: '2306.02572',
  });

  // Judged as if nothing matched: "0.9.2" is the paper's version, not a volume, so no journal is read and it is Can't check.
  test('the longer paper is no candidate, and the reference is not Details differ against it', () => {
    expect(pickBest(LECUN, [longer])).toBeUndefined();
    expect(isConfidentMatch(LECUN, longer, 'search')).toBe(false);
    expect(bySearch(LECUN, longer).status).toBe('cant_check');
  });

  test('an invented short title inside a real record\'s longer title is not matched', () => {
    const c = parse('Vaswani, A. (2017). Attention is all you need. In NeurIPS.');
    const r = rec({ title: 'Transformers for long documents: when attention is all you need', authors: ['vaswani', 'shazeer'], year: 2017 });
    expect(pickBest(c, [r])).toBeUndefined();
    expect(bySearch(c, r).status).toBe('not_found');
  });

  // With two cited authors and the year on the record, a title nearly all of whose words the record holds is a near
  // miss: Details differ at most, never Verified.
  test('the cited authors and year still make it a near miss, never Verified', () => {
    const c = parse('Vaswani, A., Shazeer, N. (2017). Attention is all you need. In NeurIPS.');
    const r = rec({ title: 'Transformers for long documents: when attention is all you need', authors: ['vaswani', 'shazeer'], year: 2017 });
    expect(bySearch(c, r).status).toBe('details_differ');
  });

  // Some publishers print a notice or section label before the work's own title ("RETRACTED ARTICLE: Graph neural
  // networks", "Perspective: Machine learning: protein folding at scale"). The cited title after it is the work's own,
  // so the record is judged as before: never Not found for want of it.
  test.each([
    ['Smith, J., Lee, K. (2019). Graph neural networks. Neural Computing and Applications, 31, 1–10.', 'RETRACTED ARTICLE: Graph neural networks', ['smith', 'lee'], 2019],
    ['Smith, J. (2019). Graph neural networks. Neural Computing and Applications, 31, 1–10.', 'Retracted: Graph neural networks', ['smith'], 2019],
    ['Smith, J. (2020). Protein folding at scale. Science 368, 1–5.', 'Perspective: Machine learning: protein folding at scale', ['smith'], 2020],
    ['Smith, J. (2020). Protein folding at scale. Science 368, 1–5.', 'Editorial: Protein folding at scale', ['smith'], 2020],
  ] as const)('a cited title after a notice or section label in the record is not buried: %s', (text, title, authors, year) => {
    const c = parse(text);
    const r = rec({ title, authors: [...authors], year });
    expect(pickBest(c, [r])).toBe(r);
    expect(bySearch(c, r).status).not.toBe('not_found');
  });

  // The label must open the record, and the cited title must be all that follows its last colon.
  test.each([
    ['Vaswani, A. (2017). Attention is all you need. In NeurIPS.', 'Review: transformers for long documents when attention is all you need'],
    ['Vaswani, A. (2017). Graph neural networks. In NeurIPS.', 'Graph models: a review: graph neural networks'],
    ['Vaswani, A. (2017). Graph neural networks. In NeurIPS.', 'Perspective: graph neural networks for molecules: a survey'],
  ])('an invented short title elsewhere in a labelled record stays unmatched: %s', (text, title) => {
    const c = parse(text);
    const r = rec({ title, authors: ['vaswani'], year: 2017 });
    expect(pickBest(c, [r])).toBeUndefined();
    expect(bySearch(c, r).status).toBe('not_found');
  });

  // Controls: the cited title leads the record's, or only a short leading name is dropped.
  test.each([
    ['Vaswani, A., Shazeer, N. (2017). Attention is all you need. In NeurIPS.', 'Attention is all you need: transformers for sequence modelling'],
    ['Devlin, J., Chang, M.-W. (2019). Pre-training of deep bidirectional transformers for language understanding. In NAACL.', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding'],
    ['Liu, Z., Lin, Y. (2021). Hierarchical vision transformer using shifted windows. In ICCV.', 'Swin Transformer: Hierarchical Vision Transformer using Shifted Windows'],
  ])('a record that adds a subtitle or a leading name still Verifies: %s', (text, title) => {
    const c = parse(text);
    const r = rec({ title, authors: c.authors, year: c.year });
    expect(bySearch(c, r).status).toBe('verified');
  });
});
