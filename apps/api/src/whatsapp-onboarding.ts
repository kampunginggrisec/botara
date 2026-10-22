import { AppError } from "@botara/shared";
import { CHANNEL_CAPABILITIES, type FetchLike } from "@botara/channels";

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
 *
 * The returned summary contains NO token material - a test asserts this.
 */

export interface TokenVaultPort {
  /** Persist a secret and return an opaque reference for channel_accounts.token_vault_ref. */
  store(input: { channel: string; workspaceId: string; label: string; secret: string }): Promise<string>;
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

  /** Test/dev only: read a secret back by ref. Never exposed over HTTP. */
  get(ref: string): string | undefined {
    return this.entries.get(ref);
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

export interface EmbeddedSignupResult {
  wabaId: string;
  isCoexistence: boolean;
  accounts: OnboardedPhoneNumber[];
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
    apiVersion: string;
    capabilities: Record<string, unknown>;
    isCoexistence: boolean;
    tokenVaultRef: string;
    status: string;
  }): Promise<{ id: string }>;
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

  // 5) Persist one channel account per phone number.
  const accounts: OnboardedPhoneNumber[] = [];
  for (const number of selected) {
    const persisted = await deps.persistAccount({
      workspaceId,
      channel: "whatsapp",
      externalId: number.id,
      displayName: number.verified_name ?? number.display_phone_number,
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

  return { wabaId, isCoexistence, accounts };
}
