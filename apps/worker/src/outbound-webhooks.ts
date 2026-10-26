import {
  WEBHOOK_DELIVERY_MAX_ATTEMPTS, WEBHOOK_HTTP_TIMEOUT_MS, WEBHOOK_TEST_EVENT,
  checkOutboundWebhookUrl, webhookSignatureHeader,
} from "@botara/shared";

/**
 * Outbound event webhooks (adoption package #10) - the worker half:
 * signed delivery of one webhook_deliveries row per job, with SSRF
 * re-validation before EVERY attempt, Stripe-style HMAC signatures,
 * and the consecutive-failure auto-disable accounting.
 *
 * Retry ownership: BullMQ job attempts (configured at enqueue time in
 * the API: `attempts: WEBHOOK_DELIVERY_MAX_ATTEMPTS`, exponential
 * backoff). This processor throws on a transient failure while attempts
 * remain so BullMQ schedules the retry; on the final attempt - and for
 * permanent failures (SSRF refusal, disabled/missing endpoint) - it
 * settles the delivery as failed itself and does NOT throw.
 */

export interface OutboundWebhookDeliveryRow {
  id: string;
  endpointId: string;
  workspaceId: string;
  event: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
}

export interface OutboundWebhookEndpointRow {
  id: string;
  workspaceId: string;
  url: string;
  enabled: boolean;
}

export interface OutboundWebhookPorts {
  /** Load the delivery row; null when it vanished (deleted endpoint). */
  getDelivery(deliveryId: string): Promise<OutboundWebhookDeliveryRow | null>;
  getEndpoint(endpointId: string): Promise<OutboundWebhookEndpointRow | null>;
  /** Unseal the endpoint's signing secret (null when unsealing fails). */
  getEndpointSecret(endpointId: string): Promise<string | null>;
  recordAttempt(input: {
    deliveryId: string; responseStatus: number | null; lastError: string | null;
  }): Promise<void>;
  markDelivered(deliveryId: string): Promise<void>;
  markFailed(deliveryId: string, error: string): Promise<void>;
  /** Successful delivery: consecutive_failures back to 0. */
  resetEndpointFailures(endpointId: string): Promise<void>;
  /** One more consecutively failed DELIVERY; may auto-disable the endpoint. */
  registerEndpointFailure(endpointId: string): Promise<void>;
  /** Injectable fetch (tests stub it; production uses global fetch). */
  fetchFn?: typeof fetch;
  /** Injectable clock for signature timestamps. */
  now?: () => Date;
  log?: (line: Record<string, unknown>) => void;
}

export interface OutboundWebhookJobInput {
  deliveryId: string;
  /** BullMQ job.attemptsMade BEFORE this attempt runs (0-based). */
  attemptsMade: number;
  /** Total configured job attempts (WEBHOOK_DELIVERY_MAX_ATTEMPTS in production). */
  maxAttempts?: number;
}

const defaultLog = (line: Record<string, unknown>) =>
  console.log(JSON.stringify({ scope: "outbound-webhooks", ...line }));

/** Body bytes are fixed at enqueue time; the signature covers exactly these. */
function deliveryBody(delivery: OutboundWebhookDeliveryRow): string {
  return JSON.stringify(delivery.payload);
}

