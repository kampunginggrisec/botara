import type { ChannelAccountRef, ChannelAdapter, ChannelKey, FetchLike } from "@botara/channels";
import { resolveWabaIdForNumber, storedWabaIdForAccount } from "./template-sync";

/**
 * Per-account channel health (P2-2).
 *
 * `adapter.health()` only ever answered "do I have a credential?" - it
 * never touched the network, and nothing called it. That leaves the
 * failure that actually breaks a WhatsApp account invisible: the app is
 * no longer SUBSCRIBED to the WABA, so sends work and inbound messages
 * silently stop arriving. Embedded Signup subscribes once and reports
 * `appSubscription: "failed"` a single time; after that nothing ever
 * re-checks, which is exactly how the 2026-10-27 test-number incident
 * looked from the dashboard.
 *
 * This port answers, per account:
 *   1. does the adapter have a usable credential? (adapter.health)
 *   2. WhatsApp only: is our app in `GET /{waba}/subscribed_apps`?
 *
 * The second answer is deliberately TRI-STATE: `subscribed: null` means
 * "could not be determined" (no app id configured, no token, or the Graph
 * call failed) and must never be rendered as "unsubscribed" - a false
 * alarm on a healthy account is worse than an honest "unknown".
 */

export interface AppSubscriptionReport {
  /** The WABA the number belongs to; null when discovery failed. */
  wabaId: string | null;
  /** true = our app is subscribed, false = it is not, null = unknown. */
  subscribed: boolean | null;
  /**
   * Meta rejected the account's access token itself (Graph 190: expired
   * or invalid). Distinct from an ordinary "unknown": the credential is
   * provably dead, so the overall verdict must not stay healthy.
   */
  tokenRejected?: boolean;
  /** App ids Meta reports as subscribed to the WABA (empty when unknown). */
  appIds: string[];
  /** Why the answer is null, when it is. */
  detail?: string;
}

export interface ChannelHealthReport {
  accountId: string;
  channel: string;
  /** false when the credential is missing, Meta rejected the token, OR the app is provably unsubscribed. */
  ok: boolean;
  detail: string;
  checkedAt: string;
  /** WhatsApp accounts only. */
  appSubscription?: AppSubscriptionReport;
}

export interface ChannelHealthInput {
  account: ChannelAccountRef;
  channel: string;
}

export interface ChannelHealthPort {
  check(input: ChannelHealthInput): Promise<ChannelHealthReport>;
}

export interface ChannelHealthDeps {
  fetchFn: FetchLike;
  graphVersion?: string;
  baseUrl?: string;
  /**
   * The Meta app id whose subscription is verified. Absent in a deployment
   * that has not configured META_APP_ID - the report then says so instead
   * of guessing.
   */
  appId?: string | null;
  /** Resolve the account's Graph token (vault, env fallback). */
  resolveAccessToken: (account: ChannelAccountRef) => Promise<string | null>;
  getAdapter: (channel: ChannelKey) => ChannelAdapter;
}

/**
 * Read `GET /{waba-id}/subscribed_apps`.
 *
 * Meta's real answer nests the app under `whatsapp_business_api_data`:
 * `{ data: [{ whatsapp_business_api_data: { id, name, link } }] }` (shape
 * taken from Meta's official WhatsApp Business Management Postman
 * collection). This parser originally read a flat `app_id` key that the
 * fixture invented - against real Meta it matched nothing, so EVERY
 * account reported "app NOT subscribed" (false alarm, found live
 * 2026-10-28). Flat `app_id`/`id` keys are still tolerated defensively.
 * A Graph error is rethrown with its `code` attached (`graphCode`) so
 * callers can tell a rejected token (190) from an ordinary failure.
 */
