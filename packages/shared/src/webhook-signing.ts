import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Outbound webhook signing (package #10) - NODE-ONLY module.
 *
 * Kept out of the @botara/shared root export on purpose: the root is
 * bundled into the web app (via @botara/flow-engine), and node:crypto
 * cannot ship to the browser. Server code imports this via the
 * "@botara/shared/webhook-signing" subpath instead.
 */
// ------------------------------------------------------------- signatures

/**
 * Signature scheme (Stripe-style): the receiver verifies
 *   v1 = hex(HMAC-SHA256(secret, `${t}.${rawBody}`))
 * where `t` is the unix-seconds timestamp carried in the same header:
 *   X-Botara-Signature: t=<unixSeconds>,v1=<hex>
 * The timestamp binds the signature to a moment so captured deliveries
 * cannot be replayed forever; verifiers should reject stale `t`.
 */
export function computeWebhookSignature(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
}

/** The full X-Botara-Signature header value for one send. */
export function webhookSignatureHeader(secret: string, timestampSeconds: number, rawBody: string): string {
  return `t=${timestampSeconds},v1=${computeWebhookSignature(secret, timestampSeconds, rawBody)}`;
}

/** Default freshness window for signature verification (5 minutes). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verify an X-Botara-Signature header against a raw body. Constant-time
 * comparison; rejects malformed headers, wrong signatures, and (when
 * `nowSeconds` is given) timestamps outside the tolerance window.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  rawBody: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!header) return false;
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = value;
    if (key === "v1") v1 = value;
  }
  if (!t || !v1 || !/^\d+$/.test(t) || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const timestamp = Number(t);
  if (options.nowSeconds !== undefined) {
    const tolerance = options.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
    if (Math.abs(options.nowSeconds - timestamp) > tolerance) return false;
  }
  const expected = Buffer.from(computeWebhookSignature(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
