import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  isOutboundWebhookEvent, parseWebhookEvents, webhookMessagePreview,
} from "./index";
import {
  computeWebhookSignature, verifyWebhookSignature, webhookSignatureHeader,
} from "./webhook-signing";
import { checkOutboundWebhookUrl, type DnsLookupFn } from "./ssrf";

/**
 * Outbound webhooks shared contract (package #10): signature scheme,
 * event-set validation, and the SSRF guard (DNS mocked - no real
 * network in tests).
 */

describe("webhook signatures", () => {
  const secret = "whsec_test_secret_0123456789";
  const body = JSON.stringify({ id: "d1", type: "message.received", data: { preview: "halo" } });
  const t = 1_793_000_000;

  test("signature matches the independently computed HMAC vector", () => {
    const expected = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
    expect(computeWebhookSignature(secret, t, body)).toBe(expected);
    expect(webhookSignatureHeader(secret, t, body)).toBe(`t=${t},v1=${expected}`);
  });

  test("verify accepts a fresh valid header and rejects tampering", () => {
    const header = webhookSignatureHeader(secret, t, body);
    expect(verifyWebhookSignature(secret, header, body, { nowSeconds: t + 60 })).toBe(true);
    // Tampered body, wrong secret, stale timestamp, garbage header.
    expect(verifyWebhookSignature(secret, header, `${body} `, { nowSeconds: t + 60 })).toBe(false);
    expect(verifyWebhookSignature("whsec_other", header, body, { nowSeconds: t + 60 })).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, { nowSeconds: t + 3600 })).toBe(false);
    expect(verifyWebhookSignature(secret, "not-a-signature", body)).toBe(false);
    expect(verifyWebhookSignature(secret, null, body)).toBe(false);
    expect(verifyWebhookSignature(secret, `t=${t},v1=${"0".repeat(64)}`, body)).toBe(false);
  });
});

describe("event set validation", () => {
  test("closed set: known events pass, anything else fails closed", () => {
    expect(isOutboundWebhookEvent("message.received")).toBe(true);
    expect(isOutboundWebhookEvent("webhook.test")).toBe(false);
    expect(parseWebhookEvents(["message.received", "message.status", "message.received"]))
      .toEqual(["message.received", "message.status"]);
    expect(parseWebhookEvents([])).toBeNull();
    expect(parseWebhookEvents(["message.received", "conversation.deleted"])).toBeNull();
    expect(parseWebhookEvents("message.received")).toBeNull();
  });

  test("preview truncates at the documented cap", () => {
    const long = "x".repeat(500);
    expect(webhookMessagePreview(long)).toHaveLength(200);
    expect(webhookMessagePreview("short")).toBe("short");
    expect(webhookMessagePreview(undefined)).toBeUndefined();
    expect(webhookMessagePreview(null)).toBeUndefined();
  });
});

describe("SSRF guard", () => {
  const dns: Record<string, string[]> = {
    "hooks.example.com": ["93.184.216.34"],
    "dual.example.com": ["93.184.216.34", "10.0.0.5"],
    "v6.example.com": ["2606:2800:220:1:248:1893:25c8:1946"],
    "mapped.example.com": ["::ffff:127.0.0.1"],
    "sneaky.example.com": ["192.168.1.10"],
  };
  const lookup: DnsLookupFn = async (host) => {
    const found = dns[host];
    if (!found) throw new Error("ENOTFOUND");
    return found;
  };

  test("public https targets pass", async () => {
    expect((await checkOutboundWebhookUrl("https://hooks.example.com/in", lookup)).ok).toBe(true);
    expect((await checkOutboundWebhookUrl("https://v6.example.com/in", lookup)).ok).toBe(true);
    expect((await checkOutboundWebhookUrl("https://93.184.216.34/in", lookup)).ok).toBe(true);
  });

  test("private / loopback / link-local IP literals are rejected", async () => {
    for (const url of [
      "https://127.0.0.1/in",
      "https://10.1.2.3/in",
      "https://172.16.0.9/in",
      "https://192.168.0.1/in",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.1.1/in",
      "https://[::1]/in",
      "https://[fe80::1]/in",
      "https://[fd00::1]/in",
      "https://0.0.0.0/in",
    ]) {
      const res = await checkOutboundWebhookUrl(url, lookup);
      expect(res.ok, url).toBe(false);
    }
  });

  test("hostnames resolving to ANY private address are rejected", async () => {
    expect((await checkOutboundWebhookUrl("https://sneaky.example.com/in", lookup)).ok).toBe(false);
    // One public + one private (dual) still rejects: ANY private poisons it.
    expect((await checkOutboundWebhookUrl("https://dual.example.com/in", lookup)).ok).toBe(false);
    // IPv4-mapped IPv6 loopback is seen through.
    expect((await checkOutboundWebhookUrl("https://mapped.example.com/in", lookup)).ok).toBe(false);
    // Unresolvable host.
    expect((await checkOutboundWebhookUrl("https://gone.example.com/in", lookup)).ok).toBe(false);
  });

  test("credentials, non-https schemes and junk are rejected", async () => {
    expect((await checkOutboundWebhookUrl("https://user:pass@hooks.example.com/in", lookup)).ok).toBe(false);
    expect((await checkOutboundWebhookUrl("ftp://hooks.example.com/in", lookup)).ok).toBe(false);
    expect((await checkOutboundWebhookUrl("http://hooks.example.com/in", lookup)).ok).toBe(false);
    expect((await checkOutboundWebhookUrl("not a url", lookup)).ok).toBe(false);
  });

  test("http is allowed only for loopback hosts (documented local-dev exception)", async () => {
    expect((await checkOutboundWebhookUrl("http://127.0.0.1:8787/in", lookup)).ok).toBe(true);
    expect((await checkOutboundWebhookUrl("http://localhost:8787/in", async () => ["127.0.0.1"])).ok).toBe(true);
    expect((await checkOutboundWebhookUrl("http://[::1]:8787/in", lookup)).ok).toBe(true);
    // A "localhost" that resolves somewhere else is not loopback.
    expect((await checkOutboundWebhookUrl("http://localhost/in", async () => ["93.184.216.34"])).ok).toBe(false);
  });
});
