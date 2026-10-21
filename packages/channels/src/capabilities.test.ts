import { describe, expect, test } from "bun:test";
import { CHANNEL_CAPABILITIES } from "./types";
import { getAdapter } from "./registry";

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
    const threads = getAdapter("threads");
    expect(threads.capabilities.canDM).toBe(false);
    await expect(threads.send({
      account: { id: "a", externalId: "x" }, toExternalId: "y", text: "hi", idempotencyKey: "k1",
    })).rejects.toThrow("not implemented");
    expect(await threads.parseWebhook({})).toEqual([]);
    expect((await threads.health()).ok).toBe(false);
  });
});
