import { AppError } from "@botara/shared";
import { CHANNEL_CAPABILITIES, type FetchLike } from "@botara/channels";
import {
  createChannelAccount, listChannelAccounts, updateChannelAccountAvatar, updateChannelAccountToken,
  type Database,
} from "@botara/db";

/**
 * WhatsApp Embedded Signup v4 - server-side code exchange (Fase 2).
 *
 * The browser flow (Facebook Login for Business with an Embedded Signup
 * configuration) ends with a `code` plus session info (WABA id, phone
 * number id, coexistence flag). This module performs the server half:
 *
 *   1. GET /{version}/oauth/access_token        code -> business token
 *   2. GET /{version}/debug_token               token -> granular scopes -> WABA id(s)
 *   3. GET /{version}/{wabaId}/phone_numbers    discover the onboarded numbers
 *   4. vault.store(token)                       raw token goes ONLY into the vault
 *   5. persist one channel_accounts row per phone number (vault ref, never the token)
 *   6. coexistence only: POST /{phone}/smb_app_data for both sync types
 *      (contacts + history) - best-effort, outcomes reported in the result
 *
 * The returned summary contains NO token material - a test asserts this.
 */

export interface TokenVaultPort {
  /** Persist a secret and return an opaque reference for channel_accounts.token_vault_ref. */
  store(input: { channel: string; workspaceId: string; label: string; secret: string }): Promise<string>;
  /** Resolve a vault ref back to its secret (server-side only, e.g. the Telegram avatar proxy); null when unknown. */
  get(ref: string): Promise<string | null>;
  /** Remove the secret behind a vault ref; unknown refs are a no-op. */
  delete(ref: string): Promise<void>;
}

/**
 * Dev-only vault: keeps secrets in process memory so the onboarding flow is
 * exercisable locally. Tokens are lost on restart and this MUST be replaced
 * by a real vault/KMS before production - the API logs a warning on use.
 */
export class InMemoryVault implements TokenVaultPort {
  private readonly entries = new Map<string, string>();
  private warned = false;

  async store(input: { channel: string; workspaceId: string; label: string; secret: string }): Promise<string> {
    if (!this.warned) {
      console.warn("[api] WARNING: InMemoryVault in use - tokens live in process memory only. Configure a real vault before production.");
      this.warned = true;
    }
    const ref = `vault:memory:${input.channel}:${input.workspaceId}:${crypto.randomUUID()}`;
    this.entries.set(ref, input.secret);
    return ref;
  }

  async delete(ref: string): Promise<void> {
    this.entries.delete(ref);
  }

  /** Read a secret back by ref; null when unknown. Never exposed over HTTP. */
  async get(ref: string): Promise<string | null> {
    return this.entries.get(ref) ?? null;
  }
}

export interface EmbeddedSignupSessionInfo {
  wabaId?: string;
  phoneNumberId?: string;
  /** Business App + Cloud API on the same number (Embedded Signup "coex"). */
  isCoexistence?: boolean;
}

export interface EmbeddedSignupInput {
  code: string;
  sessionInfo?: EmbeddedSignupSessionInfo;
}

export interface OnboardedPhoneNumber {
  phoneNumberId: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  channelAccountId: string;
}

/** Outcome of one coexistence sync request (POST /{phone}/smb_app_data). */
export type CoexistenceSyncOutcome = "requested" | "already-requested" | "failed";

export interface CoexistenceSyncRequests {
  phoneNumberId: string;
  smbAppStateSync: CoexistenceSyncOutcome;
  history: CoexistenceSyncOutcome;
}

export interface EmbeddedSignupResult {
  wabaId: string;
  isCoexistence: boolean;
  accounts: OnboardedPhoneNumber[];
  /**
   * Coexistence only: the contact + history sync requests issued to
   * Meta right after provisioning (nothing is delivered until asked).
   * Best-effort - a "failed" outcome never fails the onboarding itself.
   */
  syncRequests?: CoexistenceSyncRequests[];
  // Deliberately NO access token / vault internals in this summary.
}

