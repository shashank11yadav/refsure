// Values read from a message or from storage are only checked to be "a record" at the `match` field
// (messaging.ts), so what is used from it is coerced here instead of trusted. No imports: the content scripts
// validate their messages with these, and the network code must not come along into them.

/** A plain object (not null, not an array), whose fields are still unknown. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string or a number as text; anything else (an object, an array, undefined) as the empty string. */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}
