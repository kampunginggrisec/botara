import { describe, expect, test } from "bun:test";
import { verifyWebhookSignature } from "@botara/shared/webhook-signing";
import {
  processOutboundWebhookDelivery,
  type OutboundWebhookDeliveryRow, type OutboundWebhookEndpointRow, type OutboundWebhookPorts,
} from "./outbound-webhooks";

/**
 * Outbound webhook delivery processor (package #10): signature bytes,
 * retry semantics against BullMQ attempts, terminal-failure accounting,
 * and the SSRF guard re-run per attempt (DNS rebinding simulation).
 * Fetch and DNS are stubbed - no real network.
 */

const SECRET = "whsec_test-secret-for-delivery";
const PUBLIC_IP = "93.184.216.34";
const PRIVATE_IP = "10.0.0.7";

interface Rig {
  ports: OutboundWebhookPorts;
  delivery: OutboundWebhookDeliveryRow;
  endpoint: OutboundWebhookEndpointRow;
  fetches: Array<{ url: string; init: RequestInit }>;
  attempts: Array<{ deliveryId: string; responseStatus: number | null; lastError: string | null }>;
  delivered: string[];
  failed: Array<{ id: string; error: string }>;
  resets: string[];
  strikes: string[];
}

function rig(options: {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  lookupImpl?: (hostname: string) => Promise<string[]>;
  endpointOver?: Partial<OutboundWebhookEndpointRow>;
  deliveryOver?: Partial<OutboundWebhookDeliveryRow>;
} = {}): Rig {
  const delivery: OutboundWebhookDeliveryRow = {
    id: "del-1",
    endpointId: "ep-1",
    workspaceId: "ws-1",
    event: "message.received",
    payload: {
      id: "del-1", type: "message.received", createdAt: "2026-10-27T00:00:00.000Z",
      workspaceId: "ws-1", data: { messageId: "m-1" },
    },
    status: "pending",
    attempts: 0,
    ...options.deliveryOver,
  };
  const endpoint: OutboundWebhookEndpointRow = {
    id: "ep-1", workspaceId: "ws-1", url: "https://hooks.example.com/botara", enabled: true,
    ...options.endpointOver,
  };
  const fetches: Rig["fetches"] = [];
  const attempts: Rig["attempts"] = [];
  const delivered: string[] = [];
  const failed: Rig["failed"] = [];
  const resets: string[] = [];
  const strikes: string[] = [];
  const fetchImpl = options.fetchImpl ?? (async () => new Response("ok", { status: 200 }));
  const ports: OutboundWebhookPorts = {
    async getDelivery() { return delivery; },
    async getEndpoint() { return endpoint; },
    async getEndpointSecret() { return SECRET; },
    async recordAttempt(input) { attempts.push(input); delivery.attempts += 1; },
    async markDelivered(id) { delivered.push(id); delivery.status = "delivered"; },
    async markFailed(id, error) { failed.push({ id, error }); delivery.status = "failed"; },
    async resetEndpointFailures(id) { resets.push(id); },
    async registerEndpointFailure(id) { strikes.push(id); },
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: String(url), init: init ?? {} });
      return fetchImpl(String(url), init ?? {});
    }) as typeof fetch,
    lookupFn: options.lookupImpl ?? (async () => [PUBLIC_IP]),
    now: () => new Date("2026-10-27T12:00:00.000Z"),
    log: () => undefined,
  };
  return { ports, delivery, endpoint, fetches, attempts, delivered, failed, resets, strikes };
}

