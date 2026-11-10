// A small world of real records for the adversarial suite: Crossref and arXiv searches return every record of their
// kind, so a citation can only stay unmatched if the matching rules turn the records down. OpenAlex returns nothing, or
// (openalexAll) every record.
import { vi } from 'vitest';
import { stripArxivVersion } from '../../../src/core/identifiers';
import type { ParsedCitation, WorkRecord } from '../../../src/core/types';
import { makeDeps, mockSources } from './engine';

export const R = (o: Partial<WorkRecord> & { title: string; authors: string[] }): WorkRecord => ({ source: 'crossref', isRetracted: false, notes: [], ...o });

export const WAKEFIELD_DOI = '10.1016/s0140-6736(97)11096-0';

export const WORLD: WorkRecord[] = [
  R({ title: 'Deep learning', authors: ['lecun', 'bengio', 'hinton'], year: 2015, doi: '10.1038/nature14539', venue: 'Nature', volume: '521', pages: ['436'] }),
  R({ title: 'Deep Residual Learning for Image Recognition', authors: ['he', 'zhang', 'ren', 'sun'], year: 2016, doi: '10.1109/cvpr.2016.90', venue: '2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)' }),
  R({ source: 'arxiv', title: 'Deep Residual Learning for Image Recognition', authors: ['he', 'zhang', 'ren', 'sun'], year: 2015, arxivId: '1512.03385' }),
  R({ source: 'arxiv', title: 'Attention Is All You Need', authors: ['vaswani', 'shazeer', 'parmar', 'uszkoreit', 'jones', 'gomez', 'kaiser', 'polosukhin'], year: 2017, arxivId: '1706.03762' }),
  R({ source: 'arxiv', title: 'Adam: A Method for Stochastic Optimization', authors: ['kingma', 'ba'], year: 2014, arxivId: '1412.6980' }),
  R({ source: 'arxiv', title: 'Auto-Encoding Variational Bayes', authors: ['kingma', 'welling'], year: 2013, arxivId: '1312.6114' }),
  R({ source: 'arxiv', title: 'Semi-Supervised Classification with Graph Convolutional Networks', authors: ['kipf', 'welling'], year: 2016, arxivId: '1609.02907' }),
  R({ source: 'arxiv', title: 'Variational Graph Auto-Encoders', authors: ['kipf', 'welling'], year: 2016, arxivId: '1611.07308' }),
  R({ source: 'arxiv', title: 'Denoising Diffusion Probabilistic Models', authors: ['ho', 'jain', 'abbeel'], year: 2020, arxivId: '2006.11239' }),
  R({ source: 'arxiv', title: 'Denoising Diffusion Implicit Models', authors: ['song', 'meng', 'ermon'], year: 2020, arxivId: '2010.02502' }),
  R({ title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', authors: ['devlin', 'chang', 'lee', 'toutanova'], year: 2019, doi: '10.18653/v1/n19-1423' }),
  R({ source: 'arxiv', title: 'Small E(8) Instantons and Tensionless Non-critical Strings', authors: ['ganor', 'hanany'], year: 1996, arxivId: 'hep-th/9602120' }),
  R({ title: 'Small E8 instantons and tensionless non-critical strings', authors: ['ganor', 'hanany'], year: 1996, doi: '10.1016/0550-3213(96)00243-x', venue: 'Nuclear Physics B' }),
  R({ title: 'Pattern Recognition and Machine Learning', authors: ['bishop'], year: 2006, doi: '10.1007/978-0-387-45528-0' }),
  R({ title: 'Reinforcement Learning: An Introduction', authors: ['sutton', 'barto'], year: 2018, doi: '10.1109/tnn.1998.712192' }),
  R({ title: 'The Elements of Statistical Learning: Data Mining, Inference, and Prediction', authors: ['hastie', 'tibshirani', 'friedman'], year: 2009, doi: '10.1007/978-0-387-84858-7' }),
  R({ title: 'Deep Learning', authors: ['goodfellow', 'bengio', 'courville'], year: 2016, doi: '10.5555/3086952' }),
  R({ title: 'Computational Complexity and Black Hole Horizons', authors: ['susskind'], year: 2016, doi: '10.1002/prop.201500092', venue: 'Fortschritte der Physik' }),
  R({ title: 'Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children', authors: ['wakefield', 'murch', 'anthony'], year: 1998, doi: WAKEFIELD_DOI, isRetracted: true, venue: 'The Lancet' }),
  R({ title: 'Generative adversarial nets', authors: ['goodfellow', 'pouget-abadie', 'mirza'], year: 2014, doi: '10.5555/2969033.2969125' }),
  R({ source: 'arxiv', title: 'Generative Adversarial Networks', authors: ['goodfellow', 'pouget-abadie', 'mirza'], year: 2014, arxivId: '1406.2661' }),
];

function worldSources(world: WorkRecord[], opts: { openalexAll?: boolean }) {
  const byDoi = (c: ParsedCitation): WorkRecord | null => world.find((r) => r.doi !== undefined && c.doi !== undefined && r.doi.toLowerCase() === c.doi.toLowerCase()) ?? null;
  const byArxiv = (c: ParsedCitation): WorkRecord | null => world.find((r) => r.source === 'arxiv' && c.arxivId !== undefined && r.arxivId === stripArxivVersion(c.arxivId)) ?? null;
  const cross = world.filter((r) => r.source === 'crossref');
  const arx = world.filter((r) => r.source === 'arxiv');
  return mockSources({
    crossref: { lookupById: (c) => Promise.resolve(byDoi(c)), search: () => Promise.resolve(cross) },
    arxiv: { lookupById: (c) => Promise.resolve(byArxiv(c)), search: () => Promise.resolve(arx) },
    openalex: { lookupById: (c) => Promise.resolve(byDoi(c)), search: () => Promise.resolve(opts.openalexAll === true ? world.map((r) => ({ ...r, source: 'openalex' as const })) : []) },
  });
}

/** Engine dependencies over `world`; the retraction lookup reports every retracted record (and Wakefield's) as retracted. */
export function worldDeps(opts: { openalexAll?: boolean; world?: WorkRecord[] } = {}) {
  const sources = worldSources(opts.world ?? WORLD, opts);
  const retracted = (m: WorkRecord) => m.isRetracted || m.doi === WAKEFIELD_DOI;
  const deps = makeDeps(sources, {
    retraction: { check: vi.fn((m: WorkRecord) => Promise.resolve(retracted(m) ? { retracted: true, version: 'cited' as const, noticeDoi: '10.1016/s0140-6736(10)60175-4' } : { retracted: false })) },
  });
  return { sources, deps };
}
