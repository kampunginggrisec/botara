import { AppError } from "@botara/shared";
import {
  createMessage, findMessageByIdempotencyKey, getWebchatSessionById,
  updateMessageStatus, type Database,
} from "@botara/db";
import type { WebchatStore } from "@botara/channels";

/**
 * DB-backed WebchatStore: agent replies from the inbox (Fase 1 reply route)
 * are appended to the visitor session's conversation as outbound messages;
 * the widget picks them up on its next poll of the public messages endpoint.
 *
 * IDEMPOTENCY SEAM: the reply route persists its own outbound row FIRST
 * (status "queued", idempotencyKey `reply:<convId>:<uuid>`) and then calls
 * the adapter with the SAME key. Delivery therefore looks the key up first:
 * an existing row is reused (marked "sent", its id returned) and only a
 * genuinely new send inserts. Without this check every inbox reply to a
 * webchat conversation was persisted TWICE - once by the route, once here.
 */
export function createDbWebchatStore(db: Database): WebchatStore {
  return {
    async deliverOutbound(input) {
      const prefix = "webchat-session:";
      if (!input.toExternalId.startsWith(prefix)) {
        throw new AppError("VALIDATION", `webchat recipient must be a session externalId (${prefix}...).`, { status: 400 });
      }
      const sessionId = input.toExternalId.slice(prefix.length);
      const session = await getWebchatSessionById(db, sessionId);
      if (!session) {
        throw new AppError("NOT_FOUND", "Webchat session not found for this conversation.", { status: 404 });
      }
      const existing = await findMessageByIdempotencyKey(db, session.conversationId, input.idempotencyKey);
      if (existing) {
        await updateMessageStatus(db, existing.id, "sent");
        return { messageId: existing.id };
      }
      const message = await createMessage(db, {
        conversationId: session.conversationId,
        direction: "out",
        // A payload-carrying send is a rich message; the widget renders
        // buttons/lists from the payload, the body stays plain text.
        type: input.payload ? "rich" : "text",
        body: input.text,
        payload: input.payload,
        status: "sent",
        idempotencyKey: input.idempotencyKey,
      });
      return { messageId: message.id };
    },
  };
}
