import { describe, expect, test } from "bun:test";
import { buildVariableContext } from "@botara/shared";
import { runFlow, type FlowPorts } from "./executor";
import type { Flow } from "./schemas";
import type { FlowState } from "./interpreter";

function fakePorts() {
  const sent: Array<{ text: string; channel?: string; authorKind?: "human" | "ai" }> = [];
  const delays: Array<{ seconds: number; resumeState: FlowState }> = [];
  const webhooks: Array<{ url: string; method: string }> = [];
  const fields: Array<{ field: string; value: string }> = [];
  const ports: FlowPorts = {
    async sendMessage(input) { sent.push(input); },
    async scheduleDelay(input) { delays.push(input); },
    async httpWebhook(input) { webhooks.push(input); },
    async setContactField(input) { fields.push(input); },
  };
  return { ports, sent, delays, webhooks, fields };
}

const keywordFlow: Flow = {
  id: "welcome",
  version: 1,
  startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "keyword", config: { keyword: "halo" }, next: "s1" },
    { id: "s1", type: "send_message", text: "Halo juga! Ada yang bisa dibantu?", next: null },
  ],
};

describe("flow executor", () => {
  test("keyword trigger -> send", async () => {
    const f = fakePorts();
    const result = await runFlow(f.ports, keywordFlow, undefined, { type: "message.received", text: "Halo, bot!" });
    expect(f.sent).toEqual([{ text: "Halo juga! Ada yang bisa dibantu?", channel: undefined }]);
    expect(result.paused).toBe(false);
    expect(result.state.status).toBe("completed");
  });

  test("keyword trigger does not match -> no send, run completes", async () => {
    const f = fakePorts();
    const result = await runFlow(f.ports, keywordFlow, undefined, { type: "message.received", text: "random text" });
    expect(f.sent).toEqual([]);
    expect(result.state.status).toBe("completed");
  });

  test("condition branches on contact field (true and false)", async () => {
    const flow: Flow = {
      id: "plan",
      version: 1,
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "c1" },
        { id: "c1", type: "condition", field: "plan", operator: "equals", value: "pro", whenTrue: "pro", whenFalse: "free", next: null },
        { id: "pro", type: "send_message", text: "Halo Pro!", next: null },
        { id: "free", type: "send_message", text: "Halo Free!", next: null },
      ],
    };
    const a = fakePorts();
    await runFlow(a.ports, flow, undefined, { type: "manual", variables: { plan: "pro" } });
    expect(a.sent.map((s) => s.text)).toEqual(["Halo Pro!"]);

    const b = fakePorts();
    await runFlow(b.ports, flow, undefined, { type: "manual", variables: { plan: "free" } });
    expect(b.sent.map((s) => s.text)).toEqual(["Halo Free!"]);
  });

  test("condition branches on message text keyword", async () => {
    const flow: Flow = {
      id: "kw",
      version: 1,
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "message.received", config: {}, next: "c1" },
        { id: "c1", type: "condition", field: "messageText", operator: "contains", value: "harga", whenTrue: "p", whenFalse: "o", next: null },
        { id: "p", type: "send_message", text: "Daftar harga...", next: null },
        { id: "o", type: "send_message", text: "Halo!", next: null },
      ],
    };
    const f = fakePorts();
    await runFlow(f.ports, flow, undefined, { type: "message.received", text: "Berapa harga paket?" });
    expect(f.sent.map((s) => s.text)).toEqual(["Daftar harga..."]);
  });

  test("delay pauses the run and resume completes it", async () => {
    const flow: Flow = {
      id: "drip",
      version: 1,
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "d1" },
        { id: "d1", type: "delay", seconds: 3600, next: "s1" },
        { id: "s1", type: "send_message", text: "Follow up!", next: null },
      ],
    };
    const f = fakePorts();
    const first = await runFlow(f.ports, flow, undefined, { type: "manual" });
    expect(first.paused).toBe(true);
    expect(first.state.status).toBe("waiting");
    expect(f.delays).toHaveLength(1);
    expect(f.delays[0]!.seconds).toBe(3600);
    expect(f.sent).toEqual([]);

    const resumed = await runFlow(f.ports, flow, f.delays[0]!.resumeState, { type: "resume" });
    expect(resumed.paused).toBe(false);
    expect(resumed.state.status).toBe("completed");
    expect(f.sent.map((s) => s.text)).toEqual(["Follow up!"]);
  });

  test("set_field and webhook actions go through ports", async () => {
    const flow: Flow = {
      id: "fx",
      version: 1,
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "f1" },
        { id: "f1", type: "set_field", field: "onboarded", value: "yes", next: "w1" },
        { id: "w1", type: "webhook", url: "https://example.com/hook", method: "POST", next: null },
      ],
    };
    const f = fakePorts();
    const result = await runFlow(f.ports, flow, undefined, { type: "manual" });
    expect(f.fields).toEqual([{ field: "onboarded", value: "yes" }]);
    expect(f.webhooks).toEqual([{ url: "https://example.com/hook", method: "POST" }]);
    expect(result.state.status).toBe("completed");
  });
});

