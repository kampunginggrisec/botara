# Outbound event webhooks

Workspace operators can subscribe their own HTTPS endpoints to Botara
lifecycle events (Settings → Outbound webhooks). Botara POSTs a signed
JSON envelope per event; receivers verify the signature, act, and
answer 2xx. This document is the receiver-facing contract: the event
catalog, the signature scheme, delivery/retry semantics, the SSRF
policy endpoints must satisfy, and secret hygiene.

Management API (owner/admin only; scoped API tokens need
`settings:read|write`):

| Route | Purpose |
|---|---|
| `POST /settings/webhooks` | Create (name, `url`, `events[]`). Returns the signing secret **once**. |
| `GET /settings/webhooks` | List endpoints (never any secret material). |
| `PATCH /settings/webhooks/{id}` | Rename, change URL (re-validated), change events, enable/disable. Enabling resets the failure streak. |
| `POST /settings/webhooks/{id}/rotate-secret` | New secret, shown **once**; the old secret stops working immediately. |
| `DELETE /settings/webhooks/{id}` | Delete the endpoint and its delivery history. |
| `GET /settings/webhooks/{id}/deliveries` | Latest 50 deliveries (event, status, response code, attempts, error). |
| `POST /settings/webhooks/{id}/test` | Enqueue a `webhook.test` ping through the normal delivery pipeline (also works while the endpoint is disabled, so operators can probe before re-enabling). |

## Events

The subscribable set is closed — anything else is rejected at write
time:

| Event | Fires when | `data` carries |
|---|---|---|
| `message.received` | An inbound message was **persisted** (webhook redeliveries of the same provider message do not re-fire) | `messageId`, `conversationId`, `channelAccountId`, `channel`, `contactId`, `direction`, `externalId`, `preview`, `receivedAt` |
| `message.status` | A provider receipt **actually advanced** a message/recipient status (`sent`/`delivered`/`read`/`failed`); duplicate or out-of-order receipts that move nothing stay silent | `channel`, `channelAccountId`, `providerMessageId`, `status`, plus `messageId`+`conversationId` (inbox mirror) and/or `broadcastId`+`recipientId`+`contactId` (broadcast mirror), `error` on failure |
| `conversation.created` | A **genuinely new** conversation was created by an inbound event — never when the one-open-thread race backstop reuses a concurrent winner's thread | `conversationId`, `channelAccountId`, `channel`, `contactId` |

Plus one non-subscribable event: `webhook.test`, the Settings "Send
test" ping.

Privacy rules baked into the payloads:

- **No message bodies.** `message.received` carries only a `preview`:
  the first **200 characters** of the body (enough to triage a CRM
  note, never the conversation). Choose the cap consciously: receivers
  that need full content should fetch it through the authenticated
  REST API with the ids provided.
- **Internal notes never emit.** Notes (`kind='note'`) are written
  through the inbox API, not the inbound pipeline, and no code path
  turns them into webhook events.

### Envelope

Every delivery POSTs the same envelope shape; the stored delivery
payload is byte-identical to the request body:

```json
{
  "id": "0f8c1f9e-3f4a-4c1e-9b6a-2d5e7a1c8f00",
  "type": "message.received",
  "createdAt": "2026-10-27T05:00:00.000Z",
  "workspaceId": "5a8621e0-95a0-4d7d-960e-45c1c7808836",
  "data": {
    "messageId": "b3d2…",
    "conversationId": "7aa1…",
    "channelAccountId": "c41d…",
    "channel": "whatsapp",
    "contactId": "9e77…",
    "direction": "in",
    "externalId": "wamid.HBg…",
    "preview": "Halo, apakah stok masih ada?",
    "receivedAt": "2026-10-27T05:00:00.000Z"
  }
}
```

