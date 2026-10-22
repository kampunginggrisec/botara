import type { ChannelAccountRef } from "@botara/channels";
import type { FlowRunRef } from "./processors";

/**
 * Comment-action processor (adopted-features package): executes ONE
 * comment_keyword flow match for ONE comment, in the brief's order:
 *
 *   public reply -> hide -> private reply (comment-to-DM) -> flow-run
 *
 * The webhook path only ENQUEUES this job (see the API dispatcher), so
 * provider webhooks still answer 200 fast. All effects go through ports:
 * production wires the channel registry + Drizzle repositories, tests wire
 * fakes.
 *
 * Idempotency: the comment is checked against the processed_comments
 * store first and marked immediately AFTER the private reply succeeds -
 * the private reply is the scarce, provider-enforced resource (Instagram
 * allows exactly ONE per comment), so its success is what "processed"
 * means. A crash before the mark re-runs the public actions on retry
 * (visible, benign); a crash in the tiny mark -> flow-run window can lose
 * the flow continuation, but the DM conversation + message already exist
 * in the inbox for a human to pick up.
 */

export interface CommentActionJobData {
  workspaceId: string;
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  tokenVaultRef?: string;
  authMode?: string;
  flowId: string;
  commentExternalId: string;
  postExternalId?: string;
  authorExternalId: string;
  commentText?: string;
  publicReplyText?: string;
  autoHide?: boolean;
  /** Explicit private-reply text from the trigger config (wins over the flow's first message node). */
  privateText?: string;
}

export interface CommentActionPorts {
  /** True when (account, comment, flow) was already processed. */
  isProcessed(input: { channelAccountId: string; commentExternalId: string; flowId: string }): Promise<boolean>;
  /** Record (account, comment, flow) as processed. */
  markProcessed(input: { workspaceId: string; channelAccountId: string; commentExternalId: string; flowId: string }): Promise<void>;
  /** The flow's first send_message node text (privateText fallback), or null. */
  loadFlowFirstMessageText(flowId: string): Promise<string | null>;
  /** Adapter moderation call (public comment reply / hide). */
  moderate(input: {
    channel: string;
    account: ChannelAccountRef;
    commentExternalId: string;
    action: "reply" | "hide";
    text?: string;
  }): Promise<void>;
  /** Adapter private reply to the comment (IG private reply / Messenger comment_id recipient). */
  privateReply(input: {
    channel: string;
    account: ChannelAccountRef;
    commentExternalId: string;
    text: string;
  }): Promise<{ externalMessageId: string }>;
  findOrCreateConversation(input: {
    workspaceId: string;
    channelAccountId: string;
    channel: string;
    authorExternalId: string;
  }): Promise<{ conversationId: string; contactId: string }>;
  persistMessage(input: {
    conversationId: string;
    body: string;
    externalId?: string;
    idempotencyKey: string;
  }): Promise<void>;
  enqueueFlowRun(ref: FlowRunRef): Promise<void>;
}

export interface CommentActionResult {
  skipped: boolean;
  reason?: string;
  actions: string[];
}

export async function processCommentAction(
  ports: CommentActionPorts,
  job: CommentActionJobData,
): Promise<CommentActionResult> {
  const account: ChannelAccountRef = {
    id: job.channelAccountId,
    externalId: job.accountExternalId,
    tokenVaultRef: job.tokenVaultRef,
    authMode: job.authMode,
  };

  const already = await ports.isProcessed({
    channelAccountId: job.channelAccountId,
    commentExternalId: job.commentExternalId,
    flowId: job.flowId,
  });
  if (already) return { skipped: true, reason: "already-processed", actions: [] };

  const actions: string[] = [];

  // 1. Public reply (visible on the post, under the comment).
  if (job.publicReplyText) {
    await ports.moderate({
      channel: job.channel, account,
      commentExternalId: job.commentExternalId, action: "reply", text: job.publicReplyText,
    });
    actions.push("public-reply");
  }

  // 2. Hide the comment (spam control).
  if (job.autoHide) {
    await ports.moderate({
      channel: job.channel, account,
      commentExternalId: job.commentExternalId, action: "hide",
    });
    actions.push("hide");
  }

  // 3. Private reply (comment-to-DM). Explicit config text wins; otherwise
  //    the flow's first send_message node IS the DM (and the flow run then
  //    skips that node so it is never sent twice).
  const firstMessageText = job.privateText ? null : await ports.loadFlowFirstMessageText(job.flowId);
  const privateText = job.privateText ?? firstMessageText ?? undefined;
  const conversation = await ports.findOrCreateConversation({
    workspaceId: job.workspaceId,
    channelAccountId: job.channelAccountId,
    channel: job.channel,
    authorExternalId: job.authorExternalId,
  });
  if (privateText) {
    const sent = await ports.privateReply({
      channel: job.channel, account,
      commentExternalId: job.commentExternalId, text: privateText,
    });
    await ports.persistMessage({
      conversationId: conversation.conversationId,
      body: privateText,
      externalId: sent.externalMessageId || undefined,
      idempotencyKey: `comment:${job.commentExternalId}:${job.flowId}`,
    });
    actions.push("private-reply");
  }

  // The provider-visible work is done: claim the comment so no redelivery
  // or retry can ever repeat it.
  await ports.markProcessed({
    workspaceId: job.workspaceId,
    channelAccountId: job.channelAccountId,
    commentExternalId: job.commentExternalId,
    flowId: job.flowId,
  });

  // 4. Continue the flow inside the resulting DM conversation.
  await ports.enqueueFlowRun({
    flowId: job.flowId,
    workspaceId: job.workspaceId,
    contactId: conversation.contactId,
    conversationId: conversation.conversationId,
    channelAccountId: job.channelAccountId,
    triggerText: job.commentText,
    commentId: job.commentExternalId,
    skipFirstSendMessage: !job.privateText && Boolean(firstMessageText),
  });
  actions.push("flow-run");

  return { skipped: false, actions };
}
