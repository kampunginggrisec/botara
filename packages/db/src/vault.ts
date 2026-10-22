import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "@botara/shared";
import type { Database } from "./client";
import {
  deleteTokenVaultEntry, getTokenVaultEntry, insertTokenVaultEntry, updateTokenVaultEntry,
} from "./repositories";

/**
 * Token vault (Fase 3) - the real home of channel secrets.
 *
 * Secrets are sealed with AES-256-GCM under a 32-byte key from
 * TOKEN_VAULT_KEY (base64). Only the sealed record (ciphertext + iv +
 * auth tag) touches Postgres; channel_accounts rows carry just the opaque
 * reference `vault:db:{entry id}`. Decryption fails CLOSED: a missing or
 * malformed key is a CONFIGURATION error, and any tampering with the sealed
 * record fails the GCM integrity check instead of returning garbage.
 */

export interface SealedSecret {
  ciphertext: string; // base64
  iv: string; // base64, 12 bytes
  authTag: string; // base64, 16 bytes
}

const VAULT_REF_PREFIX = "vault:db:";

/** The ref stored in channel_accounts.token_vault_ref for a vault entry. */
export function vaultRefFor(entryId: string): string {
  return `${VAULT_REF_PREFIX}${entryId}`;
}

/** Entry id when `ref` is a DB vault ref, otherwise null (env:/memory refs). */
export function parseVaultRef(ref: string | undefined | null): string | null {
  if (!ref || !ref.startsWith(VAULT_REF_PREFIX)) return null;
  const id = ref.slice(VAULT_REF_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Parse TOKEN_VAULT_KEY (base64, exactly 32 bytes). Fails closed with a
 * CONFIGURATION error - a vault that cannot encrypt must never silently
 * fall back to plaintext or a weaker mode.
 */
export function parseVaultKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === "") {
    throw new AppError(
      "CONFIGURATION",
      "TOKEN_VAULT_KEY is not configured; the token vault cannot encrypt or decrypt secrets.",
      { status: 503 },
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), "base64");
  } catch {
    key = Buffer.alloc(0);
  }
  if (key.length !== 32) {
    throw new AppError(
      "CONFIGURATION",
      `TOKEN_VAULT_KEY must be a base64-encoded 32-byte key (decoded ${key.length} bytes). Generate one with: openssl rand -base64 32`,
      { status: 503 },
    );
  }
  return key;
}

/** Seal one secret. A fresh random IV per call - GCM IV reuse is fatal, so never derive it. */
export function sealSecret(key: Buffer, plaintext: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Unseal one secret. Throws when the record was tampered with, the key is
 * wrong, or the sealed material is malformed - GCM's auth tag makes any
 * modification detectable.
 */
export function unsealSecret(key: Buffer, sealed: SealedSecret): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    throw new AppError(
      "INTERNAL",
      "Vault entry failed its integrity check (wrong TOKEN_VAULT_KEY or tampered ciphertext). Refusing to use the secret.",
      { status: 500 },
    );
  }
}

// ------------------------------------------------------------------ storage port

/** Persistence behind the vault - Drizzle in production, in-memory in tests. */
export interface VaultStore {
  insert(entry: {
    workspaceId: string;
    kind: string;
    label?: string;
    sealed: SealedSecret;
  }): Promise<{ id: string }>;
  getById(id: string): Promise<(SealedSecret & { workspaceId: string; kind: string }) | null>;
  update(id: string, sealed: SealedSecret): Promise<void>;
  delete(id: string): Promise<void>;
}

export function createDbVaultStore(db: Database): VaultStore {
  return {
    async insert(entry) {
      const row = await insertTokenVaultEntry(db, {
        workspaceId: entry.workspaceId,
        kind: entry.kind,
        label: entry.label,
        ciphertext: entry.sealed.ciphertext,
        iv: entry.sealed.iv,
        authTag: entry.sealed.authTag,
      });
      return { id: row.id };
    },
    async getById(id) {
      const row = await getTokenVaultEntry(db, id);
      if (!row) return null;
      return {
        workspaceId: row.workspaceId,
        kind: row.kind,
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
      };
    },
    async update(id, sealed) {
      await updateTokenVaultEntry(db, id, sealed);
    },
    async delete(id) {
      await deleteTokenVaultEntry(db, id);
    },
  };
}

