# Deals & sales pipelines (adoption package #6)

Botara's lightweight CRM: a workspace runs one or more **pipelines**
(boards); each pipeline has ordered **stages** (columns); a **deal** is a
card that sits in exactly one stage of one pipeline and tracks a
potential sale for a contact.

Design defaults (from the wacrm gap audit §5, approved with the
combined adoption program):

- **Multiple pipelines per workspace.** Exactly one may be flagged
  `is_default`; the first pipeline a workspace creates becomes the
  default automatically.
- **Workspace default currency, IDR-first.** `workspaces.default_currency`
  (ISO 4217, default `"IDR"`), editable in Settings → Workspace. A deal
  carries its own `currency`; creation falls back to the workspace
  default.
- **A deal requires a contact; a conversation is optional.** The
  conversation, when set, must belong to the same contact.
- **Won/lost is a STATUS, separate from stage.** `status ∈ open|won|lost`.
  Moving a card changes columns; closing a deal does not - a won deal
  stays in its stage with a badge (the SPA can hide closed deals via a
  filter toggle).

## Data model (migration 0012)

- `pipelines` — id, workspace_id FK, name, is_default, timestamps.
- `pipeline_stages` — id, pipeline_id FK, name, position, timestamps;
  unique (pipeline_id, position). Positions are kept dense (0..n-1):
  inserts append, deletes re-densify, reorders go through a two-phase
  update inside a transaction so the unique index never trips.
- `deals` — id, workspace_id / pipeline_id / stage_id FKs, contact_id FK
  (required), conversation_id FK (nullable), title, value numeric(14,2)
  nullable, currency varchar(3), status (default `open`),
  expected_close_date (date, nullable), notes, created_by_user_id
  (nullable - flow-created deals have no human author),
  stage_changed_at, closed_at, timestamps.
- `workspaces.default_currency` varchar(3) NOT NULL DEFAULT 'IDR'.

Default stages - **New, Contacted, Qualified, Proposal, Negotiation** -
are created by the API when a pipeline is created with
`withDefaultStages: true` (or when the create body omits both `stages`
and the flag). They are *not* seeded by the migration; pipelines are
created through the API/UI so workspaces only get boards they ask for.

## API

All routes are workspace-scoped (the usual `x-workspace-id` header /
session workspace rules) and token-scoped under the **`deals`** resource
(package #5 taxonomy): reads need `deals:read`, writes `deals:write`.
Pipelines map to the same resource - they are the deals board's frame.
Cross-workspace ids answer 404, never 403, like every sibling resource.

| Route | Notes |
|---|---|
| GET /pipelines | Pipelines with their stages embedded, position-ordered. |
| POST /pipelines | `{name, withDefaultStages?, stages?, makeDefault?}`. Explicit `stages` (names) wins over the flag. First pipeline auto-defaults. |
| PATCH /pipelines/:id | `{name?, isDefault?}` - setting `isDefault` demotes the previous default. |
| DELETE /pipelines/:id | With deals → 409 `pipeline_has_deals`; `?force=true` cascade-deletes stages + deals (mirrors the channel-account delete's confirm-then-force precedent). |
| GET /pipelines/:id/summary | Per-stage OPEN count + value sum, plus open/won/lost totals `{count, value}`. Won/lost values never leak into stage sums. Package #8 analytics consumes this shape. |
| POST /pipelines/:id/stages | `{name}` - appends at the next position. |
| PATCH /pipelines/:id/stages/:stageId | Rename. |
| DELETE /pipelines/:id/stages/:stageId | With deals → always 409 `stage_has_deals` (no force: move the deals first, so a typo can't silently relocate money). Positions re-densify after a successful delete. |
| POST /pipelines/:id/stages/reorder | `{stageIds}` must be exactly the pipeline's stage set (400 otherwise). |
| GET /deals | Filters `pipelineId`, `stageId`, `status`, `contactId`; `limit` (≤500) / `offset`. Rows embed the contact's display name / external id / channel for board rendering. `value` is serialized as a JSON number or null. |
| POST /deals | Validates composition (below). Defaults: stage = given or the pipeline's first stage; currency = given or the workspace default. |
| GET /deals/:id | Single fetch (API-ONLY in the parity classification). |
| PATCH /deals/:id | Edits + stage moves. A pipeline switch without an explicit stage lands in the new pipeline's first stage. Stage changes stamp `stage_changed_at`; entering won/lost stamps `closed_at`, reopening clears it. |
| DELETE /deals/:id | Plain delete. |

**Composition validation (400 VALIDATION, not 404):** the contact, the
pipeline and the conversation must exist in the caller's workspace, the
stage must belong to the named pipeline, and the conversation must
belong to the deal's contact. Ids that are well-formed but point at
another workspace's rows fail the same way - the request is malformed
for this workspace - while addressing a *deal or pipeline itself*
cross-workspace answers 404.

**Money serialization:** `deals.value` is a drizzle `numeric`, which
postgres-js returns as a string. Every deal/summary serializer converts
with `Number(...)` (null-safe) - the package #4 lesson - and the web
client renders money only through `formatDealMoney` (em dash for
null/non-finite). Summary totals sum per-deal values as stored; deals in
different currencies inside one pipeline sum arithmetically (v1 boards
are expected to be single-currency via the workspace default).

## Flow action: `create_deal`

A flow step (package #3 action machinery) that opens a deal for the
run's contact:

```jsonc
{ "type": "create_deal",
  "pipelineId": "…",   // optional - default: the workspace default pipeline
  "stageId": "…",      // optional - default: the pipeline's first stage
  "title": "Order {{contact.name}}",  // variable-interpolated
  "value": 150000 }    // optional
```

- Empty/unset title falls back to `Deal for {{contact.name}}`; if no
  name resolves either, the title is plain `Deal` - a created deal never
  carries an empty title or a raw `{{…}}` token.
- The deal links the run's conversation when the run has one, and uses
  the workspace default currency.
- Misconfiguration (deleted pipeline/stage, no pipeline at all) degrades
  to an `actionWarnings` entry and the run continues - never a crash.
- The API test-run port is record-only (zero mutation), like every
  action step; the recorded action carries the fully-resolved title.

## SPA

**Deals** page (nav, after Sequences): pipeline switcher + create form
(default-stages checkbox), summary header (open/won/lost counts +
values), Kanban columns in stage order. Cards show title, contact,
value + currency, expected close, and a won/lost badge. Moving works by
HTML5 drag-and-drop **and** a stage `<select>` on every card. Status
actions: Mark won / Mark lost / Reopen. Stage manager: add, rename,
move up/down (reorder endpoint), delete (409 surfaced with guidance).
The create/edit form requires a contact; the conversation picker is
optional and lists only that contact's conversations. The currency
field defaults to the workspace default (Settings → Workspace).
