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
  /**
   * Publish destination distinct from the account identity (item H):
   * telegram targets name the channel chat the bot posts to. Passed
   * through to PublishInput.targetExternalId; credential resolution
   * keeps using channelAccountId / tokenVaultRef.
   */
  targetExternalId?: string;
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

/**
 * Granular Instagram container steps (Fase 3). Instagram video/reels are a
 * two-phase publish: create a media container, WAIT until Meta finishes
 * processing it (status FINISHED), only then media_publish. The adapter
 * also performs this wait inside publish() with fixed defaults; the worker
 * uses these ports when wired so the poll is bounded and observable here,
 * with an injectable delay (tests never sleep).
 */
export interface InstagramContainerPorts {
  createContainer(channel: string, input: PublishInput): Promise<{ containerId: string }>;
  containerStatus(channel: string, account: PublishInput["account"], containerId: string): Promise<string>;
  publishContainer(channel: string, account: PublishInput["account"], containerId: string): Promise<{ externalPostId: string }>;
  /** Injectable wait between polls; production = setTimeout. */
  delay(ms: number): Promise<void>;
  /** Bounded polling budget. */
  poll: { attempts: number; delayMs: number };
}

export interface PublishPorts {
  loadPost(postId: string): Promise<ScheduledPostSnapshot | null>;
  publish(channel: string, input: PublishInput): Promise<{ externalPostId: string }>;
  recordResults(postId: string, results: Record<string, PublishTargetResult>): Promise<void>;
  updatePostStatus(postId: string, status: string): Promise<void>;
  listDuePosts(now: Date): Promise<Array<{ id: string }>>;
  enqueuePublish(postId: string): Promise<void>;
  /** Optional Fase 3 container path for Instagram video targets. */
  instagramContainers?: InstagramContainerPorts;
}

const VIDEO_URL = /\.(mp4|mov|m4v|webm)(\?|#|$)/i;

/** True when any attached media looks like a video file. */
export function postHasVideo(post: ScheduledPostSnapshot): boolean {
  return post.mediaUrls.some((u) => VIDEO_URL.test(u));
}

/**
 * Instagram video flow: create container -> poll status (bounded) ->
 * publish. Images never take this path (single-step publish is correct
 * for them and stays on ports.publish).
 */
export async function publishInstagramVideo(
  containers: InstagramContainerPorts,
  channel: string,
  input: PublishInput,
): Promise<{ externalPostId: string }> {
  const { containerId } = await containers.createContainer(channel, input);
  const { attempts, delayMs } = containers.poll;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const status = await containers.containerStatus(channel, input.account, containerId);
    if (status === "FINISHED") {
      return containers.publishContainer(channel, input.account, containerId);
    }
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`Instagram media container ${containerId} ended in status ${status}`);
    }
    if (attempt < attempts) await containers.delay(delayMs);
  }
  throw new Error(
    `Instagram media container ${containerId} not FINISHED after ${attempts} polls`,
  );
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
      const publishInput: PublishInput = {
        account: {
          id: target.channelAccountId,
          externalId: target.accountExternalId,
          authMode: target.authMode,
          tokenVaultRef: target.tokenVaultRef,
        },
        targetExternalId: target.targetExternalId,
        text: post.text,
        mediaUrls: post.mediaUrls,
        idempotencyKey: `post:${post.id}:${target.channelAccountId}`,
      };
      // Instagram VIDEO goes through the container flow (create -> poll
      // FINISHED -> publish) when the granular ports are wired; everything
      // else - including Instagram images - uses the one-shot publish.
      const result = ports.instagramContainers
        && target.channel === "instagram"
        && postHasVideo(post)
        ? await publishInstagramVideo(ports.instagramContainers, target.channel, publishInput)
        : await ports.publish(target.channel, publishInput);
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
