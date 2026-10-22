import { NotImplementedError } from "@botara/shared";
import {
  envEmailCredentials, envInstagramCredentials, envMessengerCredentials,
  envTelegramCredentials, envThreadsCredentials, envWhatsAppCredentials,
} from "./credentials";
import { EmailAdapter } from "./email";
import { InstagramAdapter } from "./instagram";
import { MessengerAdapter } from "./messenger";
import { TelegramAdapter } from "./telegram";
import { ThreadsAdapter } from "./threads";
import { WebchatAdapter } from "./webchat";
import { WhatsAppAdapter } from "./whatsapp";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type ChannelKey, type CredentialProvider, type InboundEvent, type PublishInput,
  type SendInput, type SendResult,
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

/**
 * Optional credentials factory (Fase 3): process wiring (API/worker) calls
 * this ONCE at startup - BEFORE the first getAdapter() - to give every
 * default adapter a vault-backed provider (with env fallback) instead of
 * the plain env providers. Adapters already constructed are unaffected.
 */
let credentialsFactory: ((key: ChannelKey) => CredentialProvider) | undefined;

export function configureAdapterCredentials(
  factory: ((key: ChannelKey) => CredentialProvider) | undefined,
): void {
  credentialsFactory = factory;
}

function credentialsFor(key: ChannelKey): CredentialProvider {
  if (credentialsFactory) return credentialsFactory(key);
  switch (key) {
    case "whatsapp": return envWhatsAppCredentials();
    case "telegram": return envTelegramCredentials();
    case "instagram": return envInstagramCredentials();
    case "messenger": return envMessengerCredentials();
    case "threads": return envThreadsCredentials();
    case "email": return envEmailCredentials();
    case "webchat": return envWhatsAppCredentials(); // unused - webchat resolves no secrets
  }
}

/**
 * Default adapter factory. Fase 1 made whatsapp + telegram real; Fase 2
 * completes the set: instagram (dual-mode), messenger, threads, email
 * (Resend), and webchat (self-built; its registry instance has no store, so
 * send() fails honestly with CONFIGURATION until apps/api wires the
 * DB-backed store - see apps/api webchat wiring). Credentials always come
 * from the env-backed providers until the vault lands.
 */
function createDefaultAdapter(key: ChannelKey): ChannelAdapter {
  switch (key) {
    case "whatsapp":
      return new WhatsAppAdapter({ credentials: credentialsFor(key) });
    case "telegram":
      return new TelegramAdapter({ credentials: credentialsFor(key) });
    case "instagram":
      return new InstagramAdapter({ credentials: credentialsFor(key) });
    case "messenger":
      return new MessengerAdapter({ credentials: credentialsFor(key) });
    case "threads":
      return new ThreadsAdapter({ credentials: credentialsFor(key) });
    case "email":
      return new EmailAdapter({ credentials: credentialsFor(key) });
    case "webchat":
      return new WebchatAdapter();
  }
}

export function getAdapter(key: ChannelKey): ChannelAdapter {
  let adapter = registry.get(key);
  if (!adapter) {
    adapter = createDefaultAdapter(key);
    registry.set(key, adapter);
  }
  return adapter;
}

export function listAdapters(): ChannelAdapter[] {
  return (Object.keys(CHANNEL_CAPABILITIES) as ChannelKey[]).map((k) => getAdapter(k));
}
