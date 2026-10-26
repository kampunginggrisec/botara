# Workspace members: invites, presence, ownership

Adoption package #9 (2026-10-27). Workspace membership lives in
`workspace_members` (roles `owner | admin | member | agent`); there is
no `workspaces.owner_id` — **ownership is a membership row with role
`owner`**. Everything below builds on that model.

## Invite-by-link

A shareable link that grants one workspace role to whoever accepts it
while signed in. Table `workspace_invites` (migration 0015).

### Lifecycle

1. **Create** — `POST /workspaces/:id/invites` (owner/admin only).
   Body: `{ role, expiresInDays?, maxUses? }`. `role` is one of
   `admin | member | agent` — **an invite can never grant owner**
   (ownership changes hands only via transfer, below). `expiresInDays`
   1–365, omit for never; `maxUses` 1–10000 or `null` = unlimited.
   The response carries the raw token and `invitePath` **once**.
2. **Preview** — `GET /invites/:token` (public, rate-limited). Returns
   `{ valid, reason, workspaceName, role, expiresAt }` and nothing
   else: no member list, no emails, no workspace id. `reason` is one of
   `invalid | revoked | expired | exhausted` when `valid` is false.
   Unknown tokens preview as `invalid` with a null workspace name, so
   probing leaks nothing.
3. **Accept** — `POST /invites/:token/accept` (signed-in session; the
   SPA's `/invite/:token` page routes logged-out visitors through
   login/register first and joins **only on an explicit Accept
   click** — loading the page never joins). Outcomes:
   - success → membership with the invite's role, `uses_count + 1`;
   - already a member → `409 ALREADY_MEMBER`, role unchanged, **no
     use consumed**;
   - unknown token → `404 INVITE_INVALID`;
   - revoked → `410 INVITE_REVOKED`; expired → `410 INVITE_EXPIRED`;
     no uses left → `410 INVITE_EXHAUSTED`.
4. **Revoke** — `DELETE /workspaces/:id/invites/:inviteId`
   (owner/admin). Stamps `revoked_at`; revoking twice is an idempotent
   success. Revocation is one-way: a revoked link stays dead (create a
   new link instead of un-revoking).

### Token hygiene

Same discipline as API tokens (#5): the raw token is `bti_` + 32
random bytes (base64url), shown exactly once at creation; the database
stores only its **SHA-256 hash** plus a display `prefix` (the first 12
characters, e.g. `bti_Ab3dEf7h…`). List responses contain the prefix,
role, expiry, use counts and revoked state — never a hash, never a raw
token. Anyone holding the link can join with its role, so treat links
like passwords: prefer an expiry and a use cap for anything shared
beyond one person.

### Atomic use-spending

Accept runs in one transaction. The use is spent by a single
conditional `UPDATE ... SET uses_count = uses_count + 1 WHERE id = ?
AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
AND (max_uses IS NULL OR uses_count < max_uses)`, and the membership
insert happens only when that update matched a row. Two accepts racing
for the last use therefore cannot both join: the loser's update
matches nothing and is classified (`revoked | expired | exhausted`)
from a fresh read. State precedence everywhere (preview + accept) is
**revoked > expired > exhausted**.

### Audit

`workspace.invite.create`, `workspace.invite.revoke` and
`workspace.invite.accept` are written to the audit log (actor, target
workspace, invite id / granted role in details).

## Presence

The members list shows an online dot per member. Presence means
exactly one thing, and the UI copy says so: **"online = has an open
realtime socket recently"**. It is not a general activity signal.

Mechanism:

- The realtime service already authenticates each socket (session JWT
  verified locally, workspace set resolved via the API). On successful
  auth it writes one Redis key per workspace the user belongs to:
  `presence:{workspaceId}:{userId}` = `1` with TTL **75 s**.
- The web client keeps the socket open on authed pages and sends a
  lightweight `{ "type": "ping" }` frame every **30 s** on the existing
  protocol (no second socket); the hub answers `{ "type": "pong" }`
  and refreshes all of that user's presence keys. Unauthenticated
  pings are rejected.
- On socket close the hub deletes the keys — but only when that user's
  **last** socket closes (multiple tabs/devices keep presence until
  all are gone). If a close frame is ever missed (crash, network
  drop), the 75 s TTL cleans up: worst case a member reads "online"
  for ~45 s after leaving (TTL minus one heartbeat).
- The API reads presence for `GET /workspaces/:id/members` with one
  pipelined `EXISTS` per member and adds `online: boolean` to each
  row. **Any Redis failure degrades to everyone-offline** — presence
  can never error or block the members list.

Constants live in `packages/shared/src/presence.ts`
(`PRESENCE_HEARTBEAT_MS = 30_000`, `PRESENCE_TTL_SECONDS = 75`); the
web client mirrors the heartbeat value. Keys are shared infra: the
TTL gives ~2.5 heartbeats of slack for jitter and brief reconnects.

## Ownership transfer

`POST /workspaces/:id/transfer-ownership { userId }`:

- **Only the current owner** may call it (admins get 403). The caller
  must actually hold an `owner` membership row.
- The target must be an existing member (404 otherwise) and cannot be
  the caller themself (400).
- One transaction: **every** `owner` row in the workspace is demoted
  to `admin`, then the target is promoted to `owner`. Running the
  demotion over all owner rows (not just the caller's) repairs the
  theoretical multi-owner state the role editor can produce, so the
  post-condition is strict: **exactly one owner after the call**, the
  previous owner keeps working access as admin, nobody is removed.
- Audited as `workspace.ownership_transferred` with
  `{ fromUserId, toUserId, toEmail }` in details.
- The SPA offers it as a per-row action visible only to the owner,
  behind a confirm dialog that spells out the consequence ("you
  become an admin"). After a successful transfer the client refreshes
  the session so role-gated UI re-renders for the new reality.

## Scoped API tokens (#5 consistency)

The workspace invite/transfer routes are covered by the existing
`/workspaces/{}` prefix rule in `route-scopes.ts`: `settings:read`
for the invite list, `settings:write` for create/revoke/transfer —
identical to the members routes. The public `/invites/{}` routes are
classified `none`: a restricted API token can never preview or accept
an invite (accepting is a human, session-based act).