describe("outbound webhook delivery", () => {
  test("a 2xx delivers: signed POST, attempt recorded, failure streak reset", async () => {
    const r = rig();
    const result = await processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 0 });
    expect(result.outcome).toBe("delivered");
    expect(r.fetches).toHaveLength(1);
    const { url, init } = r.fetches[0]!;
    expect(url).toBe("https://hooks.example.com/botara");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-botara-event"]).toBe("message.received");
    expect(headers["x-botara-delivery"]).toBe("del-1");
    // The signature must verify against the exact bytes sent.
    const body = init.body as string;
    expect(body).toBe(JSON.stringify(r.delivery.payload));
    const signature = headers["x-botara-signature"]!;
    expect(verifyWebhookSignature(SECRET, signature, body)).toBe(true);
    expect(verifyWebhookSignature("whsec_wrong", signature, body)).toBe(false);
    expect(verifyWebhookSignature(SECRET, signature, `${body} `)).toBe(false); // tampered body
    // Freshness: the header timestamp is the rig's fixed clock; a
    // verifier far in the future must reject it as stale.
    const t = Number(signature.split(",")[0]!.split("=")[1]);
    expect(t).toBe(Math.floor(new Date("2026-10-27T12:00:00.000Z").getTime() / 1000));
    expect(verifyWebhookSignature(SECRET, signature, body, { nowSeconds: t })).toBe(true);
    expect(verifyWebhookSignature(SECRET, signature, body, { nowSeconds: t + 100_000 })).toBe(false);
    expect(r.attempts).toEqual([{ deliveryId: "del-1", responseStatus: 200, lastError: null }]);
    expect(r.delivered).toEqual(["del-1"]);
    expect(r.resets).toEqual(["ep-1"]);
    expect(r.strikes).toEqual([]);
  });

  test("a 3xx is a failure (redirects are never followed)", async () => {
    const r = rig({ fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://169.254.169.254/" } }) });
    await expect(processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 0 })).rejects.toThrow("http_302");
    expect(r.attempts[0]?.responseStatus).toBe(302);
    expect(r.failed).toEqual([]);
    // Final attempt settles it.
    const r2 = rig({ fetchImpl: async () => new Response("", { status: 302 }) });
    const result = await processOutboundWebhookDelivery(r2.ports, { deliveryId: "del-1", attemptsMade: 4 });
    expect(result).toEqual({ outcome: "failed", reason: "http_302" });
    expect(r2.strikes).toEqual(["ep-1"]);
  });

  test("a 5xx retries while attempts remain and fails terminally on the last", async () => {
    const r = rig({ fetchImpl: async () => new Response("boom", { status: 500 }) });
    await expect(processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 0 })).rejects.toThrow("http_500");
    expect(r.failed).toEqual([]); // not settled yet - BullMQ will retry
    expect(r.strikes).toEqual([]);
    expect(r.delivery.attempts).toBe(1);

    const last = rig({ fetchImpl: async () => new Response("boom", { status: 500 }) });
    const result = await processOutboundWebhookDelivery(last.ports, { deliveryId: "del-1", attemptsMade: 4 });
    expect(result).toEqual({ outcome: "failed", reason: "http_500" });
    expect(last.failed).toEqual([{ id: "del-1", error: "http_500" }]);
    expect(last.strikes).toEqual(["ep-1"]); // exactly one strike per DELIVERY
  });

  test("a network error behaves like a 5xx: retryable, then terminal", async () => {
    const r = rig({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } });
    await expect(processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 0 })).rejects.toThrow("ECONNREFUSED");
    const last = rig({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } });
    const result = await processOutboundWebhookDelivery(last.ports, { deliveryId: "del-1", attemptsMade: 4 });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("network_error");
    expect(last.strikes).toEqual(["ep-1"]);
  });

  test("SSRF: DNS flipping private on a retry refuses the send entirely", async () => {
    let lookups = 0;
    const r = rig({
      fetchImpl: async () => new Response("boom", { status: 500 }),
      lookupImpl: async () => {
        lookups += 1;
        // Attempt 1 resolves public (send happens, 500, retryable);
        // the retry's resolution flips to a private address (rebinding).
        return lookups === 1 ? [PUBLIC_IP] : [PRIVATE_IP];
      },
    });
    await expect(processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 0 })).rejects.toThrow("http_500");
    expect(r.fetches).toHaveLength(1);
    const result = await processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 1 });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("ssrf_refused");
    expect(r.fetches).toHaveLength(1); // the flipped attempt NEVER sent
    expect(r.strikes).toEqual(["ep-1"]); // refusal is terminal: one strike, no more retries
  });

  test("SSRF: a private target is refused on the first attempt without any fetch", async () => {
    const r = rig({ lookupImpl: async () => ["192.168.1.10"] });
    const result = await processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 0 });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("ssrf_refused");
    expect(r.fetches).toHaveLength(0);
  });

  test("a disabled endpoint fails without sending - except test pings probe it", async () => {
    const r = rig({ endpointOver: { enabled: false } });
    const result = await processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 0 });
    expect(result).toEqual({ outcome: "failed", reason: "endpoint_disabled" });
    expect(r.fetches).toHaveLength(0);

    const probe = rig({
      endpointOver: { enabled: false },
      deliveryOver: { event: "webhook.test" },
    });
    const probeResult = await processOutboundWebhookDelivery(probe.ports, { deliveryId: "del-1", attemptsMade: 0 });
    expect(probeResult.outcome).toBe("delivered");
    expect(probe.fetches).toHaveLength(1);
  });

  test("terminal deliveries are skipped (idempotent job redelivery)", async () => {
    const r = rig({ deliveryOver: { status: "delivered" } });
    const result = await processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 0 });
    expect(result.outcome).toBe("skipped");
    expect(r.fetches).toHaveLength(0);
  });

  test("attempt counting: five attempts then exactly one failure strike", async () => {
    const r = rig({ fetchImpl: async () => new Response("no", { status: 503 }) });
    for (let attemptsMade = 0; attemptsMade < 4; attemptsMade += 1) {
      await expect(
        processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade }),
      ).rejects.toThrow("http_503");
      expect(r.delivery.status).toBe("pending");
    }
    const result = await processOutboundWebhookDelivery(r.ports, { deliveryId: "del-1", attemptsMade: 4 });
    expect(result.outcome).toBe("failed");
    expect(r.attempts).toHaveLength(5);
    expect(r.delivery.attempts).toBe(5);
    expect(r.strikes).toEqual(["ep-1"]);
  });
});
