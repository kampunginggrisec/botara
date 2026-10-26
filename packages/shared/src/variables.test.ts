import { describe, expect, test } from "bun:test";
import { buildVariableContext, interpolate, type VariableContext } from "./variables";

const NOW = new Date("2026-10-26T14:05:09.000Z");

function ctx(overrides: Partial<VariableContext> = {}): VariableContext {
  return {
    ...buildVariableContext({
      contact: {
        displayName: "Budi Santoso",
        externalId: "628123456789",
        channel: "whatsapp",
        tags: ["vip", "jakarta"],
        customFields: {
          city: "Jakarta",
          orders: 3,
          member: true,
          lastItems: ["sepatu", "tas"],
          address: { city: "Bandung", zip: "40115" },
          nickname: null,
          name: "Custom Field Name",
        },
      },
      workspaceName: "Toko Berkah",
      channelAccount: { displayName: "Berkah Official", channel: "whatsapp" },
      vars: { orderId: "ORD-42", messageText: "halo", nested: { code: "X1" } },
    }),
    now: NOW,
    ...overrides,
  };
}

describe("interpolate: documented variables", () => {
  test("contact basics resolve", () => {
    const c = ctx();
    expect(interpolate("Halo {{contact.name}}!", c).text).toBe("Halo Budi Santoso!");
    expect(interpolate("{{contact.externalId}}", c).text).toBe("628123456789");
    expect(interpolate("{{contact.channel}}", c).text).toBe("whatsapp");
    expect(interpolate("{{contact.tags}}", c).text).toBe("vip, jakarta");
  });

  test("contact.name falls back to externalId without a display name", () => {
    const c = buildVariableContext({ contact: { displayName: null, externalId: "628999", channel: "telegram" } });
    expect(interpolate("{{contact.name}}", c).text).toBe("628999");
  });

  test("custom fields resolve, incl. nested paths", () => {
    const c = ctx();
    expect(interpolate("{{contact.city}}", c).text).toBe("Jakarta");
    expect(interpolate("{{contact.address.city}}", c).text).toBe("Bandung");
    expect(interpolate("{{contact.address.zip}}", c).text).toBe("40115");
  });

  test("reserved keys win over custom fields of the same name", () => {
    const c = ctx();
    expect(interpolate("{{contact.name}}", c).text).toBe("Budi Santoso");
  });

  test("workspace + channel resolve; channel.name falls back to platform", () => {
    const c = ctx();
    expect(interpolate("{{workspace.name}}", c).text).toBe("Toko Berkah");
    expect(interpolate("{{channel.name}}", c).text).toBe("Berkah Official");
    expect(interpolate("{{channel.platform}}", c).text).toBe("whatsapp");
    const bare = buildVariableContext({ channelAccount: { displayName: null, channel: "telegram" } });
    expect(interpolate("{{channel.name}}", bare).text).toBe("telegram");
  });

  test("vars bag resolves flat and nested values", () => {
    const c = ctx();
    expect(interpolate("Pesanan {{vars.orderId}}", c).text).toBe("Pesanan ORD-42");
    expect(interpolate("{{vars.nested.code}}", c).text).toBe("X1");
    expect(interpolate("{{vars.messageText}}", c).text).toBe("halo");
  });

  test("system variables render in UTC from the injected clock", () => {
    const c = ctx();
    expect(interpolate("{{system.date}}", c).text).toBe("2026-10-26");
    expect(interpolate("{{system.time}}", c).text).toBe("14:05");
    expect(interpolate("{{system.now}}", c).text).toBe("2026-10-26T14:05:09.000Z");
  });
});

describe("interpolate: semantics", () => {
  test("unknown variables render empty and warn with the path", () => {
    const r = interpolate("Halo {{contact.unknown}} dan {{nope.deep}}!", ctx());
    expect(r.text).toBe("Halo  dan !");
    expect(r.warnings).toEqual([
      { code: "UNKNOWN_VARIABLE", path: "contact.unknown" },
      { code: "UNKNOWN_VARIABLE", path: "nope.deep" },
    ]);
  });

  test("missing contact/workspace/channel roots are unknown, not crashes", () => {
    const r = interpolate("{{contact.name}} {{workspace.name}} {{channel.name}}", buildVariableContext({}));
    expect(r.text).toBe("  ");
    expect(r.warnings.map((w) => w.path)).toEqual(["contact.name", "workspace.name", "channel.name"]);
  });

  test("null custom field values count as unresolvable", () => {
    const r = interpolate("[{{contact.nickname}}]", ctx());
    expect(r.text).toBe("[]");
    expect(r.warnings).toEqual([{ code: "UNKNOWN_VARIABLE", path: "contact.nickname" }]);
  });

  test("whitespace inside braces is tolerated", () => {
    const c = ctx();
    expect(interpolate("{{ contact.name }}", c).text).toBe("Budi Santoso");
    expect(interpolate("{{  contact.city  }}", c).text).toBe("Jakarta");
    expect(interpolate("{{contact . city}}", c).text).toBe("Jakarta");
  });

  test("non-string values stringify (numbers, booleans, arrays, objects)", () => {
    const c = ctx();
    expect(interpolate("{{contact.orders}}", c).text).toBe("3");
    expect(interpolate("{{contact.member}}", c).text).toBe("true");
    expect(interpolate("{{contact.lastItems}}", c).text).toBe("sepatu, tas");
    expect(interpolate("{{contact.address}}", c).text).toBe("{\"city\":\"Bandung\",\"zip\":\"40115\"}");
  });

  test("a template without variables passes through byte-identical with zero warnings", () => {
    const raw = "Promo spesial hari ini: diskon 50% untuk semua item!";
    const r = interpolate(raw, ctx());
    expect(r.text).toBe(raw);
    expect(r.warnings).toEqual([]);
  });

  test("an unclosed token is left untouched", () => {
    const r = interpolate("teks {{contact.name tanpa tutup", ctx());
    expect(r.text).toBe("teks {{contact.name tanpa tutup");
    expect(r.warnings).toEqual([]);
  });

  test("empty template and repeated variables", () => {
    const c = ctx();
    expect(interpolate("", c)).toEqual({ text: "", warnings: [] });
    expect(interpolate("{{contact.name}} / {{contact.name}}", c).text).toBe("Budi Santoso / Budi Santoso");
  });
});