export interface WhatsAppOnboardingDeps {
  fetchFn: FetchLike;
  graphVersion?: string;
  baseUrl?: string;
  appId?: string;
  appSecret?: string;
  vault: TokenVaultPort;
  /** Persist one channel account; returns the created row id. */
  persistAccount(input: {
    workspaceId: string;
    channel: "whatsapp";
    externalId: string;
    displayName?: string;
    /** Public profile-picture URL captured best-effort during the exchange. */
    avatarUrl?: string;
    apiVersion: string;
    capabilities: Record<string, unknown>;
    isCoexistence: boolean;
    tokenVaultRef: string;
    status: string;
  }): Promise<{ id: string }>;
}

/**
 * Production `persistAccount` for Embedded Signup: an UPSERT keyed by
 * (workspace, channel, externalId). Re-running the signup for a number
 * that already has a row - above all after a soft disconnect -
 * reactivates THAT row (status back to "connected", fresh vault ref,
 * refreshed avatar when Meta returned one) instead of inserting a
 * duplicate account for the same number.
 */
export function createDbWhatsAppAccountPersister(
  getDatabase: () => Database,
): WhatsAppOnboardingDeps["persistAccount"] {
  return async (input) => {
    const db = getDatabase();
    const existing = (await listChannelAccounts(db, input.workspaceId))
      .find((a) => a.channel === input.channel && a.externalId === input.externalId);
    if (existing) {
      await updateChannelAccountToken(db, existing.id, {
        tokenVaultRef: input.tokenVaultRef,
        status: "connected",
        // Item G: reconnecting cancels the retention countdown.
        disconnectedAt: null,
      });
      if (input.avatarUrl) {
        await updateChannelAccountAvatar(db, existing.id, input.avatarUrl);
      }
      return { id: existing.id };
    }
    const row = await createChannelAccount(db, input);
    return { id: row.id };
  };
}

interface GraphJson {
  access_token?: string;
  data?: any;
  error?: { message?: string; code?: number; fbtrace_id?: string };
}