export async function readSubscribedAppIds(
  deps: Pick<ChannelHealthDeps, "fetchFn" | "graphVersion" | "baseUrl">,
  input: { token: string; wabaId: string },
): Promise<string[]> {
  const version = deps.graphVersion ?? "v26.0";
  const base = (deps.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  const res = await deps.fetchFn(`${base}/${version}/${input.wabaId}/subscribed_apps`, {
    headers: { Authorization: `Bearer ${input.token}` },
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: Array<{
      whatsapp_business_api_data?: { id?: string | number };
      app_id?: string | number;
      id?: string | number;
    }>;
    error?: { message?: string; code?: number };
  };
  if (!res.ok || json.error) {
    const err = new Error(
      json.error?.message ?? `subscribed_apps answered HTTP ${res.status}`,
    ) as Error & { graphCode?: number };
    if (json.error?.code !== undefined) err.graphCode = json.error.code;
    throw err;
  }
  return (json.data ?? [])
    .map((row) => row.whatsapp_business_api_data?.id ?? row.app_id ?? row.id)
    .map((id) => (id === undefined || id === null ? "" : String(id)))
    .filter((id) => id.length > 0);
}

export function createChannelHealthPort(deps: ChannelHealthDeps): ChannelHealthPort {
  return {
    async check(input: ChannelHealthInput): Promise<ChannelHealthReport> {
      const checkedAt = new Date().toISOString();
      const base = await (async () => {
        try {
          const adapter = deps.getAdapter(input.channel as ChannelKey);
          return await adapter.health(input.account);
        } catch (err) {
          // A channel with no adapter (or a throwing probe) is unhealthy,
          // not an API error: the report is the answer.
          return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      })();

      if (input.channel !== "whatsapp") {
        return {
          accountId: input.account.id,
          channel: input.channel,
          ok: base.ok,
          detail: base.detail,
          checkedAt,
        };
      }

      const appSubscription = await checkAppSubscription(deps, input.account);
      const ok = base.ok && appSubscription.subscribed !== false && appSubscription.tokenRejected !== true;
      return {
        accountId: input.account.id,
        channel: input.channel,
        ok,
        detail: appSubscription.tokenRejected
          ? `${base.detail}; Meta rejected the access token (expired or invalid) - reconnect this account`
          : appSubscription.subscribed === false
            ? `${base.detail}; the app is NOT subscribed to WABA ${appSubscription.wabaId} - inbound messages will not arrive`
            : base.detail,
        checkedAt,
        appSubscription,
      };
    },
  };
}

async function checkAppSubscription(
  deps: ChannelHealthDeps,
  account: ChannelAccountRef,
): Promise<AppSubscriptionReport> {
  const unknown = (detail: string, wabaId: string | null = null): AppSubscriptionReport => ({
    wabaId,
    subscribed: null,
    appIds: [],
    detail,
  });

  const token = await deps.resolveAccessToken(account).catch(() => null);
  if (!token) return unknown("No access token is resolvable for this account, so the subscription cannot be checked.");

  let wabaId: string;
  const storedWabaId = storedWabaIdForAccount(account);
  if (storedWabaId) {
    wabaId = storedWabaId;
  } else {
    try {
      wabaId = await resolveWabaIdForNumber(deps, { token, phoneNumberId: account.externalId });
    } catch (err) {
      return unknown(err instanceof Error ? err.message : String(err));
    }
  }

  let appIds: string[];
  try {
    appIds = await readSubscribedAppIds(deps, { token, wabaId });
  } catch (err) {
    // Graph 190 means Meta rejected the token itself (expired/invalid) -
    // that is a proven-dead credential, not an ordinary "unknown".
    const tokenRejected = (err as { graphCode?: number })?.graphCode === 190;
    return {
      ...unknown(err instanceof Error ? err.message : String(err), wabaId),
      ...(tokenRejected ? { tokenRejected: true } : {}),
    };
  }

  if (!deps.appId) {
    return {
      wabaId,
      subscribed: null,
      appIds,
      detail: "META_APP_ID is not configured, so this deployment cannot tell which subscribed app is ours.",
    };
  }
  return { wabaId, subscribed: appIds.includes(String(deps.appId)), appIds };
}
