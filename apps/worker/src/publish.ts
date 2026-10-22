import type { PublishInput } from "@botara/channels";

/**
 * Publish processors (Fase 2 publishing suite).
 *
 * Two job shapes on the "publish" queue:
 * - "scan"    (every minute): enqueue one "publish" job per due post.
 * - "publish" (per post): call each target adapter's publish and record the
 *             per-target result. PARTIAL-FAILURE semantics: one target
 *             failing never fails the others; the post ends "published"
 *             (all sent), "partial" (some sent), or "failed" (none sent).
 *             Re-runs skip targets already marked sent (idempotent).
 */

export interface PublishTargetSnapshot {
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  authMode?: string;
  tokenVaultRef?: string;
}

export type PublishTargetResult = { status: "sent" | "failed"; externalPostId?: string; error?: string };

export interface ScheduledPostSnapshot {
  id: string;
  workspaceId: string;
  text?: string;
  mediaUrls: string[];
  targets: PublishTargetSnapshot[];
  status: string;
  results: Record<string, PublishTargetResult>;
}

export interface PublishPorts {
  loadPost(postId: string): Promise<ScheduledPostSnapshot | null>;
  publish(channel: string, input: PublishInput): Promise<{ externalPostId: string }>;
  recordResults(postId: string, results: Record<string, PublishTargetResult>): Promise<void>;
  updatePostStatus(postId: string, status: string): Promise<void>;
  listDuePosts(now: Date): Promise<Array<{ id: string }>>;
  enqueuePublish(postId: string): Promise<void>;
}

export async function processPublishScan(
  ports: PublishPorts,
  now: Date,
): Promise<{ enqueued: number }> {
  const due = await ports.listDuePosts(now);
  for (const post of due) {
    await ports.enqueuePublish(post.id);
  }
  return { enqueued: due.length };
}

export async function processPublish(
  ports: PublishPorts,
  input: { postId: string },
): Promise<{ status: string; sent: number; failed: number }> {
  const post = await ports.loadPost(input.postId);
  if (!post) throw new Error(`Scheduled post ${input.postId} not found`);

  const results: Record<string, PublishTargetResult> = { ...post.results };
  const countSent = () =>
    post.targets.filter((t) => results[t.channelAccountId]?.status === "sent").length;

  if (post.status === "published") {
    return { status: "published", sent: countSent(), failed: 0 };
  }
  if (post.status === "cancelled") {
    return { status: "cancelled", sent: countSent(), failed: 0 };
  }

  for (const target of post.targets) {
    if (results[target.channelAccountId]?.status === "sent") continue; // idempotent re-run
    try {
      const result = await ports.publish(target.channel, {
        account: {
          id: target.channelAccountId,
          externalId: target.accountExternalId,
          authMode: target.authMode,
          tokenVaultRef: target.tokenVaultRef,
        },
        text: post.text,
        mediaUrls: post.mediaUrls,
        idempotencyKey: `post:${post.id}:${target.channelAccountId}`,
      });
      results[target.channelAccountId] = { status: "sent", externalPostId: result.externalPostId };
    } catch (err) {
      results[target.channelAccountId] = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  await ports.recordResults(post.id, results);
  const sent = countSent();
  const failed = post.targets.length - sent;
  const status = sent === post.targets.length ? "published" : sent > 0 ? "partial" : "failed";
  await ports.updatePostStatus(post.id, status);
  return { status, sent, failed };
}
