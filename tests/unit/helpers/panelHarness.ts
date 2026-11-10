import { vi } from 'vitest';
import type { CheckResult, CheckSummary, PaperInfo } from '../../../src/core/types';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/engine/settings';
import type { BackgroundToPanel, PanelToBackground, PanelToContent } from '../../../src/messaging';
import { createPanel, type Panel, type PortLike } from '../../../src/ui/panel';
import { flush, makeDom } from './dom';

type Listener<T extends unknown[]> = (...args: T) => void;

function emitter<T extends unknown[]>() {
  const listeners: Listener<T>[] = [];
  return { listeners, addListener: (l: Listener<T>) => void listeners.push(l), fire: (...args: T) => listeners.slice().forEach((l) => l(...args)) };
}

export interface FakePort extends PortLike {
  emit(event: unknown): void;
  drop(): void;
  disconnected: boolean;
}

export interface TabInfo {
  id: number;
  url?: string;
  title?: string;
}

export const ARXIV_TAB: TabInfo = { id: 7, url: 'https://arxiv.org/html/1706.03762v7', title: 'Attention Is All You Need' };

export async function makeHarness(opts: { tab?: TabInfo | null; settings?: Partial<Settings>; history?: unknown; badgeTake?: unknown; clipboard?: 'ok' | 'fail' | 'none' } = {}) {
  const { win, doc } = makeDom();
  const root = doc.createElement('div');
  doc.body.append(root);
  const ports: FakePort[] = [];
  const sent: PanelToBackground[] = [];
  const tabMessages: { tabId: number; message: PanelToContent }[] = [];
  const downloads: { name: string; mime: string; content: string }[] = [];
  const copied: string[] = [];
  let tab: TabInfo | null | undefined = opts.tab === undefined ? ARXIV_TAB : opts.tab;
  let settings: Settings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const settingsChanged = emitter<[Settings]>();
  let history: unknown = opts.history ?? { ok: true, saved: null };
  let clearReply: unknown = { ok: true };

  const deps = {
    doc,
    root,
    connect: (): PortLike => {
      const onMessage = emitter<[unknown]>();
      const onDisconnect = emitter<[]>();
      const port: FakePort = {
        onMessage,
        onDisconnect,
        disconnected: false,
        disconnect: () => {
          port.disconnected = true;
        },
        emit: (event) => onMessage.fire(event),
        drop: () => {
          port.disconnected = true;
          onDisconnect.fire();
        },
      };
      ports.push(port);
      return port;
    },
    send: vi.fn((message: PanelToBackground): Promise<unknown> => {
      sent.push(message);
      if (message.type === 'history:get') return Promise.resolve(history);
      if (message.type === 'history:clear') return Promise.resolve(clearReply);
      if (message.type === 'badge:take') return Promise.resolve(opts.badgeTake ?? { ok: true });
      return Promise.resolve({ ok: true });
    }),
    sendToTab: vi.fn((tabId: number, message: PanelToContent) => {
      tabMessages.push({ tabId, message });
      return Promise.resolve(undefined);
    }),
    activeTab: () => Promise.resolve(tab ?? undefined),
    settings: {
      get: () => Promise.resolve(settings),
      update: (patch: Partial<Settings>) => {
        settings = { ...settings, ...patch };
        return Promise.resolve(settings);
      },
      onChanged: (cb: (s: Settings) => void) => {
        settingsChanged.addListener(cb);
        return () => undefined;
      },
    },
    clipboard:
      opts.clipboard === 'none'
        ? undefined
        : {
            writeText: (text: string) => {
              if (opts.clipboard === 'fail') return Promise.reject(new Error('denied'));
              copied.push(text);
              return Promise.resolve();
            },
          },
    download: (name: string, mime: string, content: string) => void downloads.push({ name, mime, content }),
    schedule: (cb: () => void) => cb(),
  };

  const panel: Panel = createPanel(deps);
  await panel.start();
  await flush();

  const port = (): FakePort => {
    const last = ports[ports.length - 1];
    if (!last) throw new Error('the panel has not connected a port');
    return last;
  };

  return {
    win,
    doc,
    root,
    panel,
    ports,
    sent,
    tabMessages,
    downloads,
    copied,
    deps,
    port,
    emit: async (event: BackgroundToPanel | Record<string, unknown>) => {
      port().emit(event);
      await flush();
    },
    drop: async () => {
      port().drop();
      await flush();
    },
    setTab: async (next: TabInfo | null) => {
      tab = next;
      await panel.refreshActiveTab();
      await flush();
    },
    setHistory: (reply: unknown) => {
      history = reply;
    },
    setClearReply: (reply: unknown) => {
      clearReply = reply;
    },
    settingsNow: () => settings,
    changeSettings: (next: Settings) => {
      settings = next;
      settingsChanged.fire(next);
    },
  };
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

export const started = (paper: PaperInfo, total: number, tabId = 7): BackgroundToPanel => ({ type: 'check:started', tabId, paper, total });
export const resultEvent = (result: CheckResult, paperKey = 'arxiv:1706.03762', tabId = 7): BackgroundToPanel => ({ type: 'check:result', tabId, paperKey, result });
export const doneEvent = (summary: CheckSummary, tabId = 7): BackgroundToPanel => ({ type: 'check:done', tabId, summary });
