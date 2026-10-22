import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BotaraClient } from "./client";
import { createMcpServer } from "./tools";

/**
 * Botara MCP server - stdio entry for local MCP clients (Claude Desktop,
 * Cursor, Claude Code spawn this process and speak MCP over stdio).
 * Logs go to stderr only - stdout is the protocol channel.
 */

async function main(): Promise<void> {
  const client = BotaraClient.fromEnv(); // throws (fail fast) without a token
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
  console.error("[botara-mcp] stdio server ready");
}

main().catch((err) => {
  console.error(`[botara-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
