# Analytics (insights phase 1)

Adoption package #8 adds `GET /stats/insights` plus an **Analytics**
page in the SPA: per-channel volume, response-time metrics against a
workspace reply target, and a recent-activity feed. Everything is
computed query-time from `messages`, `conversations`,
`channel_accounts`, and `audit_log` - phase 1 deliberately has **no
rollup tables** (see the query-cost note at the bottom).

## Endpoint

```
GET /stats/insights?days=7|30        (default 30)
```

Access mirrors `GET /stats/overview` exactly: a session, or an API
token carrying any read-capable grant (route-scopes classifies all of
`/stats/*` as `any-read`); the workspace comes from the session /
token binding as usual. Any other `days` value is a 400.

Response (unwrapped body, like the overview):

```jsonc
{
  "days": 30,
  "periodStart": "…",           // now - days
  "previousPeriodStart": "…",   // now - 2*days
  "replyTargetMinutes": 60,
  "channels": [
    { "channel": "whatsapp", "conversationsOpened": 4, "messagesIn": 4, "messagesOut": 3 }
  ],
  "response": {
    "waitingCount": 2,
    "oldestWaitingMinutes": 200,          // null when nothing waits
    "overTargetCount": 1,
    "medianFirstResponseMinutes": { "human": 15, "ai": 30 },
    "previousMedianFirstResponseMinutes": { "human": 50, "ai": 20 }
  },
  "activity": [
    { "id": "…", "actor": { "userId": "…", "name": "…", "email": "…" } | null,
      "action": "deal.created", "details": { }, "createdAt": "…" }
  ]
}
```

## Period semantics

- The **current period** is `[now - days, now)`; the **previous
  period** is `[now - 2*days, now - days)`.
- A conversation belongs to a period by its **creation time**
  (`conversations.created_at`), not by when its messages arrived.
- The waiting block is **point-in-time** (right now), not
  period-scoped - it answers "who is waiting at this moment", so it is
  identical under `days=7` and `days=30`.

## Metric definitions

### Per-channel rows

For each channel that has any activity in the current period:

- `conversationsOpened` - conversations created in the period on
  channel accounts of that channel.
- `messagesIn` / `messagesOut` - messages with `created_at` in the
  period and `direction` in/out, joined through their conversation's
  channel account. Only real traffic counts: rows with
  `kind = 'note'` (internal notes, #2) are excluded; a `kind` of null
  (legacy rows) counts as a message.

### Waiting block

A conversation is **waiting** when it is not resolved and its latest
real message is inbound - equivalently, its latest inbound message is
newer than its latest outbound message (or it has no outbound message
at all).

- `waitingCount` - number of waiting conversations.
- `oldestWaitingMinutes` - the longest current wait, measured from the
  conversation's latest inbound message to now (1-decimal minutes;
  null when nothing waits).
- `overTargetCount` - waiting conversations whose wait exceeds the
  workspace reply target (strictly greater than).

### First-response medians

For every conversation created in a period that has at least one
inbound message and at least one outbound message after it:

- **first response gap** = `first outbound after the first inbound -
  first inbound`, in minutes.
- **attribution** is decided by the first outbound message's
  `author_kind` (#7): `human` or `ai`. Flow `ai_reply` text sends are
  stamped `ai` at the send seam; agent replies, broadcasts, and flow
  template sends are `human`. The marker is by origin, never inferred
  from content.
- `medianFirstResponseMinutes.human` / `.ai` - the median of that
  bucket's gaps (even counts average the two middle values), rounded
  to 1 decimal; null when the bucket is empty. The same computation
  over the previous period's cohort fills
  `previousMedianFirstResponseMinutes`, which the UI renders as a
  faster/slower delta (only when both medians exist).

### Activity feed

The workspace's 50 newest `audit_log` rows (`workspace_id` = the
workspace; rows with a null workspace are platform-level and never
included), newest first. `actor` is resolved against the workspace's
current member list - a departed member resolves with null name/email,
and a row without a user (system/sweeper entries) has `actor: null`.
Only audit actions that already exist are shown; no event sources
were invented for this feed.

### Pipeline card (UI)

The Analytics page also shows the workspace default pipeline's
summary (`GET /pipelines/:id/summary`, #6): open value plus won and
lost totals. These are **current totals across all deals**, not
period-scoped, and the card is labeled as such - the period filter
does not apply to it.

## Reply target

`workspaces.reply_target_minutes` (migration 0014, default **60**)
is the workspace's service target for first replies. It is editable in
Settings next to the default currency, through the same
`PATCH /workspaces/:id` widening used for `defaultCurrency`:
admin roles (owner/admin) only, range 1..10080 minutes, audited as
`workspace.reply_target`. `overTargetCount` reads it fresh on every
insights call.

## Inbox message status advancement

Provider delivery receipts (`message.status` webhook events) now
advance the matching **inbox message row** in addition to broadcast
recipient rows (#4). The match key is the provider message id stored
on `messages.external_id` at the send seam (there is no separate
provider-id column on `messages`), scoped to the webhook account's
workspace. Transitions are forward-only via the shared pure guard
`messageStatusTransition`: `queued < sent < delivered < read`;
`failed` is reachable only from `queued`/`sent` and is terminal;
unknown ids are no-ops. The inbox bubble renders ticks
(◷ queued, ✓ sent, ✓✓ delivered, blue ✓✓ read, ✗ failed) with the
localized status label.

## Query cost

Deliberately bounded for phase 1: one message scan over a two-period
window (current + previous) for the workspace's conversations, one
slim projection scan (`conversation_id, direction, created_at`) for
the waiting computation, and a 50-row audit read. The waiting scan is
not period-bounded by design (it is point-in-time over open threads);
if a workspace grows to very large open-thread counts, phase 2 should
add `last_inbound_at`/`last_outbound_at` stamps on conversations -
the metric definitions above would not change.