describe("ai_reply node (Fase 3)", () => {
  const aiFlow: Flow = {
    id: "support-ai",
    version: 1,
    startNodeId: "t1",
    nodes: [
      { id: "t1", type: "trigger", trigger: "message.received", config: {}, next: "ai1" },
      {
        id: "ai1", type: "ai_reply",
        prompt: "Jawab sebagai support untuk {{name}}.",
        fallbackText: "Maaf, tim kami akan segera membantu.",
        next: null,
      },
    ],
  };

  test("schema accepts the ai_reply node", async () => {
    const { flowSchema } = await import("./schemas");
    expect(flowSchema.parse(aiFlow).nodes[1]!.type).toBe("ai_reply");
  });

  test("generated reply is sent; the port receives prompt + the user message as query", async () => {
    const f = fakePorts();
    const seen: Array<{ prompt: string; query: string }> = [];
    f.ports.aiReply = async (input) => {
      seen.push(input);
      return "Jam buka kami 09.00-17.00 WIB.";
    };
    const result = await runFlow(f.ports, aiFlow, undefined, {
      type: "message.received", text: "jam buka?", variables: { name: "Romo" },
    });
    expect(seen).toEqual([{ prompt: "Jawab sebagai support untuk Romo.", query: "jam buka?" }]);
    // Package #7: model-generated text is badged "ai" at the send seam.
    expect(f.sent).toEqual([{ text: "Jam buka kami 09.00-17.00 WIB.", channel: undefined, authorKind: "ai" }]);
    expect(result.state.status).toBe("completed");
  });

  test("port returns null (AI down / KB empty) -> the configured fallback is sent", async () => {
    const f = fakePorts();
    f.ports.aiReply = async () => null;
    await runFlow(f.ports, aiFlow, undefined, { type: "message.received", text: "halo" });
    expect(f.sent).toEqual([{ text: "Maaf, tim kami akan segera membantu.", channel: undefined }]);
  });

  test("no aiReply port at all -> the fallback is sent (flow never dead-ends)", async () => {
    const f = fakePorts();
    await runFlow(f.ports, aiFlow, undefined, { type: "message.received", text: "halo" });
    expect(f.sent).toEqual([{ text: "Maaf, tim kami akan segera membantu.", channel: undefined }]);
  });
});

describe("variable interpolation in send paths (variables package #1)", () => {
  const interpCtx = buildVariableContext({
    contact: {
      displayName: "Dewi",
      externalId: "628777",
      channel: "telegram",
      customFields: { city: "Medan" },
    },
    workspaceName: "Toko Dewi",
  });

  const varFlow: Flow = {
    id: "vars",
    version: 1,
    startNodeId: "t1",
    nodes: [
      { id: "t1", type: "trigger", trigger: "message.received", config: {}, next: "s1" },
      {
        id: "s1", type: "send_message",
        text: "Halo {{contact.name}} dari {{contact.city}}, pesanan {{vars.orderId}} di {{workspace.name}}. [{{contact.unknown}}]",
        next: null,
      },
    ],
  };

  test("send_message renders contact/workspace/vars; unknown renders empty + warning", async () => {
    const f = fakePorts();
    const result = await runFlow(f.ports, varFlow, undefined, {
      type: "message.received", text: "halo", variables: { orderId: "ORD-7" },
    }, { interpolation: interpCtx });
    expect(f.sent).toEqual([{ text: "Halo Dewi dari Medan, pesanan ORD-7 di Toko Dewi. []", channel: undefined }]);
    expect(result.warnings).toEqual([{ code: "UNKNOWN_VARIABLE", path: "contact.unknown" }]);
  });

  test("rich block text fields render too", async () => {
    const flow: Flow = {
      id: "vars-rich",
      version: 1,
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "s1" },
        {
          id: "s1", type: "send_message", text: "teks",
          rich: { kind: "buttons", text: "Untuk {{contact.name}}", buttons: [{ type: "reply", title: "OK {{contact.name}}", payload: "ok" }] },
          next: null,
        },
      ],
    };
    const f = fakePorts();
    await runFlow(f.ports, flow, undefined, { type: "manual" }, { interpolation: interpCtx });
    const sentRich = (f.sent[0] as { rich?: unknown }).rich;
    expect(sentRich).toEqual({
      kind: "buttons",
      text: "Untuk Dewi",
      buttons: [{ type: "reply", title: "OK Dewi", payload: "ok" }],
    });
  });

  test("without an interpolation context, dot-path tokens pass through untouched", async () => {
    const f = fakePorts();
    const result = await runFlow(f.ports, varFlow, undefined, {
      type: "message.received", text: "halo", variables: { orderId: "ORD-7" },
    });
    expect(f.sent[0]!.text).toContain("{{contact.name}}");
    expect(result.warnings).toEqual([]);
  });

  test("ai_reply: generated text is NEVER interpolated; the fallback IS", async () => {
    const flow: Flow = {
      id: "ai-vars",
      version: 1,
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "message.received", config: {}, next: "ai1" },
        { id: "ai1", type: "ai_reply", prompt: "p", fallbackText: "Halo {{contact.name}}, tunggu ya.", next: null },
      ],
    };
    const gen = fakePorts();
    gen.ports.aiReply = async () => "Jawaban AI untuk {{contact.name}}";
    await runFlow(gen.ports, flow, undefined, { type: "message.received", text: "halo" }, { interpolation: interpCtx });
    expect(gen.sent).toEqual([{ text: "Jawaban AI untuk {{contact.name}}", channel: undefined, authorKind: "ai" }]);

    const fb = fakePorts();
    fb.ports.aiReply = async () => null;
    await runFlow(fb.ports, flow, undefined, { type: "message.received", text: "halo" }, { interpolation: interpCtx });
    expect(fb.sent).toEqual([{ text: "Halo Dewi, tunggu ya.", channel: undefined }]);
  });
});
