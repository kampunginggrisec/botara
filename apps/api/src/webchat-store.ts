import { AppError } from "@botara/shared";
import {
  createMessage, getWebchatSessionById, type Database,
} from "@botara/db";
import type { WebchatStore } from "@botara/channels";

/**
 * DB-backed WebchatStore: agent replies from the inbox (Fase 1 reply route)
 * are appended to the visitor session's conversation as outbound messages;
 * the widget picks them up on its next poll of the public messages endpoint.
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
      const message = await createMessage(db, {
        conversationId: session.conversationId,
        direction: "out",
        type: "text",
        body: input.text,
        status: "sent",
        idempotencyKey: input.idempotencyKey,
      });
      return { messageId: message.id };
    },
  };
}
