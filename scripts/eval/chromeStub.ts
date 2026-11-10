// The least of `chrome.*` that the engine touches outside a browser: an in-memory `storage.local`. The engine's
// own caches and history are not used by the evaluation (answers are kept on disk by diskFetch.ts), but the
// modules reach for the API when they are made. Nothing here is ever persisted.
export function installChromeStub(): void {
  const data = new Map<string, unknown>();
  const none = { addListener: () => undefined, removeListener: () => undefined };
  const local = {
    get: (keys?: string | string[]): Promise<Record<string, unknown>> => {
      const wanted = keys === undefined ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Promise.resolve(Object.fromEntries(wanted.filter((k) => data.has(k)).map((k) => [k, data.get(k)])));
    },
    set: (items: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
      return Promise.resolve();
    },
    remove: (keys: string | string[]): Promise<void> => {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
      return Promise.resolve();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'refsure-eval' }, storage: { local, onChanged: none } };
}
