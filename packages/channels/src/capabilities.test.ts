import { describe, expect, test } from "bun:test";
import { CHANNEL_CAPABILITIES } from "./types";
import { getAdapter, PlaceholderAdapter } from "./registry";

describe("capability matrix", () => {
  test("threads has NO DM and NO like API", () => {
    expect(CHANNEL_CAPABILITIES.threads.canDM).toBe(false);
    expect(CHANNEL_CAPABILITIES.threads.canLike).toBe(false);
    expect(CHANNEL_CAPABILITIES.threads.canPublish).toBe(true);
    expect(CHANNEL_CAPABILITIES.threads.canHideComments).toBe(true);
    expect(CHANNEL_CAPABILITIES.threads.canFetchInsights).toBe(true);
  });

  test("whatsapp marketing routes to the Marketing Messages API", () => {
    expect(CHANNEL_CAPABILITIES.whatsapp.marketingRoute).toBe("marketing-messages-api");
  });

  test("instagram declares both auth modes", () => {
    expect(CHANNEL_CAPABILITIES.instagram.authModes).toEqual(["instagram-login", "facebook-login"]);
  });

  test("placeholder adapters are honest stubs", async () => {
    const placeholder = new PlaceholderAdapter("threads");
    await expect(placeholder.send({
      account: { id: "a", externalId: "x" }, toExternalId: "y", text: "hi", idempotencyKey: "k1",
    })).rejects.toThrow("not implemented");
    expect(await placeholder.parseWebhook({})).toEqual([]);
    expect((await placeholder.health()).ok).toBe(false);
  });

  test("webchat is Botara's own channel (no external API)", () => {
    expect(CHANNEL_CAPABILITIES.webchat.canDM).toBe(true);
    expect(CHANNEL_CAPABILITIES.webchat.canPublish).toBe(false);
    // Buttons/lists render natively (clickable) in the widget; carousel
    // and catalog stay text-degraded.
    expect(CHANNEL_CAPABILITIES.webchat.richButtons).toBe(true);
    expect(CHANNEL_CAPABILITIES.webchat.richLists).toBe(true);
    expect(CHANNEL_CAPABILITIES.webchat.carousel).toBe(false);
    expect(CHANNEL_CAPABILITIES.webchat.catalog).toBe(false);
  });

  test("tiktok is reactive-only: no initiation, no broadcast, 48h window, 10-message cap, reply-card buttons", () => {
    const caps = CHANNEL_CAPABILITIES.tiktok;
    expect(caps.canDM).toBe(true);
    expect(caps.canBroadcast).toBe(false);
    expect(caps.canInitiate).toBe(false);
    expect(caps.windowHours).toBe(48);
    expect(caps.maxConsecutiveOutbound).toBe(10);
    expect(caps.richButtonStyle).toBe("reply-card");
    expect(caps.richButtons).toBe(true);
    expect(caps.richLists).toBe(false);
    expect(caps.carousel).toBe(false);
    expect(caps.catalog).toBe(false);
    expect(caps.canPublish).toBe(false);
    // Public comment moderation lives in TikTok's separate Accounts API.
    expect(caps.canReplyToComments).toBe(false);
    expect(caps.canHideComments).toBe(false);
  });

  test("tiktok resolves to the REAL adapter in the registry", () => {
    const adapter = getAdapter("tiktok");
    expect(adapter.key).toBe("tiktok");
    expect(adapter.apiVersion).toBe("v1.3");
    expect(adapter.capabilities.canBroadcast).toBe(false);
  });

  test("threads resolves to the REAL adapter in Fase 2, and it still cannot DM", async () => {
    const threads = getAdapter("threads");
    expect(threads.capabilities.canDM).toBe(false);
    expect(threads.capabilities.canLike).toBe(false);
    // send() is a DM - Threads has no DM API, so the real adapter refuses
    // honestly instead of faking it.
    await expect(threads.send({
      account: { id: "a", externalId: "x" }, toExternalId: "y", text: "hi", idempotencyKey: "k1",
    })).rejects.toThrow("not implemented");
    expect(await threads.parseWebhook({})).toEqual([]);
  });
});