Headers on every POST:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Botara-Webhooks/1.0` |
| `X-Botara-Event` | the event type (`envelope.type`) |
| `X-Botara-Delivery` | the delivery id (`envelope.id`) — use it to dedupe retries |
| `X-Botara-Signature` | `t=<unix seconds>,v1=<hex>` — see below |

Deliveries of the same event to the same endpoint may repeat after
failures (at-least-once). Dedupe on `X-Botara-Delivery`.

## Signature verification

Scheme (Stripe-style): `v1` is the hex HMAC-SHA256 of
`` `${t}.${rawBody}` `` keyed with the endpoint's signing secret, where
`t` is the unix-seconds timestamp in the same header and `rawBody` is
the **exact request body bytes** (never a re-serialized parse — key
order and whitespace are signed).

Always:

1. Parse `t` and `v1` from `X-Botara-Signature`.
2. Reject when `t` is more than ~5 minutes from your clock (replay
   window).
3. Compute the expected HMAC over `` `${t}.${rawBody}` `` and compare
   in constant time.

Node.js (no dependencies):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyBotaraWebhook(rawBody, signatureHeader, signingSecret, nowSeconds) {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("=").map((s) => s.trim())),
  );
  const t = Number(parts.t);
  if (!parts.t || !parts.v1 || !Number.isFinite(t)) return false;
  if (Math.abs(nowSeconds - t) > 300) return false; // stale / replayed
  const expected = createHmac("sha256", signingSecret)
    .update(`${parts.t}.${rawBody}`, "utf8")
    .digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Read the raw body before your framework parses JSON (Express:
`express.raw({ type: "application/json" })` on the webhook route).
Botara's own verifier is `verifyWebhookSignature` in
`@botara/shared/webhook-signing`, covered by a known-vector test.

## Delivery, retries, auto-disable

- One delivery = one queue job on the worker's `outbound-webhooks`
  queue. Timeout per attempt: **10 s**. Redirects are **never
  followed** — a 3xx response is a failure like any other non-2xx.
- **2xx** → delivered; the endpoint's consecutive-failure counter
  resets to 0.
- Any other outcome (non-2xx, network error, timeout) retries with
  exponential backoff (5 s base) up to **5 attempts total**. The
  delivery row's `attempts` counts tries actually made.
- After the 5th attempt the delivery is marked `failed` and the
  endpoint's consecutive-failure counter increments by **one per
  failed delivery** (not per attempt).
- At **10 consecutive failed deliveries** the endpoint is
  **auto-disabled** (`enabled=false`, `disabled_at` stamped, an
  `webhook_endpoint.auto_disabled` audit row written). It receives no
  further events until an owner/admin re-enables it in Settings —
  re-enabling resets the counter to 0.
- Test pings (`webhook.test`) run the same pipeline; a successful test
  also resets the streak. A test ping is delivered even while the
  endpoint is disabled (that is its purpose); real events are not —
  deliveries created for an endpoint that is disabled by send time
  fail with `endpoint_disabled`.

Emission is fire-and-forget: events fan out after the inbound message
is persisted, and a failing endpoint, a down queue, or a slow receiver
can never delay or break message processing or provider webhook
acknowledgment.

## SSRF policy (endpoint URLs)

Webhook URLs are operator-supplied, so every URL is validated **at
write time** (create/patch → typed `400` with the reason) and
**re-checked before every send attempt**, including retries:

- Scheme must be `https`. Plain `http` is allowed **only for loopback
  hosts** (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) as a
  local-development exception — and then every resolved address must
  be loopback.
- URLs with embedded credentials (`https://user:pass@…`) are rejected.
- The hostname is resolved and **every** resulting address must be a
  public unicast address. Private, loopback, link-local (including
  `169.254.169.254`), CGNAT, benchmarking, documentation, multicast,
  and reserved ranges are rejected — IPv4 and IPv6 alike, including
  IPv4-mapped and NAT64-embedded IPv6 forms. A hostname with even one
  bad address among good ones is rejected.
- Redirects are capped at 0 (see above), so a receiver cannot bounce
  the sender at an internal target.

**Known limit — DNS rebinding.** The guard resolves and validates,
then the HTTP client resolves again at connect time; a hostile DNS
answer could theoretically flip between the two lookups inside one
attempt. Botara bounds the risk by re-resolving and re-validating
before **every** attempt (a flipped answer fails the delivery as
`ssrf_refused` instead of sending), but full connect-time pinning is
not implemented — the residual TOCTOU window is one connection
attempt. Operators who cannot accept that should put receivers behind
a fixed public ingress (load balancer / tunnel) whose address cannot
be rebound.

## Secret hygiene

- Secrets are generated server-side: `whsec_` + 32 random bytes
  (base64url). They are stored **AES-256-GCM sealed** with the
  platform vault key (`TOKEN_VAULT_KEY`) — the same scheme as platform
  settings — and the raw value is returned **exactly once**, at
  creation and at rotation. It cannot be retrieved afterwards; the
  list API carries no secret material at all.
- Rotation invalidates the old secret immediately: the worker unseals
  per delivery, so the next send already signs with the new secret.
- Treat the secret like a password: store it in your secret manager,
  never in source control, and rotate on suspicion — not on a
  schedule. Losing it is recoverable in one click (rotate), by design.