/** In-memory VaultStore for tests and ephemeral dev runs. */
export class InMemoryVaultStore implements VaultStore {
  private readonly entries = new Map<string, SealedSecret & { workspaceId: string; kind: string }>();

  async insert(entry: { workspaceId: string; kind: string; label?: string; sealed: SealedSecret }) {
    const id = crypto.randomUUID();
    this.entries.set(id, { workspaceId: entry.workspaceId, kind: entry.kind, ...entry.sealed });
    return { id };
  }

  async getById(id: string) {
    return this.entries.get(id) ?? null;
  }

  async update(id: string, sealed: SealedSecret) {
    const existing = this.entries.get(id);
    if (existing) this.entries.set(id, { ...existing, ...sealed });
  }

  async delete(id: string) {
    this.entries.delete(id);
  }
}

// ---------------------------------------------------------------------- vault

export interface VaultAuditSink {
  write(entry: {
    workspaceId?: string;
    userId?: string;
    action: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

export class TokenVault {
  constructor(
    private readonly storage: VaultStore,
    private readonly key: Buffer,
    private readonly audit?: VaultAuditSink,
  ) {}

  /** Seal + persist a secret; returns the `vault:db:{id}` ref for channel_accounts. */
  async put(input: {
    workspaceId: string;
    kind: string;
    label?: string;
    secret: string;
    actorUserId?: string;
  }): Promise<string> {
    const sealed = sealSecret(this.key, input.secret);
    const { id } = await this.storage.insert({
      workspaceId: input.workspaceId,
      kind: input.kind,
      label: input.label,
      sealed,
    });
    await this.audit?.write({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      action: "vault.put",
      details: { entryId: id, kind: input.kind, label: input.label },
    });
    return vaultRefFor(id);
  }

  /**
   * TokenVaultPort-compatible store() for the WhatsApp onboarding flow
   * (apps/api/src/whatsapp-onboarding.ts) - same call shape, real vault.
   */
  async store(input: {
    channel: string;
    workspaceId: string;
    label: string;
    secret: string;
  }): Promise<string> {
    return this.put({
      workspaceId: input.workspaceId,
      kind: input.channel,
      label: input.label,
      secret: input.secret,
    });
  }

  /** Resolve a vault ref to its plaintext secret, or null when not a vault ref / not found. */
  async get(ref: string): Promise<string | null> {
    const id = parseVaultRef(ref);
    if (!id) return null;
    const entry = await this.storage.getById(id);
    if (!entry) return null;
    return unsealSecret(this.key, entry);
  }

  /** Replace the secret under an existing ref (the ref - and the account row - stay unchanged). */
  async rotate(ref: string, newSecret: string, actorUserId?: string): Promise<void> {
    const id = parseVaultRef(ref);
    if (!id) {
      throw new AppError("VALIDATION", `Cannot rotate a non-vault reference: ${ref}`, { status: 400 });
    }
    const existing = await this.storage.getById(id);
    if (!existing) {
      throw new AppError("NOT_FOUND", `Vault entry ${id} not found for rotation.`, { status: 404 });
    }
    await this.storage.update(id, sealSecret(this.key, newSecret));
    await this.audit?.write({
      workspaceId: existing.workspaceId,
      userId: actorUserId,
      action: "vault.rotate",
      details: { entryId: id, kind: existing.kind },
    });
  }

  async delete(ref: string): Promise<void> {
    const id = parseVaultRef(ref);
    if (id) await this.storage.delete(id);
  }
}

/**
 * Production factory: key from env (fail closed when missing/malformed),
 * storage from Postgres. API/worker wiring calls this when both
 * DATABASE_URL and TOKEN_VAULT_KEY are present.
 */
export function createTokenVault(
  db: Database,
  env: Record<string, string | undefined>,
  audit?: VaultAuditSink,
): TokenVault {
  return new TokenVault(createDbVaultStore(db), parseVaultKey(env.TOKEN_VAULT_KEY), audit);
}
