import { NotImplementedError } from "@botara/shared";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type ChannelKey, type InboundEvent, type PublishInput, type SendInput, type SendResult,
} from "./types";

/**
 * Honest Fase 0 placeholder: every provider call throws NotImplementedError.
 * Only parseWebhook (returns no events) and health (reports not-implemented)
 * behave, so wiring can be tested without pretending a channel works.
 */
export class PlaceholderAdapter implements ChannelAdapter {
  readonly apiVersion: string;
  readonly capabilities;

  constructor(readonly key: ChannelKey, apiVersion = "v26.0") {
    this.apiVersion = apiVersion;
    this.capabilities = CHANNEL_CAPABILITIES[key];
  }

  async connect(): Promise<ChannelAccountRef> { throw new NotImplementedError(`${this.key}.connect`); }
  async disconnect(): Promise<void> { throw new NotImplementedError(`${this.key}.disconnect`); }
  async refreshTokenIfNeeded(): Promise<{ refreshed: boolean }> { throw new NotImplementedError(`${this.key}.refreshTokenIfNeeded`); }
  async send(_input: SendInput): Promise<SendResult> { throw new NotImplementedError(`${this.key}.send`); }
  async publish(_input: PublishInput): Promise<{ externalPostId: string }> { throw new NotImplementedError(`${this.key}.publish`); }
  async moderate(): Promise<void> { throw new NotImplementedError(`${this.key}.moderate`); }
  async fetchInsights(): Promise<Record<string, number>> { throw new NotImplementedError(`${this.key}.fetchInsights`); }

  async parseWebhook(_payload: unknown): Promise<InboundEvent[]> {
    // Real adapters normalize provider payloads here; the stub recognizes none.
    return [];
  }

  async health(): Promise<AdapterHealth> {
    return { ok: false, detail: `${this.key} adapter is a Fase 0 placeholder (not implemented)` };
  }
}

const registry = new Map<ChannelKey, ChannelAdapter>();

export function registerAdapter(adapter: ChannelAdapter): void {
  registry.set(adapter.key, adapter);
}

export function getAdapter(key: ChannelKey): ChannelAdapter {
  let adapter = registry.get(key);
  if (!adapter) {
    adapter = new PlaceholderAdapter(key);
    registry.set(key, adapter);
  }
  return adapter;
}

export function listAdapters(): ChannelAdapter[] {
  return (Object.keys(CHANNEL_CAPABILITIES) as ChannelKey[]).map((k) => getAdapter(k));
}
