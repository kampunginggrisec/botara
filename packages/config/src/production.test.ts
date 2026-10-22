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
});
