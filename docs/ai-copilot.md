# AI Copilot (package #7)

The AI copilot layer on top of Botara's OpenAI-compatible AI provider
(panel-configured, DB → env). It completes the Fase-2/3 AI surface —
`ai-suggest` (composer drafts) and flow `ai_reply` nodes — with four
things: persisted conversation analysis, an honest producer badge on
AI-sent messages, token usage in the cost ledger, and human takeover.

Everything here follows the platform's honesty rules: when no AI
provider is configured the endpoints fail closed with 503 and output
is **never faked**; malformed model output is an error, never a
placeholder; usage numbers are recorded only when the provider
actually reports them.

## 1. Conversation analysis

`POST /conversations/{id}/ai-analyze` (workspace-scoped, roles
owner/admin/member/agent):

1. Loads the thread's messages, **excludes internal notes**
   (`kind = 'note'` never enters a prompt — the same rule ai-suggest
   has followed since package #2), and keeps the most recent
   **30 messages** (`CONVERSATION_ANALYSIS_HISTORY_CAP` in
   `@botara/ai`). The cap bounds prompt cost; older context is
   dropped, not summarized recursively.
2. Makes **one** chat completion (temperature 0) asking for a strict
   JSON object — no prose, no markdown fences (fences are tolerated
   and stripped if the model adds them anyway).
3. Validates the answer with `parseConversationAnalysis`:
   - `summary`: non-empty string (truncated at 1000 chars, never
     rejected for length);
   - `intent`: one of the closed label set below (case-normalized);
   - `intentScore`: a finite number, rounded and required to land in
     0–100.
   Anything else → **502 `AI_RESPONSE_INVALID`** and **nothing is
   persisted** — the previous analysis (if any) stays untouched.
4. Persists on the conversation row (migration 0013):
   `ai_summary`, `ai_summary_at`, `ai_intent`, `ai_intent_score`.
   The conversation list serializer exposes all four plus
   `ai_paused_at`, so the inbox list and thread header render from the
   same payload.

Intent labels (closed set — the model must pick exactly one):

| Label | Meaning |
|---|---|
| `inquiry` | Asking for information, no buying signal yet |
| `purchase_intent` | Wants to buy / order / pricing with intent to transact |
| `support` | Needs help with something already bought or an account issue |
| `complaint` | Dissatisfied, reporting a problem or bad experience |
| `spam` | Spam, scam, or bulk unsolicited content |
| `other` | Anything that fits none of the above |

The inbox thread header shows the summary text and an
`intent · score` chip when an analysis exists, with an
**Analyze / Refresh** button. A 503 shows the "no AI provider"
toast; a 502 shows "the AI returned an unreadable analysis — nothing
was saved".

## 2. The AI badge (`messages.author_kind`)

Migration 0013 adds `messages.author_kind` — `'human'` (default) or
`'ai'`. The badge follows the **origin** of the text, never its
content, and is stamped at exactly one seam per path:

- **Flow `ai_reply` nodes**: the flow executor marks its send port
  call `authorKind: "ai"` **only** for model-generated text. The
  authored fallback (sent when the AI port returns null) and every
  other node type (`send_message`, sequences, broadcasts,
  comment-to-DM) are human-authored content and stay `'human'`.
- The badge rides `FlowPorts.sendMessage` → the worker's send job →
  `SendInput.authorKind` → the webchat adapter → `WebchatStore`,
  whose two implementations (API + worker) persist it via
  `createMessage`.

Scope note: flow/sequence/broadcast sends persist a message row
**only on webchat** (the store seam) — on Meta/Telegram channels no
row exists for an outbound flow send, so there is nothing to badge
there today. Inbox agent replies are persisted by the reply route and
always carry `'human'` (plus `author_user_id` as before). The inbox
renders an **AI** chip on badged bubbles, and the thread header shows
"AI replies active" when the open thread contains a badged message
and AI is not paused.

## 3. Usage → `cost_ledger`

**Every** AI call writes one `cost_ledger` row via
`insertAiUsageLedger` (migration 0013 makes `units` nullable and adds
a `model` column):

| Field | Value |
|---|---|
| `category` | `"ai"` |
| `channel` | the conversation's channel (`"ai"` when no conversation is resolvable, e.g. legacy flow jobs) |
| `channel_account_id` | the conversation's account, when known |
| `reference_id` | conversation id (API calls, flow replies); flow jobs without a conversation fall back to the workspace id |
| `model` | the model that actually answered (from the provider response) |
| `units` | **total tokens** (input + output) when the provider response carries `usage`; otherwise **NULL** |
| `amount` | **0** — always |

Honesty rules, non-negotiable:

- **No invented tokens.** The embedding seam of the AI client returns
  a bare vector with no usage data, so KB *query* embeddings (in
  ai-suggest and in the worker's ai_reply) are recorded with NULL
  units — the row proves the call happened; the token count is
  honestly unknown. (KB *ingest* embeddings on the worker's document
  pipeline are not recorded: that port predates usage plumbing and is
  a document job, not a copilot call.)
- **No invented prices.** Botara has no per-model rate card for chat
  models (the billing package rates WhatsApp conversations only), so
  `amount` stays 0 and the token count is the recorded truth. If a
  rate card is ever added, it must be applied from the recorded
  `model` + `units`, never back-filled with estimates.
- The usage row is written even when analysis parsing then fails
  (the tokens were spent either way) — but the analysis fields are
  not persisted in that case.
- Ledger writes are best-effort bookkeeping (same pattern as
  broadcast recipient rows): a failure is logged, never allowed to
  fail the AI call itself.
- Admin billing tolerates the new category: aggregations group by
  category dynamically, and NULL `units` contribute 0 (SQL `sum`
  ignores NULLs; the JS aggregators coalesce). The dashboard shows
  `ai` rows with their token counts and $0 amounts.

## 4. Takeover (pause / resume)

`conversations.ai_paused_at` (migration 0013) is the takeover stamp.

- `POST /conversations/{id}/ai-pause` stamps it (idempotent —
  re-pausing keeps the original stamp); `POST /conversations/{id}/ai-resume`
  clears it. Both publish the standard inbox-update realtime event so
  other open inboxes refresh their header state.
- **Any successful human reply** through `POST /conversations/{id}/reply`
  auto-pauses (classic takeover: a human taking the wheel stops the
  automation). A failed send does not pause — nothing reached the
  customer.
- While paused, the worker's flow wrapper checks the stamp via the
  `isConversationAiPaused` port **before** delegating to the AI port:
  the model is never called, the port returns null, and the executor
  sends the `ai_reply` node's authored `fallbackText` instead — a
  paused thread degrades to the flow's own words, never to silence.
- **Agent-invoked tools are NOT paused.** `ai-suggest` and
  `ai-analyze` keep working on a paused conversation: pausing stops
  *automatic* sends, it must never disarm the human's own instruments.
- The inbox header shows an amber **"AI paused"** state with a
  **Resume AI** button while paused, and a subtle "AI replies active"
  note plus a **Pause AI** button otherwise (the note only appears
  once AI has actually sent on that thread).

## 5. Endpoint summary

| Route | Behavior |
|---|---|
| `POST /conversations/{id}/ai-analyze` | 503 unconfigured · 502 malformed model output · 404 cross-workspace · 200 `{aiSummary, aiSummaryAt, aiIntent, aiIntentScore, model}` |
| `POST /conversations/{id}/ai-pause` | 200 `{conversation}` with `aiPausedAt` set · 404 cross-workspace |
| `POST /conversations/{id}/ai-resume` | 200 `{conversation}` with `aiPausedAt: null` · 404 cross-workspace |

All three are workspace-scoped, require the inbox role set
(owner/admin/member/agent), and are scope-mapped to the
`conversations` resource for scoped API tokens (package #5) via the
existing `/conversations` prefix rule.
