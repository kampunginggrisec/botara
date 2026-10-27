import type { ChannelAccountRef, ChannelAdapter, ChannelKey, FetchLike } from "@botara/channels";
import { resolveWabaIdForNumber } from "./template-sync";

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
  /** App ids Meta reports as subscribed to the WABA (empty when unknown). */
  appIds: string[];
  /** Why the answer is null, when it is. */
  detail?: string;
}

export interface ChannelHealthReport {
  accountId: string;
  channel: string;
  /** false when the credential is missing OR the app is provably unsubscribed. */
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
 * Meta answers `{ data: [{ waba_id, app_id, ... }] }`. Only `app_id` is
 * kept: the rest of the row (link time, permissions) is not something the
 * dashboard shows, and copying unknown fields would make this parser
 * fragile against Meta's additions.
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
    data?: Array<{ app_id?: string | number }>;
    error?: { message?: string };
  };
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `subscribed_apps answered HTTP ${res.status}`);
  }
  return (json.data ?? [])
    .map((row) => (row.app_id === undefined ? "" : String(row.app_id)))
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
      const ok = base.ok && appSubscription.subscribed !== false;
      return {
        accountId: input.account.id,
        channel: input.channel,
        ok,
        detail: appSubscription.subscribed === false
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
  try {
    wabaId = await resolveWabaIdForNumber(deps, { token, phoneNumberId: account.externalId });
  } catch (err) {
    return unknown(err instanceof Error ? err.message : String(err));
  }

  let appIds: string[];
  try {
    appIds = await readSubscribedAppIds(deps, { token, wabaId });
  } catch (err) {
    return unknown(err instanceof Error ? err.message : String(err), wabaId);
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
