// Real works that no database lists and that nothing matched are Can't check, never Not found. Invented papers dressed
// in the ordinary way still reach Not found; the shapes that an invented paper can copy exactly are stated as accepted
// costs.
import { describe, expect, test } from 'vitest';
import { classify } from '../../../src/core/classify';
import { parseCitation } from '../../../src/core/parseCitation';
import { REQUIRED_SOURCES } from '../../../src/core/types';

/** Every required source searched, nothing matched. */
const nothing = (text: string) => classify({ citation: parseCitation({ index: 1, label: '[1]', text }), searched: [...REQUIRED_SOURCES], failed: [] });
const FAB = 'Sparse mixture routing for long-context retrieval in multilingual corpora';
const TALK = /^Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as a talk/;

describe('a talk named as one before its title', () => {
  test.each([
    'Bottou, L. Invited talk: Two big challenges in machine learning. ICML 2015.',
    'Bottou, L. (2015). Keynote: Two big challenges in machine learning. ICML 2015, Lille.',
    'Bottou, L. (2015). Plenary lecture: Two big challenges in machine learning. 32nd International Conference on Machine Learning, Lille, 7 July 2015.',
    'Bottou, L. (2015). Keynote talk - Two big challenges in machine learning. ICML 2015.',
  ])('is Can\'t check: %s', (text) => {
    const v = nothing(text);
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(TALK);
  });

  // A paper whose title opens with a talk word, or with a tutorial's name, gives its journal's volume and pages.
  test.each([
    `Whitfield, A., Okonkwo, R. (2021). Keynote: ${FAB}. Journal of Machine Learning Research 22, 1-40, 2021.`,
    `A. Whitfield and R. Okonkwo, "Tutorial: ${FAB}," J. Appl. Phys. 128, 041101 (2020).`,
    `Whitfield, A., Okonkwo, R. (2021). Invited talk: ${FAB}. In Proceedings of ICML, pages 1-9, 2021.`,
  ])('with a volume or pages it is a paper, and Not found: %s', (text) => {
    expect(nothing(text).status).toBe('not_found');
  });

  test.each([
    `Whitfield, A., Okonkwo, R. (2021). Talk is cheap: ${FAB}. In Proceedings of ICML, 2021.`,
    `Whitfield, A., Okonkwo, R. (2021). Tutorials and keynotes for ${FAB}. In Proceedings of ICML, 2021.`,
  ])('a title that only opens with a talk word is a paper, and Not found: %s', (text) => {
    expect(nothing(text).status).toBe('not_found');
  });
});

describe('a talk named as one after its title, in a proceedings volume or a journal', () => {
  // A keynote or tutorial is often cited with the proceedings of the meeting where it was given. Standing on its own
  // ("Keynote talk.", "Tutorial,") the word says what the work is; without pages or a volume the reference is the talk.
  test.each([
    'Bottou, L. (2015). Two big challenges in machine learning. Keynote talk. In Proceedings of the 32nd International Conference on Machine Learning, 2015.',
    'Bottou, L. (2015). Two big challenges in machine learning. Tutorial, In Proceedings of the 32nd International Conference on Machine Learning, 2015.',
    'Bottou, L. (2015). Two big challenges in machine learning. Invited lecture, Proceedings of the 32nd International Conference on Machine Learning, Lille, 2015.',
    'Bottou, L. (2015). Two big challenges in machine learning. Plenary talk. Bulletin of the American Physical Society, March 2015.',
    'Bottou, L. (2015). Two big challenges in machine learning. Keynote address given at the 32nd International Conference on Machine Learning. In Proceedings of ICML, 2015.',
  ])('is Can\'t check: %s', (text) => {
    const v = nothing(text);
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(TALK);
  });

  test.each([
    'Bottou, L. (2015). Two big challenges in machine learning. Lecture, ICML 2015, Lille.',
    'Bottou, L. (2015). Two big challenges in machine learning. Invited lecture at the Les Houches Summer School, 2015.',
  ])('a lecture is a talk too: %s', (text) => {
    expect(nothing(text).reason).toMatch(TALK);
  });

  test.each([
    // A talk word inside a sentence that reads as more of the title is not a designation.
    `Whitfield, A., Okonkwo, R. (2021). Sparse mixture routing. A tutorial review. Journal of Machine Learning Research, 2021.`,
    `A. Whitfield and R. Okonkwo. Sparse mixture routing. Keynote speakers and long-context retrieval. In Proceedings of ICML, 2021.`,
    `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In Proceedings of the ICML 2021 Tutorial Track.`,
    // A paper's own designation.
    `Whitfield, A., Okonkwo, R. (2021). ${FAB}. Oral presentation. In Proceedings of ICML, 2021.`,
    `Whitfield, A., Okonkwo, R. (2021). ${FAB}. Contributed talk. In Proceedings of ICML, 2021.`,
    // Pages or a volume make it a paper whatever it calls itself.
    `Whitfield, A., Okonkwo, R. (2021). ${FAB}. Keynote talk. In Proceedings of ICML, pages 1-9, 2021.`,
    `Whitfield, A., Okonkwo, R. (2021). ${FAB}. Invited talk. Bulletin of the American Physical Society 66, 2021.`,
    // "Lecture Notes in ..." is a book series of proceedings, not a lecture.
    `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In Computer Vision – ECCV 2021, Lecture Notes in Computer Science.`,
    `Whitfield, A., Okonkwo, R. (2021). ${FAB}. Lecture Notes in Computer Science, Springer.`,
  ])('an invented paper is still Not found: %s', (text) => {
    expect(nothing(text).status).toBe('not_found');
  });

  // Accepted cost: an invented paper cited exactly as a talk, with no pages or volume, is Can't check.
  test('an invented paper dressed as a talk in a proceedings volume is Can\'t check (accepted)', () => {
    expect(nothing(`Whitfield, A., Okonkwo, R. (2021). ${FAB}. Invited talk. In Proceedings of ICML, 2021.`).status).toBe('cant_check');
  });
});

