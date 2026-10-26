import { describe, expect, test } from "bun:test";
import type { PublishInput } from "@botara/channels";
import {
  processPublish,
  type PublishPorts,
  type ScheduledPostSnapshot,
} from "./publish";

/**
 * Item H: Telegram publish targets carry a DESTINATION (targetExternalId
 * — the channel chat) separate from the bot account identity. The
 * processor must hand the destination to the adapter as
 * PublishInput.targetExternalId while the account ref (id, externalId,
 * tokenVaultRef) stays the real bot account, so credential resolution
 * is unaffected. Non-telegram targets pass no destination.
 */

function postWith(targets: ScheduledPostSnapshot["targets"]): ScheduledPostSnapshot {
  return {
    id: "post-h",
    workspaceId: "ws-1",
    text: "Pengumuman kelas baru!",
    mediaUrls: [],
    targets,
    status: "publishing",
    results: {},
  };
}

function capturingPorts(post: ScheduledPostSnapshot) {
  const inputs: Array<{ channel: string; input: PublishInput }> = [];
  const ports: PublishPorts = {
    async loadPost() { return post; },
    async publish(channel, input) {
      inputs.push({ channel, input });
      return { externalPostId: `ext-${inputs.length}` };
    },
    async recordResults() {},
    async updatePostStatus() {},
    async listDuePosts() { return []; },
    async enqueuePublish() {},
  };
  return { ports, inputs };
}

describe("processPublish telegram destination (item H)", () => {
  test("telegram target: destination passes through, account identity untouched", async () => {
    const post = postWith([{
      channelAccountId: "acc-tg",
      channel: "telegram",
      accountExternalId: "8808425227", // the BOT's own user id
      targetExternalId: "@kampungchannel",
      tokenVaultRef: "vault:telegram:acc-tg",
    }]);
    const { ports, inputs } = capturingPorts(post);
    const res = await processPublish(ports, { postId: "post-h" });
    expect(res).toEqual({ status: "published", sent: 1, failed: 0 });
    expect(inputs).toHaveLength(1);
    const { channel, input } = inputs[0]!;
    expect(channel).toBe("telegram");
    // Destination = the channel chat…
    expect(input.targetExternalId).toBe("@kampungchannel");
    // …while the credential identity stays the real bot account.
    expect(input.account.id).toBe("acc-tg");
    expect(input.account.externalId).toBe("8808425227");
    expect(input.account.tokenVaultRef).toBe("vault:telegram:acc-tg");
  });

  test("non-telegram target: no destination override, account externalId is the identity", async () => {
    const post = postWith([{
      channelAccountId: "acc-th",
      channel: "threads",
      accountExternalId: "th-user-1",
      tokenVaultRef: "vault:threads:acc-th",
    }]);
    const { ports, inputs } = capturingPorts(post);
    await processPublish(ports, { postId: "post-h" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.input.targetExternalId).toBeUndefined();
    expect(inputs[0]!.input.account.externalId).toBe("th-user-1");
  });
});
