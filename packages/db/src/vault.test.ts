import { describe, expect, test } from "bun:test";
import {
  InMemoryVaultStore, TokenVault, parseVaultKey, parseVaultRef, sealSecret, unsealSecret, vaultRefFor,
} from "./vault";

const KEY = Buffer.alloc(32, 7);
const KEY_B64 = KEY.toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9);

describe("vault key parsing (fail closed)", () => {
  test("missing key -> CONFIGURATION error", () => {
    expect(() => parseVaultKey(undefined)).toThrow(/TOKEN_VAULT_KEY is not configured/);
    expect(() => parseVaultKey("")).toThrow(/not configured/);
  });

  test("wrong-length key -> CONFIGURATION error", () => {
    expect(() => parseVaultKey(Buffer.alloc(16, 1).toString("base64"))).toThrow(/32-byte key/);
  });

  test("valid base64 32-byte key parses", () => {
    expect(parseVaultKey(KEY_B64).equals(KEY)).toBe(true);
  });
});

describe("AES-256-GCM seal/unseal", () => {
  test("roundtrip restores the plaintext", () => {
    const sealed = sealSecret(KEY, "EAABwzLixnjQ-token-material");
    expect(unsealSecret(KEY, sealed)).toBe("EAABwzLixnjQ-token-material");
  });

  test("every seal uses a fresh IV (ciphertexts differ for the same plaintext)", () => {
    const a = sealSecret(KEY, "same-secret");
    const b = sealSecret(KEY, "same-secret");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("tampered ciphertext is detected (GCM auth tag)", () => {
    const sealed = sealSecret(KEY, "top-secret");
    const tampered = {
      ...sealed,
      ciphertext: Buffer.from("tampered-bytes-here!!").toString("base64"),
    };
    expect(() => unsealSecret(KEY, tampered)).toThrow(/integrity check/);
  });

  test("tampered auth tag is detected", () => {
    const sealed = sealSecret(KEY, "top-secret");
    const tampered = { ...sealed, authTag: Buffer.alloc(16, 3).toString("base64") };
    expect(() => unsealSecret(KEY, tampered)).toThrow(/integrity check/);
  });

  test("the wrong key cannot unseal", () => {
    const sealed = sealSecret(KEY, "top-secret");
    expect(() => unsealSecret(OTHER_KEY, sealed)).toThrow(/integrity check/);
  });
});

describe("TokenVault over an in-memory store", () => {
  function makeVault(auditLog?: Array<Record<string, unknown>>) {
    const vault = new TokenVault(new InMemoryVaultStore(), KEY, auditLog
      ? { async write(entry) { auditLog.push(entry as Record<string, unknown>); } }
      : undefined);
    return vault;
  }

  test("put -> get roundtrip via the vault:db: ref; audits never carry the secret", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const vault = makeVault(audits);
    const ref = await vault.put({ workspaceId: "ws-1", kind: "whatsapp", label: "waba:1", secret: "tok-123" });
    expect(ref.startsWith("vault:db:")).toBe(true);
    expect(await vault.get(ref)).toBe("tok-123");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "vault.put", workspaceId: "ws-1" });
    expect(JSON.stringify(audits)).not.toContain("tok-123");
  });

  test("store() matches the onboarding TokenVaultPort shape", async () => {
    const vault = makeVault();
    const ref = await vault.store({ channel: "whatsapp", workspaceId: "ws-1", label: "waba:9", secret: "tok-9" });
    expect(await vault.get(ref)).toBe("tok-9");
  });

  test("rotate replaces the secret under the SAME ref and audits the rotation", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const vault = makeVault(audits);
    const ref = await vault.put({ workspaceId: "ws-1", kind: "threads", secret: "old-token" });
    await vault.rotate(ref, "new-token", "user-1");
    expect(await vault.get(ref)).toBe("new-token");
    expect(audits.map((a) => a.action)).toEqual(["vault.put", "vault.rotate"]);
  });

  test("delete removes the entry; unknown and foreign refs resolve to null", async () => {
    const vault = makeVault();
    const ref = await vault.put({ workspaceId: "ws-1", kind: "telegram", secret: "bot-tok" });
    await vault.delete(ref);
    expect(await vault.get(ref)).toBeNull();
    expect(await vault.get("env:SOME_VAR")).toBeNull();
    expect(await vault.get(vaultRefFor("does-not-exist"))).toBeNull();
    expect(parseVaultRef("vault:memory:x")).toBeNull();
  });
});