describe('a titled paper in a journal from before 1970', () => {
  const OLD = /^Not in Crossref, arXiv, OpenReview or OpenAlex, and it was published before 1970/;

  // Both cited correctly; neither journal of those years is held by any of the databases.
  test.each([
    'John F Banzhaf III. Weighted voting doesn’t work: A mathematical analysis. Rutgers Law Review, 19:317–343, 1965.',
    'I. M. Lifshitz and A. M. Kosevich (1956) Theory of magnetic susceptibility in metals at low temperatures. Soviet Physics JETP 2, pp. 636–645.',
  ])('is Can\'t check: %s', (text) => {
    const v = nothing(text);
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(OLD);
  });

  test.each([
    `A. Whitfield and R. Okonkwo. ${FAB}. Rutgers Law Review, 19:317–343, 2021.`,
    `A. Whitfield and R. Okonkwo (1970) ${FAB}. Soviet Physics JETP 2, pp. 636–645.`,
    // The cut-off is the year: a classic of 1976 in an unindexed journal stays Not found (accepted).
    'Marat Valievich Burnashev. Data transmission over a discrete channel with feedback. random transmission time. Problemy peredachi informatsii, 12(4):10–30, 1976.',
  ])('a paper of 1970 or later is Not found: %s', (text) => {
    expect(nothing(text).status).toBe('not_found');
  });

  test('an identifier that led nowhere is no old journal: the reference stays Not found', () => {
    expect(nothing(`Watson JD, Crick FHC. ${FAB}. Nature. 1953;171:737–738. doi:10.1038/171737a0`).status).toBe('not_found');
  });

  // An invented paper with no year of its own does not borrow one from an old reference run into it.
  test.each([
    `J. Doe, A. Roe, ${FAB}, Phys. Rev. D 82, 123456; A. Einstein, Ann. Phys. 49, 769 (1916).`,
    `J. Doe, A. Roe, ${FAB}, Phys. Rev. D 82, 123456, A. Einstein, Ann. Phys. 49, 769 (1916).`,
  ])('an old year that belongs to another work is no old paper: %s', (text) => {
    expect(nothing(text).reason).not.toMatch(/before 1970/);
  });

  test('a later year anywhere in the reference reads it as a later work, which stays Not found', () => {
    expect(nothing(`A. Whitfield and R. Okonkwo (1965) ${FAB}. Rutgers Law Review 19, 317–343. Reprinted 2015.`).status).toBe('not_found');
  });

  // Proceedings, workshops and company reports of later years keep their verdicts: the exemption is by year alone.
  test.each([
    'Purason, T., Tättar, A. (2022). Multilingual neural machine translation with the right amount of sharing. In Proceedings of the 23rd Annual Conference of the European Association for Machine Translation, pp. 91–100.',
    'Z. Liu, M. Lu, Z. Wang, M. Jordan, and Z. Yang (2022) Welfare maximization in competitive equilibrium: reinforcement learning for Markov exchange economy. In International Conference on Machine Learning, pp. 13870–13911.',
  ])('a later unindexed proceedings paper is still Not found: %s', (text) => {
    expect(nothing(text).status).toBe('not_found');
  });

  // Accepted cost: an invented paper given an old year is Can't check.
  test('an invented paper given an old year is Can\'t check (accepted)', () => {
    expect(nothing(`A. Whitfield and R. Okonkwo. ${FAB}. Rutgers Law Review, 19:317–343, 1965.`).status).toBe('cant_check');
  });
});

