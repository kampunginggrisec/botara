import {
  createContact, createConversation, createMessage, findChannelAccountByExternal,
  findMessageByExternalId, findOpenConversation, getContactByExternal, listActiveFlows,
  listConnectedAccountsByChannel, touchConversationLastUserMessage, type Database,
} from "@botara/db";
import { flowTriggerMatches, type FlowTrigger } from "@botara/flow-engine";
import type { InboundEvent } from "@botara/channels";

/**
 * Inbound flow dispatcher (Fase 4).
 *
 * Channel webhooks (whatsapp/telegram at minimum, plus any channel whose
 * parsed events carry an account external id) hand their message.received
 * events here AFTER the event sink. For each event the dispatcher:
 *   1. resolves the channel account -> workspace,
 *   2. persists the message into the inbox (contact/conversation/message,
 *      deduplicated on the provider message id for webhook redeliveries),
 *   3. matches ACTIVE flows whose keyword/postback trigger fits, and
 *      enqueues one flow-run job per match (id-based payload; the worker
 *      loads the graph + contact from repositories).
 *
 * Webhooks must always acknowledge the provider: this port NEVER throws -
 * failures are logged as structured lines and swallowed.
 */

export interface FlowRunJobPayload {
  flowId: string;
  workspaceId: string;
  contactId: string;
  conversationId: string;
  channelAccountId: string;
  triggerText?: string;
}

export interface FlowRunEnqueuer {
  enqueueFlowRun(job: FlowRunJobPayload): Promise<unknown>;
}

export interface InboundFlowDispatcher {
  dispatch(events: InboundEvent[]): Promise<void>;
}

/** Channels whose inbound messages persist + trigger flows by default. */
const DISPATCH_CHANNELS = new Set(["whatsapp", "telegram", "instagram", "messenger", "threads"]);

export interface DbFlowDispatcherDeps {
  getDatabase: () => Database;
  flowEnqueuer: FlowRunEnqueuer;
}

export function createDbFlowDispatcher(deps: DbFlowDispatcherDeps): InboundFlowDispatcher {
  const log = (line: Record<string, unknown>): void =>
    console.error(JSON.stringify({ level: "error", scope: "flows-dispatch", ...line }));

  return {
    async dispatch(events: InboundEvent[]): Promise<void> {
      for (const event of events) {
        try {
          if (event.type !== "message.received" && event.type !== "postback.received") continue;
          if (!DISPATCH_CHANNELS.has(event.channel)) continue;
          if (!event.contactExternalId) continue;
          const db = deps.getDatabase();
          let account = event.accountExternalId
            ? await findChannelAccountByExternal(db, event.channel, event.accountExternalId)
            : null;
          if (!account) {
            // Telegram updates carry no bot identity: when exactly ONE
            // connected account exists for the channel, the update must be
            // for it. With several bots the event cannot be attributed and
            // is skipped (per-bot webhook URLs are a documented follow-up).
            const candidates = await listConnectedAccountsByChannel(db, event.channel);
            if (candidates.length === 1) account = candidates[0]!;
          }
          if (!account || account.status !== "connected") continue;
          const workspaceId = account.workspaceId;

          // 1. contact (find or create)
          let contact = await getContactByExternal(db, workspaceId, event.channel, event.contactExternalId);
          if (!contact) {
            try {
              contact = await createContact(db, {
                workspaceId,
                channel: event.channel,
                externalId: event.contactExternalId,
              });
            } catch {
              contact = await getContactByExternal(db, workspaceId, event.channel, event.contactExternalId);
            }
          }
          if (!contact) continue;

          // 2. conversation (+ message row for real messages, idempotent on
          //    the provider message id so webhook redeliveries don't dup)
          let conversation = await findOpenConversation(db, {
            workspaceId,
            channelAccountId: account.id,
            contactId: contact.id,
          });
          if (!conversation) {
            conversation = await createConversation(db, {
              workspaceId,
              channelAccountId: account.id,
              contactId: contact.id,
            });
          }
          if (event.type === "message.received") {
            const existing = await findMessageByExternalId(db, conversation.id, event.messageExternalId);
            if (!existing) {
              await createMessage(db, {
                conversationId: conversation.id,
                direction: "in",
                type: event.media ? "media" : "text",
                body: event.text,
                externalId: event.messageExternalId,
                status: "delivered",
              });
              await touchConversationLastUserMessage(db, conversation.id, new Date(event.receivedAt));
            }
          }

          // 3. match active flows + enqueue runs
          const flows = await listActiveFlows(db, workspaceId);
          for (const flow of flows) {
            const trigger = flow.trigger as FlowTrigger;
            const matched = event.type === "message.received"
              ? flowTriggerMatches(trigger, { text: event.text })
              : flowTriggerMatches(trigger, { payload: event.payload });
            if (!matched) continue;
            try {
              await deps.flowEnqueuer.enqueueFlowRun({
                flowId: flow.id,
                workspaceId,
                contactId: contact.id,
                conversationId: conversation.id,
                channelAccountId: account.id,
                triggerText: event.type === "message.received" ? event.text : event.payload,
              });
            } catch (err) {
              log({ event: "flow_run_enqueue_failed", flowId: flow.id, workspaceId, error: String(err) });
            }
          }
        } catch (err) {
          // Webhook acknowledgment is king: log and continue with the next event.
          log({ event: "dispatch_failed", channel: event.channel, error: err instanceof Error ? err.message : String(err) });
        }
      }
    },
  };
}

/** No-op dispatcher for tests / unconfigured deployments. */
export const noopFlowDispatcher: InboundFlowDispatcher = { async dispatch() {} };