export async function processOutboundWebhookDelivery(
  ports: OutboundWebhookPorts,
  input: OutboundWebhookJobInput,
): Promise<{ outcome: "delivered" | "failed" | "retry" | "skipped"; reason?: string }> {
  const log = ports.log ?? defaultLog;
  const fetchFn = ports.fetchFn ?? fetch;
  const maxAttempts = input.maxAttempts ?? WEBHOOK_DELIVERY_MAX_ATTEMPTS;
  const isFinalAttempt = input.attemptsMade + 1 >= maxAttempts;

  const delivery = await ports.getDelivery(input.deliveryId);
  if (!delivery) return { outcome: "skipped", reason: "delivery_not_found" };
  if (delivery.status !== "pending") return { outcome: "skipped", reason: `already_${delivery.status}` };

  /** Settle as failed: record the attempt, mark failed, count the strike. */
  const fail = async (reason: string, responseStatus: number | null): Promise<{ outcome: "failed"; reason: string }> => {
    await ports.recordAttempt({ deliveryId: delivery.id, responseStatus, lastError: reason });
    await ports.markFailed(delivery.id, reason);
    const endpoint = await ports.getEndpoint(delivery.endpointId).catch(() => null);
    if (endpoint) await ports.registerEndpointFailure(endpoint.id);
    log({ event: "webhook_delivery_failed", deliveryId: delivery.id, endpointId: delivery.endpointId, reason });
    return { outcome: "failed", reason };
  };

  const endpoint = await ports.getEndpoint(delivery.endpointId);
  if (!endpoint) return fail("endpoint_not_found", null);
  if (endpoint.workspaceId !== delivery.workspaceId) return fail("endpoint_workspace_mismatch", null);
  // Disabled endpoints receive nothing - EXCEPT an explicit test ping,
  // which exists precisely to probe a (possibly auto-disabled) endpoint
  // before the operator re-enables it.
  if (!endpoint.enabled && delivery.event !== WEBHOOK_TEST_EVENT) {
    return fail("endpoint_disabled", null);
  }

  // SSRF guard, re-run before EVERY attempt: the DNS answer that was
  // fine at creation (or on attempt N) may have flipped by retry time.
  // A refusal is permanent for this delivery - no BullMQ retry.
  const check = await checkOutboundWebhookUrl(endpoint.url);
  if (!check.ok) return fail(`ssrf_refused: ${check.reason}`, null);

  const secret = await ports.getEndpointSecret(endpoint.id);
  if (!secret) return fail("secret_unavailable", null);

  const body = deliveryBody(delivery);
  const timestamp = Math.floor((ports.now?.() ?? new Date()).getTime() / 1000);
  let responseStatus: number | null = null;
  try {
    const response = await fetchFn(check.url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Botara-Webhooks/1.0",
        "x-botara-event": delivery.event,
        "x-botara-delivery": delivery.id,
        "x-botara-signature": webhookSignatureHeader(secret, timestamp, body),
      },
      body,
      // Redirects are never followed: a 3xx is a (retryable) failure,
      // so a receiver cannot bounce the sender at an internal target.
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_HTTP_TIMEOUT_MS),
    });
    responseStatus = response.status;
    // Drain the body so the connection can be reused/closed cleanly.
    await response.text().catch(() => undefined);
  } catch (err) {
    const reason = `network_error: ${err instanceof Error ? err.message : String(err)}`;
    await ports.recordAttempt({ deliveryId: delivery.id, responseStatus: null, lastError: reason });
    if (!isFinalAttempt) throw err instanceof Error ? err : new Error(reason);
    await ports.markFailed(delivery.id, reason);
    await ports.registerEndpointFailure(endpoint.id);
    log({ event: "webhook_delivery_failed", deliveryId: delivery.id, endpointId: endpoint.id, reason });
    return { outcome: "failed", reason };
  }

  if (responseStatus !== null && responseStatus >= 200 && responseStatus < 300) {
    await ports.recordAttempt({ deliveryId: delivery.id, responseStatus, lastError: null });
    await ports.markDelivered(delivery.id);
    await ports.resetEndpointFailures(endpoint.id);
    log({ event: "webhook_delivery_delivered", deliveryId: delivery.id, endpointId: endpoint.id, responseStatus });
    return { outcome: "delivered" };
  }

  const reason = `http_${responseStatus ?? "unknown"}`;
  await ports.recordAttempt({ deliveryId: delivery.id, responseStatus, lastError: reason });
  if (!isFinalAttempt) {
    // Throw so BullMQ applies the configured backoff and retries.
    throw new Error(`webhook delivery ${delivery.id} failed: ${reason}`);
  }
  await ports.markFailed(delivery.id, reason);
  await ports.registerEndpointFailure(endpoint.id);
  log({ event: "webhook_delivery_failed", deliveryId: delivery.id, endpointId: endpoint.id, reason });
  return { outcome: "failed", reason };
}
