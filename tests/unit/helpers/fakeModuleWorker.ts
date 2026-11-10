// A stand-in for the browser's module Worker, for tests that run pdf.js in Node. The Firefox build hands
// pdf.js a Worker of our own as its port (src/extract/pdfjsRuntime.ts), and Node has no such Worker.
// This one wires a MessageChannel to pdf.js's own worker code, which is loaded in this thread through
// the URL it is given, so the whole port protocol is exercised for real.
import pdfWorkerUrl from './pdfWorkerUrl';

type Listener = (event: unknown) => void;

export class FakeModuleWorker {
  static started: FakeModuleWorker[] = [];
  terminated = false;
  private readonly main: MessagePort;
  private readonly other: MessagePort;

  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    FakeModuleWorker.started.push(this);
    const channel = new MessageChannel();
    this.main = channel.port1;
    this.other = channel.port2;
    // The worker side starts asynchronously, as a real worker would.
    void import(/* @vite-ignore */ pdfWorkerUrl).then((module: { WorkerMessageHandler: { initializeFromPort(port: unknown): void } }) => {
      module.WorkerMessageHandler.initializeFromPort(this.other);
    });
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.main.postMessage(message, transfer ?? []);
  }

  addEventListener(type: string, listener: Listener, options?: unknown): void {
    this.main.addEventListener(type, listener as EventListener, options as AddEventListenerOptions);
    // Node only delivers to an EventTarget port once it is started.
    this.main.start();
  }

  removeEventListener(type: string, listener: Listener): void {
    this.main.removeEventListener(type, listener as EventListener);
  }

  terminate(): void {
    this.terminated = true;
    this.main.close();
    this.other.close();
  }
}
