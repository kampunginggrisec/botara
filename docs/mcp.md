# Botara MCP server

`apps/mcp` (`@botara/mcp`) exposes Botara to MCP clients (Claude Desktop,
Cursor, Claude Code, ...) as a set of **safe tools**. It is a thin client
of the Botara REST API: it holds ONE personal API token and forwards every
call to the API, so all authorization, workspace-membership, and
messaging-window rules are enforced by the API itself - exactly as if you
used the dashboard.

## Tools

| Tool | What it does |
|---|---|
| `list_workspaces` | Workspaces the token's user belongs to (start here - other tools need a `workspaceId`) |
| `get_overview` | Dashboard stats for a workspace |
| `list_conversations` | Inbox conversations (optional channel/status filter) |
| `get_messages` | Messages of one conversation |
| `send_reply` | Free-form inbox reply (the API enforces the 24h window; violations return a typed error like `MESSAGING_WINDOW_CLOSED`) |
| `list_contacts` | Contacts (optional tag/channel filter) |
| `list_flows` | Automation flows |
| `test_run_flow` | Dry-run a flow - never sends real messages |
| `broadcast_estimate` | WhatsApp broadcast cost estimate (no send) |
| `list_sequences` | Drip sequences |
| `enroll_sequence` | Enroll all contacts with a tag into a sequence |

Deliberately NOT included: contact import/export and flow creation -
bulk/destructive writes stay in the dashboard.

## 1. Create an API token

In the Botara dashboard: **Settings -> API tokens -> Create token**. The
raw token (starting with `bta_`) is shown **once** - copy it immediately.
Only its SHA-256 hash is stored server-side; revoke it any time from the
same Settings section.

## 2. Run it

Environment:

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `BOTARA_API_TOKEN` | yes | - | The `bta_...` token. The server refuses to start without it. |
| `BOTARA_API_URL` | no | `http://localhost:3000/api` | Base URL of the Botara API **including** its `/api` prefix when going through the public proxy. When talking to the API process/container directly, the API serves at root - use e.g. `http://api:3000`. |
| `PORT_MCP` | no | `3003` | Port of the HTTP transport. |

Streamable HTTP (stateless), for remote/shared use:

```bash
bun run --cwd apps/mcp start
# MCP endpoint: http://localhost:3003/mcp   (liveness: GET /health)
```

stdio, for local clients that spawn the process:

```bash
bun run --cwd apps/mcp start:stdio
```

Production: `infra/docker/docker-compose.prod.yml` has an optional `mcp`
service behind the `mcp` profile, bound to localhost only:

```bash
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.production --profile mcp up -d mcp
```

## 3. Client configuration

### Claude Code

```bash
claude mcp add --transport http botara http://localhost:3003/mcp
```

or stdio in `.mcp.json`:

```json
{
  "mcpServers": {
    "botara": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/botara/apps/mcp", "start:stdio"],
      "env": {
        "BOTARA_API_URL": "https://botara.example.com/api",
        "BOTARA_API_TOKEN": "bta_replace_with_your_token"
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`) / Cursor (`.cursor/mcp.json`)

Use the same stdio snippet as above. For the HTTP transport, point the
client at `http://localhost:3003/mcp` (Cursor supports remote MCP URLs
natively; Claude Desktop needs a stdio bridge such as `mcp-remote`).

## Security notes

- **A personal token is full API access for its user.** Every workspace the user
  belongs to, with the user's role. Treat it like a password: never commit
  it, never share it, prefer one token per machine/purpose so revocation
  is painless.
- **Prefer a scoped token for MCP.** At creation you can bind the token to
  one workspace, limit it to specific scopes, and set an expiry
  ([api-tokens.md](api-tokens.md)). Enforcement is the API's: a tool call
  outside the token's scopes surfaces the API's `403 FORBIDDEN` as the
  tool error. Note `list_workspaces` needs `/auth/me`, which restricted
  tokens cannot call - with a bound token, pass its workspace id to the
  other tools directly.
- Revoke in **Settings -> API tokens** - revocation is immediate (the API
  checks the hash on every request) and `last_used_at` shows whether a
  token is still active.
- The MCP server itself adds no extra access control on its HTTP
  transport; it is designed to run on localhost or behind your own
  authenticated reverse proxy. The compose service binds `127.0.0.1`
  only - keep it that way unless you add TLS + auth in front.
- Tool errors always include the API's typed error code (e.g.
  `UNAUTHORIZED`, `MESSAGING_WINDOW_CLOSED`, `CONFIGURATION`) so an agent
  can explain exactly why an action was refused.
