import { randomBytes, randomUUID } from "node:crypto";
import {
  createWebhookDelivery, listEnabledWebhookEndpoints, type Database,
} from "@botara/db";
import type { OutboundWebhookEvent, WebhookDeliveryEvent } from "@botara/shared";
import type { OutboundWebhookEmitter } from "./flows-dispatch";

/**
 * Outbound event webhooks (adoption package #10) - the API-side half:
 * secret generation and the emission fan-out the inbound dispatcher
 * calls. Delivery itself (signing, SSRF re-check, POST, retries,
 * auto-disable) lives in the worker's outbound-webhooks processor; this
 * module only decides WHO gets WHAT and records the delivery rows.
 *
 * Secret format: `whsec_` + base64url(32 random bytes). The raw value
 * leaves the server exactly once (create / rotate responses); at rest
 * it exists only as an AES-256-GCM sealed blob (platform-settings
 * scheme) via sealSettingValue.
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** One delivery to enqueue: the row id is all the worker needs. */
export interface WebhookDeliveryEnqueuer {
  enqueueWebhookDelivery(deliveryId: string): Promise<void>;
}

/** The envelope every receiver gets; also the stored delivery payload. */
export function webhookEnvelope(input: {
  deliveryId: string;
  type: WebhookDeliveryEvent;
  workspaceId: string;
  data: Record<string, unknown>;
  at: Date;
}): Record<string, unknown> {
  return {
    id: input.deliveryId,
    type: input.type,
    createdAt: input.at.toISOString(),
    workspaceId: input.workspaceId,
    data: input.data,
  };
}

/**
 * Production emitter over the Drizzle repositories + the BullMQ
 * outbound-webhooks queue. Fire-and-forget by contract: endpoint
 * resolution, row inserts and enqueues are each guarded, and any
 * failure is logged - message processing never depends on this.
 */
export function createOutboundWebhookEmitter(deps: {
  getDatabase: () => Database;
  enqueuer: WebhookDeliveryEnqueuer;
  log?: (line: Record<string, unknown>) => void;
}): OutboundWebhookEmitter {
  const log = deps.log ?? ((line: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: "error", scope: "outbound-webhooks", ...line })));
  return {
    async emit(input: { workspaceId: string; type: OutboundWebhookEvent; data: Record<string, unknown> }) {
      let endpoints;
      try {
        endpoints = await listEnabledWebhookEndpoints(deps.getDatabase(), input.workspaceId);
      } catch (err) {
        log({ event: "webhook_endpoints_load_failed", workspaceId: input.workspaceId, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const subscribed = endpoints.filter((e) =>
        Array.isArray(e.events) && (e.events as string[]).includes(input.type),
      );
      for (const endpoint of subscribed) {
        try {
          // The envelope embeds the delivery id, so the id is minted
          // here and passed to the insert explicitly - one write, and
          // the stored payload is byte-identical to what gets POSTed.
          const deliveryId = randomUUID();
          const payload = webhookEnvelope({
            deliveryId,
            type: input.type,
            workspaceId: input.workspaceId,
            data: input.data,
            at: new Date(),
          });
          await createWebhookDelivery(deps.getDatabase(), {
            id: deliveryId,
            endpointId: endpoint.id,
            workspaceId: input.workspaceId,
            event: input.type,
            payload,
          });
          await deps.enqueuer.enqueueWebhookDelivery(deliveryId);
        } catch (err) {
          // A down queue or a failed insert for ONE endpoint must not
          // starve the others, and never reaches the dispatcher.
          log({
            event: "webhook_delivery_enqueue_failed",
            workspaceId: input.workspaceId,
            endpointId: endpoint.id,
            type: input.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}

/** Data block for the settings "send test" ping (same envelope shape). */
export function webhookTestData(endpointId: string): Record<string, unknown> {
  return {
    endpointId,
    message: "This is a test event from Botara. If you can read this, your endpoint is reachable and the pipeline works.",
    test: true,
  };
}
