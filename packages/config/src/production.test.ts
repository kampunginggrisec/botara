import { describe, expect, test } from "bun:test";
import { assertProductionEnv, missingProductionEnv } from "./production";

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
