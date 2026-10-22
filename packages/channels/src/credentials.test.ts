import { describe, expect, test } from "bun:test";
import {
  CompositeCredentialProvider, StaticCredentialProvider, VaultCredentialProvider,
} from "./credentials";
import type { ChannelAccountRef } from "./types";

const account = (tokenVaultRef?: string): ChannelAccountRef => ({
  id: "acc-1", externalId: "ext-1", tokenVaultRef,
});

describe("VaultCredentialProvider (Fase 3)", () => {
  test("vault: refs are decrypted through the resolver into both token slots", async () => {
    const seen: string[] = [];
    const provider = new VaultCredentialProvider({
      async getSecret(ref) { seen.push(ref); return ref === "vault:db:entry-1" ? "decrypted-token" : null; },
    });
    const secrets = await provider.resolve(account("vault:db:entry-1"));
    expect(seen).toEqual(["vault:db:entry-1"]);
    // Adapters read only their own slot; the one secret fills both.
    expect(secrets.accessToken).toBe("decrypted-token");
    expect(secrets.botToken).toBe("decrypted-token");
  });

  test("unresolvable vault refs fall back to the fallback provider", async () => {
    const provider = new VaultCredentialProvider(
      { async getSecret() { return null; } },
      new StaticCredentialProvider({ accessToken: "fallback-token" }),
    );
    const secrets = await provider.resolve(account("vault:db:gone"));
    expect(secrets.accessToken).toBe("fallback-token");
  });

  test("env: refs keep the Fase 1/2 dev behaviour", async () => {
    const provider = new VaultCredentialProvider(
      { async getSecret() { return null; } },
      undefined,
      { MY_TOKEN: "from-env" },
    );
    const secrets = await provider.resolve(account("env:MY_TOKEN"));
    expect(secrets.accessToken).toBe("from-env");
  });

  test("accounts without a ref delegate entirely to the fallback", async () => {
    const provider = new VaultCredentialProvider(
      { async getSecret() { throw new Error("vault must not be consulted"); } },
      new StaticCredentialProvider({ botToken: "bot-1" }),
    );
    const secrets = await provider.resolve(account(undefined));
    expect(secrets.botToken).toBe("bot-1");
  });
});

describe("CompositeCredentialProvider", () => {
  test("first non-empty value per slot wins", async () => {
    const composite = new CompositeCredentialProvider([
      new StaticCredentialProvider({ accessToken: "first" }),
      new StaticCredentialProvider({ accessToken: "second", botToken: "bot-second", appSecret: "sec" }),
    ]);
    const secrets = await composite.resolve(account());
    expect(secrets).toEqual({ accessToken: "first", botToken: "bot-second", appSecret: "sec", webhookSecret: undefined });
  });
});
