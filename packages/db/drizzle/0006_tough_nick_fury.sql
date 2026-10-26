-- Pre-index dedupe for conversations_open_unique_idx.
-- Botara historically allowed more than one NON-RESOLVED conversation per
-- (channel_account_id, contact_id) when concurrent inbound webhooks raced
-- findOrCreateConversation. Before the partial unique index below can be
-- created, collapse any such duplicates onto the OLDEST thread (created_at,
-- then id): child rows that reference a younger duplicate are re-pointed
-- to the keeper, then the younger duplicates are marked resolved (their
-- history stays readable; nothing is deleted). The keeper subquery only
-- considers non-resolved rows, and every statement is guarded by
-- id <> keeper_id, so the whole block is a no-op on clean data and safe
-- to re-run.
UPDATE "messages" AS m
SET "conversation_id" = k.keeper_id
FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY channel_account_id, contact_id
           ORDER BY created_at ASC, id ASC
         ) AS keeper_id
  FROM "conversations"
  WHERE status <> 'resolved'
) AS k
WHERE m."conversation_id" = k.id
  AND k.id <> k.keeper_id;--> statement-breakpoint
UPDATE "webchat_sessions" AS s
SET "conversation_id" = k.keeper_id
FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY channel_account_id, contact_id
           ORDER BY created_at ASC, id ASC
         ) AS keeper_id
  FROM "conversations"
  WHERE status <> 'resolved'
) AS k
WHERE s."conversation_id" = k.id
  AND k.id <> k.keeper_id;--> statement-breakpoint
UPDATE "conversations" AS c
SET status = 'resolved'
FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY channel_account_id, contact_id
           ORDER BY created_at ASC, id ASC
         ) AS keeper_id
  FROM "conversations"
  WHERE status <> 'resolved'
) AS k
WHERE c.id = k.id
  AND k.id <> k.keeper_id;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_unique_idx" ON "conversations" USING btree ("channel_account_id","contact_id") WHERE "conversations"."status" <> 'resolved';
