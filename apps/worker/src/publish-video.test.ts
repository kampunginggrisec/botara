import { describe, expect, test } from "bun:test";
import {
  processPublish,
  type PublishPorts,
  type ScheduledPostSnapshot,
} from "./publish";

/**
 * Fase 3: Instagram VIDEO publish - the processor creates a media
 * container, polls its status with a bounded budget (injectable delay, so
 * tests never sleep) until FINISHED, and only then calls media_publish.
 * Images keep the one-shot publish path.
 */

function igPost(mediaUrls: string[], channel = "instagram"): ScheduledPostSnapshot {
  return {
    id: "post-1",
    workspaceId: "ws-1",
    text: "halo",
    mediaUrls,
    targets: [{
      channelAccountId: "acc-ig",
      channel,
      accountExternalId: "17841400008460056",
    }],
    status: "publishing",
    results: {},
  };
}

function fakePorts(
  post: ScheduledPostSnapshot,
  statuses: string[],
  opts: { attempts?: number } = {},
) {
  const calls = {
    plainPublish: 0,
    createContainer: 0,
    publishContainer: 0,
    statusPolls: 0,
    delays: [] as number[],
    finalStatus: "",
    results: null as unknown,
  };
  let statusIdx = 0;
  const ports: PublishPorts = {
    async loadPost() { return post; },
    async publish() { calls.plainPublish++; return { externalPostId: "plain-1" }; },
    async recordResults(_id, results) { calls.results = results; },
    async updatePostStatus(_id, status) { calls.finalStatus = status; },
    async listDuePosts() { return []; },
    async enqueuePublish() {},
    instagramContainers: {
      async createContainer() { calls.createContainer++; return { containerId: "cont-1" }; },
      async containerStatus() {
        calls.statusPolls++;
        return statuses[Math.min(statusIdx++, statuses.length - 1)]!;
      },
      async publishContainer() { calls.publishContainer++; return { externalPostId: "ig-media-1" }; },
      async delay(ms) { calls.delays.push(ms); },
      poll: { attempts: opts.attempts ?? 10, delayMs: 5 },
    },
  };
  return { ports, calls };
}

describe("Instagram video publish (fake container ports)", () => {
  test("polls IN_PROGRESS -> FINISHED, then publishes the container exactly once", async () => {
    const { ports, calls } = fakePorts(
      igPost(["https://cdn.example.com/reel.mp4"]),
      ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"],
    );
    const result = await processPublish(ports, { postId: "post-1" });
    expect(result.status).toBe("published");
    expect(calls.createContainer).toBe(1);
    expect(calls.statusPolls).toBe(3);
    expect(calls.delays).toEqual([5, 5]); // waits between polls only
    expect(calls.publishContainer).toBe(1);
    expect(calls.plainPublish).toBe(0);
  });

  test("a container ERROR fails the target without calling media_publish", async () => {
    const { ports, calls } = fakePorts(
      igPost(["https://cdn.example.com/reel.mp4"]),
      ["IN_PROGRESS", "ERROR"],
    );
    const result = await processPublish(ports, { postId: "post-1" });
    expect(result.status).toBe("failed");
    expect(calls.publishContainer).toBe(0);
    const results = calls.results as Record<string, { status: string; error?: string }>;
    expect(results["acc-ig"]!.status).toBe("failed");
    expect(results["acc-ig"]!.error).toContain("ERROR");
  });

  test("polling is BOUNDED: a stuck container times out as a target failure", async () => {
    const { ports, calls } = fakePorts(
      igPost(["https://cdn.example.com/clip.mov"]),
      ["IN_PROGRESS"],
      { attempts: 3 },
    );
    const result = await processPublish(ports, { postId: "post-1" });
    expect(result.status).toBe("failed");
    expect(calls.statusPolls).toBe(3);
    expect(calls.publishContainer).toBe(0);
    const results = calls.results as Record<string, { error?: string }>;
    expect(results["acc-ig"]!.error).toContain("not FINISHED after 3 polls");
  });

  test("IMAGES are unchanged: one-shot publish, container ports untouched", async () => {
    const { ports, calls } = fakePorts(
      igPost(["https://cdn.example.com/photo.jpg"]),
      ["FINISHED"],
    );
    const result = await processPublish(ports, { postId: "post-1" });
    expect(result.status).toBe("published");
    expect(calls.plainPublish).toBe(1);
    expect(calls.createContainer).toBe(0);
    expect(calls.statusPolls).toBe(0);
  });

  test("video on a NON-Instagram target uses the plain publish path", async () => {
    const { ports, calls } = fakePorts(
      igPost(["https://cdn.example.com/reel.mp4"], "threads"),
      ["FINISHED"],
    );
    const result = await processPublish(ports, { postId: "post-1" });
    expect(result.status).toBe("published");
    expect(calls.plainPublish).toBe(1);
    expect(calls.createContainer).toBe(0);
  });
});