describe('a talk about software at a technology conference, with its repository', () => {
  test('the real reference (Macklin, Warp, NVIDIA GTC 2022) is Can\'t check', () => {
    const v = nothing('Miles Macklin. Warp: A high-performance Python framework for GPU simulation and graphics. NVIDIA GPU Technology Conference (GTC), https://github.com/NVIDIA/warp, 2022.');
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/^Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as a talk about software/);
  });

  test.each([
    `A. Whitfield. ${FAB}. PyTorch Developer Conference, https://github.com/whitfield/routing, 2021.`,
    `A. Whitfield. ${FAB}. OpenAI DevDay, https://gitlab.com/whitfield/routing, 2023.`,
    `A. Whitfield. ${FAB}. Data + AI Summit, https://bitbucket.org/whitfield/routing, 2021.`,
  ])('is Can\'t check: %s', (text) => {
    expect(nothing(text).status).toBe('cant_check');
  });

  test.each([
    `A. Whitfield. ${FAB}. In Proceedings of the GPU Technology Conference, https://github.com/whitfield/routing, 2022.`,
    `A. Whitfield. ${FAB}. GPU Technology Conference 12, pp. 1–10, https://github.com/whitfield/routing, 2022.`,
    `A. Whitfield. ${FAB}. In NeurIPS 2022, https://github.com/whitfield/routing.`,
    `A. Whitfield. ${FAB}. Journal of Open Source Software, https://github.com/whitfield/routing, 2022.`,
    // No repository: a conference with no paper word is the venue the reference names.
    `A. Whitfield. ${FAB}. NVIDIA GPU Technology Conference (GTC), 2022.`,
  ])('an invented paper is still Not found: %s', (text) => {
    expect(nothing(text).status).toBe('not_found');
  });

  // Accepted cost: an invented talk at a technology conference, with a repository, is Can't check.
  test('an invented paper dressed as a software talk is Can\'t check (accepted)', () => {
    expect(nothing(`A. Whitfield. ${FAB}. NVIDIA GTC 2022, https://github.com/whitfield/routing.`).status).toBe('cant_check');
  });
});

// A position paper or preprint cited with its version ("0.9.2", "v1.2", "version 3.1") and no journal: the version
// says which draft, not where it was published, so it is no volume, issue or page.
describe('a version number after the title', () => {
  const blocked = (text: string, blocks: string[]) => classify({ citation: parseCitation({ index: 1, label: '[1]', text, blocks }), searched: [...REQUIRED_SOURCES], failed: [] });
  const NO_VENUE = /^Not in Crossref, arXiv, OpenReview or OpenAlex, and no journal or conference could be read from it/;

  test('the real reference (LeCun, a position paper on OpenReview, 0.9.2) is Can\'t check', () => {
    const v = blocked('Y. LeCun A path towards autonomous machine intelligence. OpenReview [Position paper] 0.9.2.', ['Y. LeCun', 'A path towards autonomous machine intelligence.', 'OpenReview [Position paper] 0.9.2.']);
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(NO_VENUE);
  });

  test.each([
    `A. Whitfield. ${FAB}. OpenReview [Position paper] 0.9.2.`,
    `A. Whitfield. ${FAB}. Position paper, v1.2, 2022.`,
    `A. Whitfield. ${FAB}. OpenReview, version 3.1, 2023.`,
    `A. Whitfield. ${FAB}. Draft, Version 2.0.1.`,
  ])('is Can\'t check: %s', (text) => {
    const v = nothing(text);
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(NO_VENUE);
  });

  test.each([
    // A volume and pages next to the version are still a volume and pages.
    `A. Whitfield. ${FAB}. OpenReview [Position paper] 12, 45.`,
    `A. Whitfield. ${FAB}. Embodied Reasoning 12, 45–67, 2021. v1.2.`,
    `A. Whitfield. ${FAB}. Machine Reasoning Letters 7(2):101–118, version 3.1, 2020.`,
    // A journal named with a venue word, whatever version follows.
    `A. Whitfield. ${FAB}. Journal of Embodied Reasoning, v1.2, 2021.`,
    // "volume.issue" and a decimal are no version: only a "v", the word "version" or three dotted parts make one.
    `A. Whitfield. ${FAB}. Embodied Reasoning 21.3, 2021.`,
    `A. Whitfield. ${FAB}. Embodied Reasoning 521.7553, 2015.`,
  ])('an invented paper is still Not found: %s', (text) => {
    expect(nothing(text).status).toBe('not_found');
  });

  // Accepted cost: an invented paper cited with only a version number and no journal is Can't check.
  test('an invented paper dressed with only a version number is Can\'t check (accepted)', () => {
    expect(nothing(`A. Whitfield. ${FAB}. Embodied Reasoning 0.9.2.`).status).toBe('cant_check');
  });
});
