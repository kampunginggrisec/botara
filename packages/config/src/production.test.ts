import { describe, expect, test } from "bun:test";
import { assertProductionEnv, missingProductionEnv, resolveBootEnv } from "./production";

describe("production env guard", () => {
  test("non-production environments never require secrets", () => {
    expect(missingProductionEnv({ NODE_ENV: "development" })).toEqual([]);
    expect(missingProductionEnv({})).toEqual([]);
    expect(() => assertProductionEnv({ NODE_ENV: "test" })).not.toThrow();
  });

  test("production without secrets lists every missing variable", () => {
    const missing = missingProductionEnv({ NODE_ENV: "production" });
    expect(missing).toEqual(["DATABASE_URL", "SESSION_SECRET", "TOKEN_VAULT_KEY"]);
    expect(() => assertProductionEnv({ NODE_ENV: "production" })).toThrow(
      /DATABASE_URL, SESSION_SECRET, TOKEN_VAULT_KEY/,
    );
  });

  test("production with all secrets passes; empty strings count as missing", () => {
    const full = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost:5432/botara",
      SESSION_SECRET: "s3cret",
      TOKEN_VAULT_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    expect(missingProductionEnv(full)).toEqual([]);
    expect(() => assertProductionEnv(full)).not.toThrow();
    expect(missingProductionEnv({ ...full, SESSION_SECRET: "  " })).toEqual(["SESSION_SECRET"]);
  });

  test("WhatsApp webhook and Embedded Signup settings require their Meta credentials", () => {
    const full = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost:5432/botara",
      SESSION_SECRET: "s3cret",
      TOKEN_VAULT_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    expect(missingProductionEnv({ ...full, WHATSAPP_VERIFY_TOKEN: "verify" }))
      .toEqual(["META_APP_SECRET (required when WHATSAPP_VERIFY_TOKEN is set)"]);
    expect(missingProductionEnv({ ...full, WHATSAPP_EMBEDDED_CONFIG_ID: "config-1" }))
      .toEqual([
        "META_APP_ID (required when WHATSAPP_EMBEDDED_CONFIG_ID is set)",
        "META_APP_SECRET (required when WHATSAPP_EMBEDDED_CONFIG_ID is set)",
      ]);
    expect(missingProductionEnv({
      ...full,
      WHATSAPP_VERIFY_TOKEN: "verify",
      WHATSAPP_EMBEDDED_CONFIG_ID: "config-1",
      META_APP_ID: "app-1",
      META_APP_SECRET: "secret",
    })).toEqual([]);
  });
});

describe("resolveBootEnv (boot gate judges the effective env)", () => {
  // The trial incident: WHATSAPP_VERIFY_TOKEN in the process env, every
  // Meta secret stored ONLY in the admin panel (DB overlay).
  const RAW = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost:5432/botara",
    SESSION_SECRET: "s3cret",
    TOKEN_VAULT_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    WHATSAPP_VERIFY_TOKEN: "verify",
  };

  test("panel-only META_APP_SECRET satisfies the gate", async () => {
    const boot = await resolveBootEnv(RAW, {
      loadEffective: async (base) => ({ ...base, META_APP_SECRET: "from-panel" }),
    });
    expect(boot.META_APP_SECRET).toBe("from-panel");
    expect(missingProductionEnv(boot)).toEqual([]);
    expect(() => assertProductionEnv(boot)).not.toThrow();
  });

  test("panel-only Embedded Signup settings satisfy the gate", async () => {
    const boot = await resolveBootEnv(RAW, {
      loadEffective: async (base) => ({
        ...base,
        WHATSAPP_EMBEDDED_CONFIG_ID: "config-1",
        META_APP_ID: "app-1",
        META_APP_SECRET: "from-panel",
      }),
    });
    expect(missingProductionEnv(boot)).toEqual([]);
    expect(() => assertProductionEnv(boot)).not.toThrow();
  });

  test("negative control: gate still refuses when neither env nor panel has META_APP_SECRET", async () => {
    const boot = await resolveBootEnv(RAW, {
      loadEffective: async (base) => ({ ...base }),
    });
    expect(missingProductionEnv(boot)).toEqual([
      "META_APP_SECRET (required when WHATSAPP_VERIFY_TOKEN is set)",
    ]);
    expect(() => assertProductionEnv(boot)).toThrow(/META_APP_SECRET/);
  });

  test("env-only path: without DATABASE_URL/TOKEN_VAULT_KEY the loader is never invoked", async () => {
    let invoked = false;
    const loader = async (base: Record<string, string | undefined>) => {
      invoked = true;
      return { ...base, META_APP_SECRET: "from-panel" };
    };
    const noDb = {
      NODE_ENV: "production",
      SESSION_SECRET: "s3cret",
      WHATSAPP_VERIFY_TOKEN: "verify",
    };
    // Raw env returned untouched - the panel value must NOT leak in.
    expect(await resolveBootEnv(noDb, { loadEffective: loader })).toBe(noDb);
    expect(invoked).toBe(false);
    expect(() => assertProductionEnv(noDb)).toThrow(/META_APP_SECRET/);
    // Same path with the secret in env: passes, still without the loader.
    const withSecret = { ...noDb, DATABASE_URL: undefined, META_APP_SECRET: "from-env" };
    expect(await resolveBootEnv(withSecret, { loadEffective: loader })).toBe(withSecret);
    expect(invoked).toBe(false);
  });

  test("no loader wired: raw env is judged exactly as before", async () => {
    expect(await resolveBootEnv(RAW)).toBe(RAW);
    expect(() => assertProductionEnv(RAW)).toThrow(/META_APP_SECRET/);
    const withSecret = { ...RAW, META_APP_SECRET: "from-env" };
    expect(await resolveBootEnv(withSecret)).toBe(withSecret);
    expect(() => assertProductionEnv(withSecret)).not.toThrow();
  });

  test("overlay load failure falls back to raw-env gating (and reports the error)", async () => {
    const boom = new Error("db unreachable");
    const seen: unknown[] = [];
    const options = {
      loadEffective: async (): Promise<Record<string, string | undefined>> => {
        throw boom;
      },
      onOverlayError: (err: unknown) => {
        seen.push(err);
      },
    };
    // Raw env lacks the secret -> the fallback keeps the refusal.
    const bootRaw = await resolveBootEnv(RAW, options);
    expect(bootRaw).toBe(RAW);
    expect(seen).toEqual([boom]);
    expect(() => assertProductionEnv(bootRaw)).toThrow(/META_APP_SECRET/);
    // Raw env has the secret -> the fallback still boots on env alone.
    const rawWithSecret = { ...RAW, META_APP_SECRET: "from-env" };
    const bootEnvOnly = await resolveBootEnv(rawWithSecret, options);
    expect(bootEnvOnly).toBe(rawWithSecret);
    expect(() => assertProductionEnv(bootEnvOnly)).not.toThrow();
    expect(seen).toEqual([boom, boom]);
  });
});
