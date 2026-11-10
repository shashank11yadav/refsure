// Is this work, or its preprint/published twin, formally retracted? Uses only the
// free lookups by ID (Crossref update data incl. Retraction Watch, OpenAlex is_retracted).
// A retraction is a serious claim about real authors, so: only a formal retraction
// counts, and a version is only called "not retracted" on the strength of a record
// (or of every service agreeing it has none). A service that failed is never read as
// "nothing on record".

import { isValidArxivId, isValidDoi, stripArxivVersion } from '../core/identifiers';
import type { Retraction, WorkRecord } from '../core/types';
import { crossref } from './crossref';
import { SourceError } from './http';
import { openalex } from './openalex';

interface Finding {
  retracted: boolean;
  noticeDoi?: string;
}

interface Version {
  /** The version's own DOI, looked up in Crossref and OpenAlex. */
  doi?: string;
  /** Used only when there is no DOI: OpenAlex answers for the DataCite DOI 10.48550/arXiv.<id>. */
  arxivId?: string;
  which: 'cited' | 'other';
}

function failureOf(result: PromiseSettledResult<unknown>): Error | undefined {
  if (result.status !== 'rejected') return undefined;
  return result.reason instanceof Error ? result.reason : new SourceError('network', 'crossref', 'A retraction lookup failed');
}

async function checkVersion(version: Version, signal: AbortSignal | undefined): Promise<Finding> {
  const doi = version.doi ?? `10.48550/arXiv.${version.arxivId ?? ''}`;
  const lookups = [openalex.retractionOf(doi, signal), ...(version.doi !== undefined ? [crossref.retractionOf(doi, signal)] : [])];
  const settled = await Promise.allSettled(lookups);

  // Only an actual record is an answer; "no such work" (null) says nothing about retraction.
  const records: Finding[] = settled.flatMap((r) => (r.status === 'fulfilled' && r.value !== null ? [r.value] : []));
  if (records.some((r) => r.retracted)) {
    // Only Crossref names the notice.
    const noticeDoi = records.map((r) => r.noticeDoi).find((n) => n !== undefined);
    return { retracted: true, ...(noticeDoi !== undefined && { noticeDoi }) };
  }
  // Crossref carries the Retraction Watch data. If it was asked and failed, OpenAlex alone saying "not
  // retracted" is not a complete answer, so the check reports failure and the row gets the "couldn't
  // check retraction" note. With no record from either service, any failure counts too.
  const crossrefResult = version.doi !== undefined ? settled[1] : undefined;
  const crossrefFailure = crossrefResult === undefined ? undefined : failureOf(crossrefResult);
  if (crossrefFailure !== undefined) throw crossrefFailure;
  if (records.length === 0) {
    const failure = settled.map(failureOf).find((e) => e !== undefined);
    if (failure !== undefined) throw failure;
  }
  return { retracted: false };
}

function versionOf(which: Version['which'], doi: string | undefined, arxivId: string | undefined): Version | undefined {
  if (doi !== undefined && isValidDoi(doi)) return { doi, which };
  const bare = arxivId === undefined ? undefined : stripArxivVersion(arxivId);
  return bare !== undefined && isValidArxivId(bare) ? { arxivId: bare, which } : undefined;
}

export const retraction = {
  async check(record: WorkRecord, signal?: AbortSignal): Promise<Retraction> {
    const candidates = [versionOf('cited', record.doi, record.arxivId), versionOf('other', record.otherVersion?.doi, record.otherVersion?.arxivId)];
    const versions: Version[] = [];
    for (const v of candidates) {
      const key = (v?.doi ?? v?.arxivId ?? '').toLowerCase();
      if (v !== undefined && !versions.some((seen) => (seen.doi ?? seen.arxivId ?? '').toLowerCase() === key)) versions.push(v);
    }

    const settled = await Promise.allSettled(versions.map((v) => checkVersion(v, signal)));
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');

    // Versions are in priority order; a positive finding wins even if a later version failed.
    for (const [i, result] of settled.entries()) {
      if (result.status === 'fulfilled' && result.value.retracted) {
        const noticeDoi = result.value.noticeDoi;
        return { retracted: true, version: versions[i]?.which ?? 'cited', ...(noticeDoi !== undefined && { noticeDoi }) };
      }
    }
    const failure = settled.map(failureOf).find((e) => e !== undefined);
    if (failure !== undefined) throw failure;
    return { retracted: false };
  },
};
