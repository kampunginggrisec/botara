import { describe, expect, test } from "bun:test";
import { VaultCredentialProvider, type FetchLike } from "../packages/channels/src/index";
import { InMemoryVaultStore, TokenVault } from "../packages/db/src/index";
import {
  createAdapterSender, sendWaTestTemplate,
  type SendWaTestTemplateDeps, type WaTestTemplateAccount,
} from "./send-wa-test-template";

const TEMP_TOKEN = "<redacted>";
const VAULT_KEY = Buffer.alloc(32, 7);
const MESSAGE_ID = "wamid.HBgNNjI4NTc5MDcwMjQ3NjQVAgARGBI2OTQ2QjVDNTY3OTQxQjZFNDgA";

const INPUT = {
  workspaceId: "ws-1",
  phoneNumberId: "1361611993704410",
  recipient: "6285790702476",
  templateName: "hello_world",
  templateLanguage: "en_US",
};

async function fakeDeps(
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<SendWaTestTemplateDeps> = {},
) {
  // The REAL TokenVault over the in-memory store, seeded exactly like
  // the provisioning script seeds it — the send path must reach the
  // token through the vault ONLY, via the real VaultCredentialProvider
  // and the real WhatsAppAdapter.
  const vault = new TokenVault(new InMemoryVaultStore(), VAULT_KEY);
  const ref = await vault.store({
    channel: "whatsapp", workspaceId: "ws-1", label: "waba:2227032434830165", secret: TEMP_TOKEN,
  });
  const account: WaTestTemplateAccount = { id: "acc-1", externalId: "1361611993704410", tokenVaultRef: ref };
  const provider = new VaultCredentialProvider({ getSecret: (r) => vault.get(r) });
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchLike = async (input, init) => {
    fetchCalls.push({ url: String(input), init });
    if (fetchImpl) return fetchImpl(String(input), init);
    return new Response(
      JSON.stringify({
        messaging_product: "whatsapp",
        contacts: [{ input: INPUT.recipient, wa_id: INPUT.recipient }],
        messages: [{ id: MESSAGE_ID }],
      }),
      { status: 200 },
    );
  };
  const deps: SendWaTestTemplateDeps = {
    accounts: {
      async findExisting(workspaceId, externalId) {
        return workspaceId === "ws-1" && externalId === account.externalId ? account : null;
      },
    },
    sender: createAdapterSender({ credentials: provider, fetchFn }),
    ...overrides,
  };
  return { deps, vault, account, fetchCalls };
}

describe("send-wa-test-template (fake accounts + real TokenVault + VaultCredentialProvider + WhatsAppAdapter)", () => {
  test("POSTs the hello_world template to /messages with the vault-resolved token as Bearer", async () => {
    const { deps, fetchCalls } = await fakeDeps();
    const result = await sendWaTestTemplate(deps, INPUT);

    expect(result).toMatchObject({
      accountId: "acc-1",
      workspaceId: "ws-1",
      externalId: "1361611993704410",
      recipient: "6285790702476",
      templateName: "hello_world",
      templateLanguage: "en_US",
      status: "sent",
      messageId: MESSAGE_ID,
    });
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0]!;
    expect(call.url).toBe("https://graph.facebook.com/v26.0/1361611993704410/messages");
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string>;
    // The Bearer token is the one sealed in the vault — the core input
    // never carried it.
    expect(headers.Authorization).toBe(`Bearer ${TEMP_TOKEN}`);
    expect(JSON.parse(String(call.init?.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "6285790702476",
      type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    });
    // No credential material in the summary: neither the access token
    // nor any vault ref.
    const summary = JSON.stringify(result);
    expect(summary).not.toContain(TEMP_TOKEN);
    expect(summary).not.toContain("vault:");
  });

  test("a Meta error is surfaced in the result with its code, not swallowed", async () => {
    const { deps } = await fakeDeps(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Template name does not exist in the translation language",
            type: "OAuthException", code: 132001, error_subcode: 0, fbtrace_id: "trace-1",
          },
        }),
        { status: 400 },
      ));
    const result = await sendWaTestTemplate(deps, INPUT);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Template name does not exist in the translation language");
    expect(result.errorCode).toBe(132001);
    expect(result.messageId).toBeUndefined();
  });

  test("a missing account fails honestly and never calls Meta", async () => {
    const { deps, fetchCalls } = await fakeDeps(undefined, {
      accounts: { async findExisting() { return null; } },
    });
    await expect(sendWaTestTemplate(deps, INPUT)).rejects.toThrow(/provision-wa-test-number/);
    expect(fetchCalls).toHaveLength(0);
  });

  test("an account without a vault ref fails honestly and never calls Meta", async () => {
    const { deps, fetchCalls } = await fakeDeps(undefined, {
      accounts: {
        async findExisting() {
          return { id: "acc-1", externalId: "1361611993704410", tokenVaultRef: null };
        },
      },
    });
    await expect(sendWaTestTemplate(deps, INPUT)).rejects.toThrow(/no token_vault_ref/);
    expect(fetchCalls).toHaveLength(0);
  });
});
