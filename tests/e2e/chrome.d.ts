// The slice of the `chrome` extension API that e2e code uses inside `evaluate` callbacks. Those functions run in
// the service worker or an extension page (where `chrome` exists), never in the test process.
interface E2eTab {
  id?: number;
  url?: string;
  title?: string;
}
interface E2eSender {
  id?: string;
  url?: string;
  tab?: unknown;
}
interface E2eSidePanel {
  open(options: { tabId: number }): Promise<void>;
}
declare const chrome: {
  sidePanel: E2eSidePanel;
  tabs: {
    query(info: object): Promise<E2eTab[]>;
    get(id: number): Promise<E2eTab>;
    sendMessage(id: number, message: unknown, options?: object): Promise<unknown>;
  };
  runtime: {
    onMessage: { addListener(listener: (message: unknown, sender: E2eSender) => boolean | undefined): void };
    getContexts(filter: { contextTypes: string[] }): Promise<{ contextType: string; documentUrl?: string }[]>;
  };
};