export async function exchangeEmbeddedSignup(
  deps: WhatsAppOnboardingDeps,
  workspaceId: string,
  input: EmbeddedSignupInput,
): Promise<EmbeddedSignupResult> {
  const version = deps.graphVersion ?? "v26.0";
  const base = (deps.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  if (!deps.appId || !deps.appSecret) {
    throw new AppError(
      "CONFIGURATION",
      "Meta app credentials are not configured (META_APP_ID / META_APP_SECRET); Embedded Signup exchange is unavailable.",
      { status: 503 },
    );
  }
  if (!input.code) {
    throw new AppError("VALIDATION", "Embedded Signup exchange requires the authorization `code`.", { status: 400 });
  }
  const appId: string = deps.appId;
  const appSecret: string = deps.appSecret;

  async function graphGet(path: string, params: Record<string, string>): Promise<GraphJson> {
    const url = new URL(`${base}/${version}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await deps.fetchFn(url.toString());
    const json = (await res.json().catch(() => ({}))) as GraphJson;
    if (!res.ok || json.error) {
      throw new AppError(
        "PROVIDER_ERROR",
        `Embedded Signup exchange failed at ${path}: ${json.error?.message ?? `HTTP ${res.status}`}`,
        { status: 502, details: { provider: "whatsapp", fbtraceId: json.error?.fbtrace_id, step: path } },
      );
    }
    return json;
  }

  // 1) code -> business access token.
  const tokenJson = await graphGet("oauth/access_token", {
    client_id: appId,
    client_secret: appSecret,
    code: input.code,
  });
  const accessToken = tokenJson.access_token;
  if (!accessToken) {
    throw new AppError("PROVIDER_ERROR", "Embedded Signup exchange returned no access token.", { status: 502 });
  }

  // 2) debug_token -> granular scopes -> WABA id (session info wins).
  let wabaId = input.sessionInfo?.wabaId;
  if (!wabaId) {
    const debug = await graphGet("debug_token", {
      input_token: accessToken,
      access_token: `${appId}|${appSecret}`,
    });
    const scopes = (debug.data?.granular_scopes as Array<{ scope?: string; target_ids?: string[] }> | undefined) ?? [];
    for (const scope of scopes) {
      if (
        (scope.scope === "whatsapp_business_management" || scope.scope === "whatsapp_business_messaging")
        && scope.target_ids?.length
      ) {
        wabaId = scope.target_ids[0];
        break;
      }
    }
  }
  if (!wabaId) {
    throw new AppError(
      "PROVIDER_ERROR",
      "Could not determine the WhatsApp Business Account id (no WABA in session info or token granular scopes).",
      { status: 502 },
    );
  }

  // 3) Discover the WABA's phone numbers.
  const numbersJson = await graphGet(`${wabaId}/phone_numbers`, { access_token: accessToken });
  const numbers = (numbersJson.data as Array<{ id: string; display_phone_number?: string; verified_name?: string }> | undefined) ?? [];
  const wanted = input.sessionInfo?.phoneNumberId;
  const selected = wanted ? numbers.filter((n) => n.id === wanted) : numbers;
  if (selected.length === 0) {
    throw new AppError("PROVIDER_ERROR", `WABA ${wabaId} returned no phone numbers for this signup.`, { status: 502 });
  }

  // 4) The raw token goes into the vault ONLY. Accounts store the ref.
  const isCoexistence = input.sessionInfo?.isCoexistence ?? false;
  const tokenVaultRef = await deps.vault.store({
    channel: "whatsapp",
    workspaceId,
    label: `waba:${wabaId}`,
    secret: accessToken,
  });

  // 5) Persist one channel account per phone number. The business profile
  // picture is captured best-effort per number first: the profile GET
  // answers either a flat object or a { data: [profile] } envelope
  // depending on the surface, so both shapes are accepted; any failure
  // just leaves the account without an avatar.
  const fetchProfilePictureUrl = async (phoneNumberId: string): Promise<string | undefined> => {
    try {
      const url = new URL(`${base}/${version}/${phoneNumberId}/whatsapp_business_profile`);
      url.searchParams.set("fields", "profile_picture_url");
      const res = await deps.fetchFn(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return undefined;
      const json = (await res.json().catch(() => ({}))) as {
        profile_picture_url?: string;
        data?: Array<{ profile_picture_url?: string }>;
      };
      return json.profile_picture_url ?? json.data?.[0]?.profile_picture_url;
    } catch {
      return undefined;
    }
  };
  const accounts: OnboardedPhoneNumber[] = [];
  for (const number of selected) {
    const persisted = await deps.persistAccount({
      workspaceId,
      channel: "whatsapp",
      externalId: number.id,
      displayName: number.verified_name ?? number.display_phone_number,
      avatarUrl: await fetchProfilePictureUrl(number.id),
      apiVersion: version,
      capabilities: CHANNEL_CAPABILITIES.whatsapp as unknown as Record<string, unknown>,
      isCoexistence,
      tokenVaultRef,
      status: "connected",
    });
    accounts.push({
      phoneNumberId: number.id,
      displayPhoneNumber: number.display_phone_number,
      verifiedName: number.verified_name,
      channelAccountId: persisted.id,
    });
  }

  // 6) Coexistence: ask Meta for the phone's contacts and chat history.
  // Nothing arrives until requested (POST /{phone-number-id}/smb_app_data),
  // Meta only accepts the request shortly after onboarding, and each sync
  // type can be requested once - error 135000 means it was already
  // requested and counts as done. Best-effort by design: the webhooks
  // (smb_app_state_sync / history) are ingested by the dispatcher whenever
  // they arrive, and a failed request must not roll back a good signup.
  let syncRequests: CoexistenceSyncRequests[] | undefined;
  if (isCoexistence) {
    const requestSync = async (
      phoneNumberId: string,
      syncType: "smb_app_state_sync" | "history",
    ): Promise<CoexistenceSyncOutcome> => {
      try {
        const res = await deps.fetchFn(`${base}/${version}/${phoneNumberId}/smb_app_data`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", sync_type: syncType }),
        });
        const json = (await res.json().catch(() => ({}))) as GraphJson;
        if (res.ok && !json.error) return "requested";
        if (json.error?.code === 135000) return "already-requested";
        return "failed";
      } catch {
        return "failed";
      }
    };
    syncRequests = [];
    for (const account of accounts) {
      syncRequests.push({
        phoneNumberId: account.phoneNumberId,
        smbAppStateSync: await requestSync(account.phoneNumberId, "smb_app_state_sync"),
        history: await requestSync(account.phoneNumberId, "history"),
      });
    }
  }

  return { wabaId, isCoexistence, accounts, ...(syncRequests ? { syncRequests } : {}) };
}
