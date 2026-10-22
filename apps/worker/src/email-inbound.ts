/**
 * Email-inbound processor (Fase 2).
 *
 * Resend's `email.received` webhook carries metadata only. For each inbound
 * job this processor: fetches the full message (Receiving API), copies every
 * attachment out of its TEMPORARY Resend download URL into permanent R2
 * storage (via packages/media in the production wiring), persists the
 * message into the sender's conversation so it lands in the shared inbox,
 * and publishes exactly one inbox.message realtime event so the open inbox
 * refreshes live (the last pre-completion gap in the Fase 4 realtime work).
 */

export interface EmailInboundJobData {
  workspaceId: string;
  channelAccountId: string;
  /** The Resend email id from the webhook payload. */
  emailId: string;
}

export interface InboundAttachment {
  id: string;
  filename?: string;
  contentType?: string;
  /** Temporary provider URL - expires; the processor copies bytes to R2. */
  downloadUrl: string;
}

export interface FetchedInboundEmail {
  from: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments: InboundAttachment[];
}

export interface StoredAttachment {
  key: string;
  filename?: string;
  contentType?: string;
}

/**
 * Live-inbox event. Matches the `inbox.message` payload published by the API
 * (apps/api/src/realtime-publish.ts) on the `botara:realtime` Redis channel -
 * the worker cannot import that module, so this mirrors its shape here.
 */
export interface EmailInboxMessageEvent {
  workspaceId: string;
  conversationId: string;
  direction: "in" | "out";
  messageId?: string;
}

export interface EmailInboundPorts {
  /** Fetch full content via the email adapter (Receiving + Attachments APIs). */
  fetchInbound(job: EmailInboundJobData): Promise<FetchedInboundEmail>;
  /** Download the attachment bytes and store them permanently in R2. */
  storeAttachment(input: {
    workspaceId: string;
    emailId: string;
    attachment: InboundAttachment;
  }): Promise<{ key: string; publicUrl?: string }>;
  /** Find the sender's contact + open conversation, creating them if needed. */
  findOrCreateConversation(input: {
    workspaceId: string;
    channelAccountId: string;
    from: string;
  }): Promise<{ conversationId: string; contactId: string }>;
  /** Persist the inbound message; returns its row id for the realtime event. */
  persistMessage(input: {
    conversationId: string;
    externalId: string;
    subject?: string;
    body?: string;
    attachments: StoredAttachment[];
  }): Promise<{ id: string }>;
  touchLastUserMessage(conversationId: string, at: Date): Promise<void>;
  /**
   * Live inbox: publish exactly one inbox.message event per persisted inbound
   * message. Fire-and-forget - implementations must swallow their own errors
   * so a realtime outage never fails the job. Optional for tests and
   * deployments without the realtime bus.
   */
  publishInboxMessage?: (event: EmailInboxMessageEvent) => Promise<void>;
}

export async function processEmailInbound(
  ports: EmailInboundPorts,
  job: EmailInboundJobData,
): Promise<{ attachmentsStored: number }> {
  const content = await ports.fetchInbound(job);

  const stored: StoredAttachment[] = [];
  for (const attachment of content.attachments) {
    const result = await ports.storeAttachment({
      workspaceId: job.workspaceId,
      emailId: job.emailId,
      attachment,
    });
    stored.push({ key: result.key, filename: attachment.filename, contentType: attachment.contentType });
  }

  const conversation = await ports.findOrCreateConversation({
    workspaceId: job.workspaceId,
    channelAccountId: job.channelAccountId,
    from: content.from,
  });
  const message = await ports.persistMessage({
    conversationId: conversation.conversationId,
    externalId: job.emailId,
    subject: content.subject,
    body: content.text ?? content.html,
    attachments: stored,
  });
  await ports.touchLastUserMessage(conversation.conversationId, new Date());
  // Live inbox: exactly one event per persisted inbound message, never a
  // failure path (mirrors the API dispatcher's contract).
  await ports.publishInboxMessage?.({
    workspaceId: job.workspaceId,
    conversationId: conversation.conversationId,
    direction: "in",
    messageId: message.id,
  }).catch(() => undefined);
  return { attachmentsStored: stored.length };
}
