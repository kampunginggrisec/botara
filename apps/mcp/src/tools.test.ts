import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BotaraApiError, BotaraClient } from "./client";
import { TOOL_DEFS, createMcpServer } from "./tools";

/**
 * MCP tests: (1) tool handlers against a fake REST transport - inputs map
 * to the right Botara API calls, API errors surface with their typed
 * code; (2) an SDK-level smoke: initialize + tools/list + tools/call over
 * the in-memory transport pair.
 */

interface RecordedCall {
  method: string;
  url: string;
  workspaceId: string | null;
  body: unknown;
}

function fakeClient(handler: (call: RecordedCall) => { status: number; body: unknown }) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url: String(input),
      workspaceId: headers.get("x-workspace-id"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new BotaraClient({ baseUrl: "http://api.test/api", token: "bta_test", fetchFn });
  return { client, calls };
}

function def(name: string) {
  const found = TOOL_DEFS.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing`);
  return found;
}

describe("tool handlers (fake REST client)", () => {
  test("the safe tool set is exactly the adopted list (no import, no create_flow)", () => {
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual([
      "broadcast_estimate", "enroll_sequence", "get_messages", "get_overview",
      "list_contacts", "list_conversations", "list_flows", "list_sequences",
      "list_workspaces", "send_reply", "test_run_flow",
    ]);
  });

  test("list_workspaces maps to GET /auth/me", async () => {
    const { client, calls } = fakeClient(() => ({
      status: 200,
      body: { user: { id: "u1", email: "a@b.co", name: null }, workspaces: [{ id: "ws1", name: "Shop", slug: "shop", role: "owner" }] },
    }));
    const out = (await def("list_workspaces").run(client, {})) as { workspaces: Array<{ id: string }> };
    expect(out.workspaces[0]?.id).toBe("ws1");
    expect(calls[0]).toMatchObject({ method: "GET", url: "http://api.test/api/auth/me" });
  });

  test("send_reply posts a free-form reply with the workspace header", async () => {
    const { client, calls } = fakeClient(() => ({ status: 201, body: { message: { id: "m1" } } }));
    await def("send_reply").run(client, { workspaceId: "ws1", conversationId: "c9", text: "Hello!" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://api.test/api/conversations/c9/reply",
      workspaceId: "ws1",
      body: { kind: "free_form", text: "Hello!" },
    });
  });

  test("API errors surface with their typed code (window closed)", async () => {
    const { client } = fakeClient(() => ({
      status: 422,
      body: { error: { code: "MESSAGING_WINDOW_CLOSED", message: "The 24h window has closed." } },
    }));
    const err = await def("send_reply")
      .run(client, { workspaceId: "ws1", conversationId: "c9", text: "hi" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotaraApiError);
    expect((err as BotaraApiError).code).toBe("MESSAGING_WINDOW_CLOSED");
    expect((err as BotaraApiError).status).toBe(422);
  });

  test("a scoped token's 403 surfaces unchanged (adoption #5: the client adds no auth logic)", async () => {
    // With BOTARA_API_TOKEN set to a scoped token lacking
    // conversations:write, the API answers 403 FORBIDDEN with the
    // required scope in details; the MCP layer must surface exactly
    // that - enforcement lives server-side only.
    const { client, calls } = fakeClient(() => ({
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "This API token lacks the required scope: conversations:write.",
          details: { requiredScope: "conversations:write", grantedScopes: ["conversations:read"] },
        },
      },
    }));
    const err = await def("send_reply")
      .run(client, { workspaceId: "ws1", conversationId: "c9", text: "hi" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotaraApiError);
    expect((err as BotaraApiError).code).toBe("FORBIDDEN");
    expect((err as BotaraApiError).status).toBe(403);
    // The call itself was the ordinary REST call - no pre-flight, no retry.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://api.test/api/conversations/c9/reply" });
  });

  test("test_run_flow and enroll_sequence hit their endpoints", async () => {
    const { client, calls } = fakeClient(() => ({ status: 200, body: { ok: true } }));
    await def("test_run_flow").run(client, { workspaceId: "ws1", flowId: "f1", text: "price" });
    await def("enroll_sequence").run(client, { workspaceId: "ws1", sequenceId: "s1", tag: "vip" });
    expect(calls[0]?.url).toBe("http://api.test/api/flows/f1/test-run");
    expect(calls[0]?.body).toEqual({ text: "price" });
    expect(calls[1]?.url).toBe("http://api.test/api/sequences/s1/enroll");
    expect(calls[1]?.body).toEqual({ tag: "vip" });
  });

  test("fromEnv fails fast without BOTARA_API_TOKEN", () => {
    expect(() => BotaraClient.fromEnv({})).toThrow(/BOTARA_API_TOKEN is not set/);
  });
});

describe("SDK smoke (in-memory transport)", () => {
  test("initialize + tools/list + tools/call work end to end", async () => {
    const { client: apiClient } = fakeClient((call) => {
      if (call.url.endsWith("/auth/me")) {
        return { status: 200, body: { user: { id: "u1", email: "a@b.co", name: null }, workspaces: [] } };
      }
      return { status: 200, body: { conversations: [] } };
    });
    const server = createMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const tools = await mcpClient.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(TOOL_DEFS.map((t) => t.name).sort());
    // JSON schemas are generated per tool (workspaceId is required where scoped).
    const reply = tools.tools.find((t) => t.name === "send_reply");
    expect((reply?.inputSchema as { required?: string[] }).required).toEqual(
      expect.arrayContaining(["workspaceId", "conversationId", "text"]),
    );

    const call = await mcpClient.callTool({ name: "list_workspaces", arguments: {} });
    const content = call.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("a@b.co");

    await mcpClient.close();
    await server.close();
  });

  test("a failing API call becomes an isError tool result with the typed code", async () => {
    const { client: apiClient } = fakeClient(() => ({
      status: 503,
      body: { error: { code: "CONFIGURATION", message: "DATABASE_URL is not configured" } },
    }));
    const server = createMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const call = await mcpClient.callTool({ name: "get_overview", arguments: { workspaceId: "ws1" } });
    expect(call.isError).toBe(true);
    const content = call.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("CONFIGURATION");

    await mcpClient.close();
    await server.close();
  });
});
