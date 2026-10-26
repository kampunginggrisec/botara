# API tokens & scopes

Botara's API tokens (`bta_...`, created in **Settings → API tokens**) power
third-party integrations and the MCP server (see [mcp.md](mcp.md)). The raw
token is shown **once** at creation; only its SHA-256 hash is stored.

Since adoption package #5, a token can be **scoped**: bound to one
workspace, restricted to a set of scopes, and given an expiry. All three
restrictions are optional and independent.

## Legacy tokens

A token created with none of the options below (the default in the
Settings form: no workspace binding, Full access, Never expires) is a
**legacy token**. It authenticates as its user with the user's full API
access — every workspace the user belongs to, every route a session can
call. Pre-#5 tokens are all legacy tokens; their behavior is unchanged.

## Workspace binding

A token created with `workspaceId` is bound to that workspace:

- The bound workspace **is** the token's effective workspace. Calls work
  with no `X-Workspace-Id` header at all.
- Sending `X-Workspace-Id` (or `?workspace_id=` on GET) naming a
  *different* workspace is refused with `403 FORBIDDEN` — never silently
  overridden.
- The creator's membership is re-verified on **every** request. If the
  creator is removed from the workspace, the token stops working
  (`403`) immediately. Deleting the workspace has the same effect.
- Any workspace member may create tokens bound to themselves; a token
  can only be bound to a workspace its creator belongs to at creation
  time (`403` otherwise).

## Scopes

Scopes use a small, closed taxonomy (defined in `@botara/shared`,
`packages/shared/src/api-tokens.ts`): eleven resources, each with a `read`
and a `write` level, plus `*` for full access.

| Scope | Covers |
| --- | --- |
| `contacts:read` / `contacts:write` | `/contacts/*`, `/segments` |
| `conversations:read` / `conversations:write` | `/conversations/*`, `/saved-replies/*` |
| `broadcasts:read` / `broadcasts:write` | `/broadcasts/*` |
| `flows:read` / `flows:write` | `/flows/*`, `/growth-links/*` |
| `sequences:read` / `sequences:write` | `/sequences/*` |
| `deals:read` / `deals:write` | `/deals/*`, `/pipelines/*` (package #6) |
| `templates:read` / `templates:write` | `/templates/*` |
| `channels:read` / `channels:write` | `/channels/*`, `/catalog-products` |
| `kb:read` / `kb:write` | `/kb/*` |
| `posts:read` / `posts:write` | `/posts/*` |
| `settings:read` / `settings:write` | `/workspaces/:id` rename, `/workspaces/:id/members/*`, `/moderation/*` |
| `*` | Every workspace resource route |

Rules:

- `GET`/`HEAD` are reads; every other method is a write. Two exceptions:
  `GET /channels/:channel/oauth/start` (a GET with side effects) requires
  `channels:write`, and `GET /stats/overview` (a cross-resource
  aggregate) requires **any** read-capable grant.
- `:write` implies `:read` for the same resource. Nothing crosses
  resources: `contacts:write` grants nothing on conversations.
- A call outside the grants answers `403 FORBIDDEN` with
  `details.requiredScope` naming the missing scope.
- **Restricted tokens** (binding and/or scopes present) may only call
  workspace resource routes at all. Auth routes (`/auth/me`,
  `/auth/tokens`, password changes), the workspace collection
  (`GET`/`POST /workspaces`), admin routes, webhooks, and public
  surfaces answer `403` even for a `*` token. Token management therefore
  always requires a session or a legacy token.
- A workspace-bound token **without** a scope list has full access
  inside its workspace's resource routes.
- An empty scope list (`[]`) is valid and grants nothing.
- Session (JWT) authentication is never scope-limited.

## Expiry

`expiresAt` (ISO 8601) gives a token a hard expiry, enforced when the
token is resolved: a past-expiry token answers
`401 TOKEN_EXPIRED` — distinct from an unknown or revoked token
(`401 UNAUTHORIZED`). Expiry is orthogonal to restriction: a token with
only an expiry is otherwise a legacy token until it lapses. The
Settings form offers Never / 30 / 90 / 365 days.

## Creating a scoped token

Settings → API tokens, or directly:

```bash
curl -X POST https://dev.botara.my.id/api/auth/tokens \
  -H "Authorization: Bearer <session-or-legacy-token>" \
  -H "content-type: application/json" \
  -d '{
    "name": "CRM sync",
    "workspaceId": "<workspace-uuid>",
    "scopes": ["contacts:read", "conversations:write"],
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }'
```

Invalid scope strings answer `400 VALIDATION`; a past `expiresAt`
answers `400 VALIDATION`. The list endpoint (`GET /auth/tokens`) returns
`workspaceId`, `scopes`, and `expiresAt` alongside the pre-existing
metadata (`name`, `prefix`, `lastUsedAt`, `revokedAt`, `createdAt`).
Revocation is unchanged: `DELETE /auth/tokens/:id`, effective
immediately.

## MCP

The MCP server needs no changes to use a scoped token: set
`BOTARA_API_TOKEN` to it and the API's enforcement applies to every tool
call — a tool whose scope is missing surfaces the API's `403 FORBIDDEN`
as the tool error. Two practical notes:

- `list_workspaces` calls `GET /auth/me`, a non-resource route, so it
  fails for restricted tokens. With a workspace-bound token you already
  know the workspace id — pass it to the other tools directly.
- Give the token exactly the scopes its tools need, e.g.
  `conversations:read` + `conversations:write` for inbox work, plus
  `contacts:read` for `list_contacts`.
