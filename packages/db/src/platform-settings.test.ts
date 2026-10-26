import { describe, expect, test } from "bun:test";
import {
  InMemoryPlatformSettingsStorage, MANAGED_SETTINGS, PlatformSettingsService,
  applyEffectiveEnv, sealSettingValue, unsealSettingValue, type EnvLike,
} from "./platform-settings";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

function makeService(baseEnv: EnvLike = {}, liveEnv?: EnvLike) {
  const storage = new InMemoryPlatformSettingsStorage();
  const service = new PlatformSettingsService(storage, { baseEnv, liveEnv, vaultKey: KEY });
  return { storage, service };
}

describe("managed-key registry", () => {
  test("covers every credential family the code reads, secrets flagged", () => {
    const byKey = new Map(MANAGED_SETTINGS.map((d) => [d.key, d]));
    for (const key of [
      "META_APP_ID", "META_APP_SECRET", "WHATSAPP_EMBEDDED_CONFIG_ID",
      "META_VERIFY_TOKEN", "WHATSAPP_VERIFY_TOKEN",
      "THREADS_APP_ID", "THREADS_APP_SECRET",
      "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET",
      "TIKTOK_APP_ID", "TIKTOK_APP_SECRET",
      "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE_URL",
      "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET",
      "AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_EMBEDDING_MODEL",
    ]) {
      expect(byKey.has(key)).toBe(true);
    }
    expect(byKey.get("META_APP_SECRET")?.secret).toBe(true);
    expect(byKey.get("META_APP_ID")?.secret).toBe(false);
    // Bootstrap secrets are NOT panel-managed by design.
    for (const key of ["SESSION_SECRET", "TOKEN_VAULT_KEY", "DATABASE_URL", "REDIS_URL"]) {
      expect(byKey.has(key)).toBe(false);
    }
    // Declared in the env schema/examples but never read by runtime code.
    expect(byKey.has("RESEND_FROM_EMAIL")).toBe(false);
  });
});

describe("sealed setting blobs", () => {
  test("roundtrip restores the plaintext; wrong key fails the integrity check", () => {
    const blob = sealSettingValue(KEY, "super-secret-value");
    expect(blob).not.toContain("super-secret-value");
    expect(unsealSettingValue(KEY, blob)).toBe("super-secret-value");
    expect(() => unsealSettingValue(OTHER_KEY, blob)).toThrow();
  });
});

