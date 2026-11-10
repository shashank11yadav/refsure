import type { ParsedCitation, SourceName, WorkRecord } from '../core/types';

/** What every lookup service adapter offers the checker. */
export interface Source {
  name: SourceName;
  /**
   * The record for the citation's own identifier, or `null` when the service has no such
   * record (or cannot look this kind of identifier up). Throws `SourceError` on failure.
   */
  lookupById(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord | null>;
  /** Candidate records for a citation that has no usable identifier. Throws `SourceError` on failure. */
  search(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]>;
}

/** `lookupById` for a service that cannot look a work up by identifier. */
export const noLookup: Source['lookupById'] = () => Promise.resolve(null);
