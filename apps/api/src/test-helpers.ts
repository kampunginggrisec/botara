import { expect } from "bun:test";
import { AppError } from "@botara/shared";
import { InMemoryPlatformSettingsStorage, PlatformSettingsService } from "@botara/db";
import { createApp, type ApiDeps } from "./app";
import { InMemoryAdminStore } from "./admin";
import { InMemoryAuthStore } from "./auth";
import { InMemoryVault } from "./whatsapp-onboarding";

/** Fixed 32-byte vault key for the in-memory platform-settings service. */
export const TEST_VAULT_KEY = Buffer.alloc(32, 7);

/**
 * Shared fake deps for API tests: every port is an in-memory fake, the DB
 * getter throws the same 503 CONFIGURATION a real unconfigured server
 * would, and auth runs against InMemoryAuthStore with a test secret.
 */
export function testDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  const env: Record<string, string | undefined> = {
    WHATSAPP_VERIFY_TOKEN: "verify-me",
    SESSION_SECRET: "test-session-secret",
  };
  return {
    getDatabase: () => {
      throw new AppError("CONFIGURATION", "DATABASE_URL is not configured (test).", { status: 503 });
    },
    eventSink: { async handle() {} },
    broadcastEnqueuer: { async enqueueBroadcast() {} },
    publishEnqueuer: { async enqueuePublish() {} },
    templateCategoryUpdater: { async applyCategoryChange() {} },
    whatsappOnboarding: async () => {
      throw new AppError("CONFIGURATION", "onboarding not configured (test).", { status: 503 });
    },
    catalogSync: async () => {
      throw new AppError("CONFIGURATION", "catalog sync not configured (test).", { status: 503 });
    },
    templateSync: async () => {
      throw new AppError("CONFIGURATION", "template sync not configured (test).", { status: 503 });
    },
    templateSubmit: async () => {
      throw new AppError("CONFIGURATION", "template submit not configured (test).", { status: 503 });
    },
    templateDelete: async () => {
      throw new AppError("CONFIGURATION", "template delete not configured (test).", { status: 503 });
    },
    channelAutomation: {
      welcomeFlows: {
        async list() { throw new AppError("CONFIGURATION", "channel automation not configured (test).", { status: 503 }); },
        async get() { throw new AppError("CONFIGURATION", "channel automation not configured (test).", { status: 503 }); },
        async create() { throw new AppError("CONFIGURATION", "channel automation not configured (test).", { status: 503 }); },
        async update() { throw new AppError("CONFIGURATION", "channel automation not configured (test).", { status: 503 }); },
        async remove() { throw new AppError("CONFIGURATION", "channel automation not configured (test).", { status: 503 }); },
      },
      profile: {
        async get() { throw new AppError("CONFIGURATION", "channel automation not configured (test).", { status: 503 }); },
        async set() { throw new AppError("CONFIGURATION", "channel automation not configured (test).", { status: 503 }); },
        async remove() { throw new AppError("CONFIGURATION", "channel automation not configured (test).", { status: 503 }); },
      },
    },
    getAiProvider: () => null,
    authStore: new InMemoryAuthStore(),
    emailInboundEnqueuer: { async enqueueEmailInbound() {} },
    emailRouter: { async resolveRecipientDomain() { return null; } },
    dataDeletionStore: {
      async create() {},
      async getByCode() { return null; },
      async complete() {},
      async purge() { return { contacts: 0 }; },
    },
    kbEnqueuer: { async enqueueKbIngest() {} },
    flowEnqueuer: { async enqueueFlowRun() {} },
    webhookEnqueuer: { async enqueueWebhookDelivery() {} },
    flowDispatcher: { async dispatch() {}, async dispatchPersistedWebchat() {} },
    realtimePublisher: { async publishInboxMessage() {}, async publishInboxUpdate() {} },
    vault: new InMemoryVault(),
    providerFetch: async () => new Response(JSON.stringify({}), { status: 200 }),
    readiness: {
      async checkDatabase() { return { ok: false, detail: "not configured (test)" }; },
      async checkRedis() { return { ok: false, detail: "not configured (test)" }; },
    },
    adminStore: new InMemoryAdminStore(),
    platformSettings: new PlatformSettingsService(new InMemoryPlatformSettingsStorage(), {
      baseEnv: env,
      liveEnv: env,
      vaultKey: TEST_VAULT_KEY,
    }),
    env,
    ...overrides,
  };
}

export interface Registered {
  token: string;
  workspaceId: string;
  userId: string;
  /** Bearer token + workspace selector, as the web client sends them. */
  headers: Record<string, string>;
}

type TestApp = ReturnType<typeof createApp>;

/** Register a user through the real endpoint and return session material. */
export async function registerUser(
  app: TestApp,
  email = "owner@example.com",
  name = "Owner",
): Promise<Registered> {
  const res = await app.request("/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", name }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    token: string;
    workspace: { id: string };
    user: { id: string };
  };
  return {
    token: body.token,
    workspaceId: body.workspace.id,
    userId: body.user.id,
    headers: { authorization: `Bearer ${body.token}`, "x-workspace-id": body.workspace.id },
  };
}