describe("resolution order: DB -> env -> unset", () => {
  test("env value resolves when no DB row exists; unset key resolves undefined", async () => {
    const { service } = makeService({ META_APP_ID: "env-app-id" });
    expect(await service.resolveValue("META_APP_ID")).toBe("env-app-id");
    expect(await service.resolveValue("THREADS_APP_ID")).toBeUndefined();
  });

  test("DB value wins over env; secret DB value roundtrips through encryption", async () => {
    const { service, storage } = makeService({ META_APP_ID: "env-app-id", META_APP_SECRET: "env-secret" });
    await service.setValue("META_APP_ID", "db-app-id", "admin-1");
    await service.setValue("META_APP_SECRET", "db-secret", "admin-1");
    expect(await service.resolveValue("META_APP_ID")).toBe("db-app-id");
    expect(await service.resolveValue("META_APP_SECRET")).toBe("db-secret");
    // The stored secret row holds ciphertext only, never the plaintext.
    const row = storage.rows.get("META_APP_SECRET");
    expect(row?.value).toBeNull();
    expect(row?.secretCiphertext).toBeTruthy();
    expect(row?.secretCiphertext).not.toContain("db-secret");
    expect(row?.updatedBy).toBe("admin-1");
  });

  test("clearing the DB value falls back to env", async () => {
    const { service } = makeService({ META_APP_ID: "env-app-id" });
    await service.setValue("META_APP_ID", "db-app-id");
    expect(await service.resolveValue("META_APP_ID")).toBe("db-app-id");
    await service.clearValue("META_APP_ID");
    expect(await service.resolveValue("META_APP_ID")).toBe("env-app-id");
    const view = await service.getView("META_APP_ID");
    expect(view.source).toBe("env");
    expect(view.isSet).toBe(true);
  });

  test("views report source db/env/null; a secret value never appears", async () => {
    const { service } = makeService({ R2_BUCKET: "env-bucket" });
    await service.setValue("AI_API_KEY", "sk-live-123");
    const views = await service.listViews();
    const byKey = new Map(views.map((v) => [v.key, v]));
    expect(byKey.get("AI_API_KEY")).toMatchObject({ isSet: true, source: "db", secret: true });
    expect(byKey.get("R2_BUCKET")).toMatchObject({ isSet: true, source: "env", secret: false });
    expect(byKey.get("TIKTOK_APP_ID")).toMatchObject({ isSet: false, source: null });
    expect(JSON.stringify(views)).not.toContain("sk-live-123");
  });

  test("views expose the resolved value for NON-secret keys only", async () => {
    const { service } = makeService({ R2_BUCKET: "env-bucket", META_APP_SECRET: "env-secret-value" });
    await service.setValue("AI_API_KEY", "sk-live-123");
    await service.setValue("META_APP_ID", "db-app-id");
    const views = await service.listViews();
    const byKey = new Map(views.map((v) => [v.key, v]));
    // Non-secret: DB value wins, env value is the fallback, unset is null.
    expect(byKey.get("META_APP_ID")?.value).toBe("db-app-id");
    expect(byKey.get("R2_BUCKET")?.value).toBe("env-bucket");
    expect(byKey.get("TIKTOK_APP_ID")?.value).toBeNull();
    // Secret: value is ALWAYS null, from DB or env alike.
    expect(byKey.get("AI_API_KEY")?.value).toBeNull();
    expect(byKey.get("META_APP_SECRET")?.value).toBeNull();
    const json = JSON.stringify(views);
    expect(json).not.toContain("sk-live-123");
    expect(json).not.toContain("env-secret-value");
  });

  test("unmanaged keys are rejected with 400 VALIDATION", async () => {
    const { service } = makeService();
    await expect(service.setValue("SESSION_SECRET", "x")).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    await expect(service.clearValue("DATABASE_URL")).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  test("secret writes fail closed (503) without a vault key", async () => {
    const storage = new InMemoryPlatformSettingsStorage();
    const service = new PlatformSettingsService(storage, { baseEnv: {}, vaultKey: null });
    await expect(service.setValue("META_APP_SECRET", "x")).rejects.toMatchObject({ code: "CONFIGURATION", status: 503 });
    // Plain values still work without a vault key.
    await service.setValue("META_APP_ID", "app-1");
    expect(await service.resolveValue("META_APP_ID")).toBe("app-1");
  });
});

describe("effective-env overlay", () => {
  test("applyEffectiveEnv overlays DB values, keeps env fallback, deletes unset managed keys", async () => {
    const live: EnvLike = { META_APP_ID: "env-app-id", UNRELATED: "keep" };
    const { service } = makeService({ META_APP_ID: "env-app-id" }, live);
    await service.setValue("META_APP_ID", "db-app-id");
    expect(live.META_APP_ID).toBe("db-app-id"); // writer process sees it immediately
    await service.clearValue("META_APP_ID");
    expect(live.META_APP_ID).toBe("env-app-id"); // clear restores the env fallback

    const dbValues = await service.resolveDbValues();
    const target: EnvLike = { META_APP_ID: "env-app-id", AI_MODEL: "stale", UNRELATED: "keep" };
    applyEffectiveEnv(target, { META_APP_ID: "env-app-id", ...dbValues });
    expect(target.META_APP_ID).toBe("env-app-id");
    expect("AI_MODEL" in target).toBe(false); // managed + unset everywhere -> removed
    expect(target.UNRELATED).toBe("keep"); // non-managed keys are never touched
  });

  test("a refresh cycle picks up a changed DB value", async () => {
    // startEffectiveEnvRefresh's refreshNow() is exactly this composition:
    // resolveEffectiveEnv (= base + service.resolveDbValues()) followed by
    // applyEffectiveEnv onto the live target. Exercised here over the
    // in-memory storage; the Db storage path differs only in persistence.
    const storage = new InMemoryPlatformSettingsStorage();
    const baseEnv: EnvLike = { META_APP_ID: "env-app-id" };
    const service = new PlatformSettingsService(storage, { baseEnv, vaultKey: KEY });
    const target: EnvLike = { ...baseEnv };
    const refreshNow = async () => {
      applyEffectiveEnv(target, { ...baseEnv, ...(await service.resolveDbValues()) });
    };
    await service.setValue("META_APP_SECRET", "rotated-secret");
    await service.setValue("META_APP_ID", "rotated-app-id");
    expect(target.META_APP_ID).toBe("env-app-id"); // unchanged until a refresh runs
    expect(target.META_APP_SECRET).toBeUndefined();
    await refreshNow();
    expect(target.META_APP_ID).toBe("rotated-app-id");
    expect(target.META_APP_SECRET).toBe("rotated-secret"); // decrypted during the overlay
  });
});
