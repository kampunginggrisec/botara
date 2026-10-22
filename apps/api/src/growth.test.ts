import { describe, expect, test } from "bun:test";
import { buildGrowthTarget, generateGrowthSlug, growthShortUrl } from "./growth";

/**
 * Growth URL builders per channel + slug generation. The redirect approach
 * is universal because wa.me cannot carry a ref parameter; channels that
 * support one (Messenger, Telegram) embed the slug for attribution.
 */

const account = (externalId: string, displayName?: string) => ({ externalId, displayName });

describe("buildGrowthTarget", () => {
  test("whatsapp -> wa.me with the targetRef number and prefilled text", () => {
    const url = buildGrowthTarget({
      kind: "whatsapp", slug: "abc12345", prefilledText: "Hi, I want info",
      targetRef: "+62 812-3456", account: account("10987654321"),
    });
    expect(url).toBe("https://wa.me/628123456?text=Hi%2C%20I%20want%20info");
  });

  test("whatsapp without a number fails loudly (account stores a phone-number ID, not the number)", () => {
    expect(() => buildGrowthTarget({
      kind: "whatsapp", slug: "abc12345", account: account("10987654321"),
    })).toThrow(/phone number/);
  });

  test("messenger -> m.me with ?ref=<slug>", () => {
    const url = buildGrowthTarget({ kind: "messenger", slug: "promo25", account: account("page-9") });
    expect(url).toBe("https://m.me/page-9?ref=promo25");
  });

  test("telegram -> t.me/<bot>?start=<slug>, username from the @displayName", () => {
    const url = buildGrowthTarget({ kind: "telegram", slug: "deal", account: account("555", "@shop_bot") });
    expect(url).toBe("https://t.me/shop_bot?start=deal");
  });

  test("telegram without any username fails loudly", () => {
    expect(() => buildGrowthTarget({ kind: "telegram", slug: "deal", account: account("555") }))
      .toThrow(/username/);
  });

  test("instagram -> ig.me/m/<username> (no ref support - counting only)", () => {
    const url = buildGrowthTarget({ kind: "instagram", slug: "deal", targetRef: "@shop.id", account: account("ig-1") });
    expect(url).toBe("https://ig.me/m/shop.id");
  });

  test("webchat -> the stored widget page URL with the ref appended", () => {
    expect(buildGrowthTarget({
      kind: "webchat", slug: "deal", targetUrl: "https://shop.example/chat", account: account("webchat:ws"),
    })).toBe("https://shop.example/chat?ref=deal");
    expect(buildGrowthTarget({
      kind: "webchat", slug: "deal", targetUrl: "https://shop.example/chat?src=ad", account: account("webchat:ws"),
    })).toBe("https://shop.example/chat?src=ad&ref=deal");
    expect(() => buildGrowthTarget({ kind: "webchat", slug: "deal", account: account("webchat:ws") }))
      .toThrow(/targetUrl/);
  });

  test("unsupported kinds are a typed VALIDATION error", () => {
    try {
      buildGrowthTarget({ kind: "email", slug: "deal", account: account("a@b.co") });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("VALIDATION");
    }
  });
});

describe("slugs + short urls", () => {
  test("slugs are 8 chars from the unambiguous alphabet and differ across calls", () => {
    const a = generateGrowthSlug();
    const b = generateGrowthSlug();
    expect(a).toMatch(/^[a-km-np-zA-HJ-NP-Z2-9]{8}$/);
    expect(a).not.toBe(b);
  });

  test("short urls join base + /r/<slug> without double slashes", () => {
    expect(growthShortUrl("https://bot.example.com/", "abc")).toBe("https://bot.example.com/r/abc");
    expect(growthShortUrl("https://bot.example.com", "abc")).toBe("https://bot.example.com/r/abc");
  });
});
