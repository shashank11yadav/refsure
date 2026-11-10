import { readFileSync } from 'node:fs';
import type { ParsedCitation } from '../../../src/core/types';

const DIR = new URL('../../fixtures/api/', import.meta.url);

/** A recorded API response, byte for byte. */
export function fixtureText(name: string): string {
  return readFileSync(new URL(name, DIR), 'utf8');
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

export function citation(overrides: Partial<ParsedCitation> = {}): ParsedCitation {
  return { raw: 'raw reference text', authors: [], kind: 'paper', confidence: 1, ...overrides };
}
