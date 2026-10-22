import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BotaraApiError, BotaraClient } from "./client";

/**
 * MCP tool set (adopted-features package) - deliberately SAFE: reads,
 * dry-runs, estimates, enrolls, and inbox replies (which the API itself
 * guards with the 24h window rules). NO contact import and NO flow
 * creation: bulk/destructive writes stay in the dashboard.
 *
 * Every tool maps 1:1 onto Botara REST endpoints via BotaraClient, so
 * authorization and window rules are always enforced by the API. API
 * errors surface with their typed code, e.g. "MESSAGING_WINDOW_CLOSED".
 */

interface ToolDef {
  name: string;
  description: string;
  /** Zod raw shape (per the MCP SDK's tool registration). */
  shape: Record<string, z.ZodTypeAny>;
  run: (client: BotaraClient, args: Record<string, unknown>) => Promise<unknown>;
}

const ws = { workspaceId: z.string().min(1).describe("Botara workspace id (from list_workspaces)") };

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_workspaces",
    description: "List the workspaces the API token's user belongs to (id, name, slug, role).",
    shape: {},
    run: async (client) => {
      const me = await client.me();
      return { user: me.user, workspaces: me.workspaces };
    },
  },
  {
    name: "get_overview",
    description: "Workspace dashboard overview: contacts, conversations, messages (30d), broadcasts, cost, active flows.",
    shape: { ...ws },
    run: (client, args) => client.overview(String(args.workspaceId)),
  },
  {
    name: "list_conversations",
    description: "List inbox conversations of a workspace, optionally filtered by channel or status.",
    shape: {
      ...ws,
      channel: z.string().optional().describe("whatsapp | instagram | messenger | telegram | email | webchat | threads"),
      status: z.string().optional().describe("open | resolved"),
    },
    run: (client, args) => client.listConversations(String(args.workspaceId), {
      channel: args.channel as string | undefined,
      status: args.status as string | undefined,
    }),
  },
  {
    name: "get_messages",
    description: "List the messages of one conversation (oldest first).",
    shape: { ...ws, conversationId: z.string().min(1) },
    run: (client, args) => client.listMessages(String(args.workspaceId), String(args.conversationId)),
  },
  {
    name: "send_reply",
    description:
      "Send a free-form inbox reply. The API enforces channel rules server-side (e.g. the 24h messaging window on WhatsApp/IG/Messenger) and answers with a typed error when a send is not allowed.",
    shape: { ...ws, conversationId: z.string().min(1), text: z.string().min(1) },
    run: (client, args) => client.reply(String(args.workspaceId), String(args.conversationId), String(args.text)),
  },
  {
    name: "list_contacts",
    description: "List workspace contacts, optionally filtered by tag or channel (the list endpoint's search filter).",
    shape: {
      ...ws,
      tag: z.string().optional(),
      channel: z.string().optional(),
    },
    run: (client, args) => client.listContacts(String(args.workspaceId), {
      tag: args.tag as string | undefined,
      channel: args.channel as string | undefined,
    }),
  },
  {
    name: "list_flows",
    description: "List automation flows of a workspace (name, status, trigger).",
    shape: { ...ws },
    run: (client, args) => client.listFlows(String(args.workspaceId)),
  },
  {
    name: "test_run_flow",
    description: "Dry-run a flow against a sample user message. NEVER sends real messages; returns the actions the flow would take.",
    shape: { ...ws, flowId: z.string().min(1), text: z.string().optional().describe("Sample inbound message text") },
    run: (client, args) => client.testRunFlow(String(args.workspaceId), String(args.flowId), args.text as string | undefined),
  },
  {
    name: "broadcast_estimate",
    description: "Estimate a WhatsApp broadcast cost from the rate card (no send). Category: marketing | utility | authentication | service.",
    shape: {
      category: z.string().min(1),
      countryMix: z.array(z.object({ country: z.string().min(2), recipients: z.number().int().positive() })).min(1),
    },
    run: (client, args) => client.broadcastEstimate({
      category: String(args.category),
      countryMix: args.countryMix as Array<{ country: string; recipients: number }>,
    }),
  },
  {
    name: "list_sequences",
    description: "List drip sequences of a workspace.",
    shape: { ...ws },
    run: (client, args) => client.listSequences(String(args.workspaceId)),
  },
  {
    name: "enroll_sequence",
    description: "Enroll every contact carrying a tag into a sequence (sequence id + tag).",
    shape: { ...ws, sequenceId: z.string().min(1), tag: z.string().min(1) },
    run: (client, args) => client.enrollSequence(String(args.workspaceId), String(args.sequenceId), String(args.tag)),
  },
];

function formatToolError(err: unknown): string {
  if (err instanceof BotaraApiError) {
    return `Botara API error ${err.code} (HTTP ${err.status}): ${err.message}`;
  }
  return `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
}

/** Build an McpServer with every tool bound to the given API client. */
export function createMcpServer(client: BotaraClient): McpServer {
  const server = new McpServer({ name: "botara", version: "1.0.0" });
  for (const def of TOOL_DEFS) {
    server.tool(def.name, def.description, def.shape, async (args: Record<string, unknown>) => {
      try {
        const result = await def.run(client, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: formatToolError(err) }] };
      }
    });
  }
  return server;
}
