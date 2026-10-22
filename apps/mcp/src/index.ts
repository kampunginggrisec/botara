import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BotaraClient } from "./client";
import { createMcpServer } from "./tools";

/**
 * Botara MCP server - Streamable HTTP transport (stateless).
 *
 *   BOTARA_API_TOKEN  required (a `bta_...` token from Botara Settings)
 *   BOTARA_API_URL    default http://localhost:3000/api
 *   PORT_MCP          default 3003
 *
 * Fails fast with a clear message when BOTARA_API_TOKEN is missing; with
 * a token present it serves tools/list even while the API is down (tool
 * CALLS then surface the API error readably).
 */

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const client = BotaraClient.fromEnv(); // throws (fail fast) without a token
  const port = Number(process.env.PORT_MCP ?? 3003);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "botara-mcp" }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found - the MCP endpoint is /mcp" }));
      return;
    }
    // Stateless: a fresh server + transport per request (SDK pattern).
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: err instanceof Error ? err.message : "internal error" },
          id: null,
        }));
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.log(`[botara-mcp] Streamable HTTP MCP server listening on http://localhost:${port}/mcp`);
}

main().catch((err) => {
  console.error(`[botara-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
