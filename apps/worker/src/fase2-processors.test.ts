import { describe, expect, test } from "bun:test";
import {
  processTokenRefreshAccount, processTokenRefreshScan, tokenRefreshJobId,
  type DueTokenAccount, type TokenRefreshPorts,
} from "./token-refresh";
import {
  processPublish, processPublishScan,
  type PublishPorts, type PublishTargetResult, type ScheduledPostSnapshot,
} from "./publish";
import {
  processSequenceAdvance, type DueEnrollment, type SequencePorts,
} from "./sequences";
import { processEmailInbound, type EmailInboundPorts } from "./email-inbound";

// ------------------------------------------------------------ token refresh

function fakeTokenPorts(overrides: Partial<TokenRefreshPorts> = {}) {
  const enqueued: string[] = [];
  const persisted: Array<{ id: string; patch: { tokenExpiresAt?: string; status?: string } }> = [];
  const alerts: Array<{ accountId: string; channel: string; error: string }> = [];
  const account: DueTokenAccount = {
    id: "acc-1", workspaceId: "ws-1", channel: "threads", externalId: "th-1",
    tokenExpiresAt: "2026-11-01T00:00:00.000Z",
  };
  const ports: TokenRefreshPorts = {
    async listDueAccounts() { return [account]; },
    async enqueueRefresh(id) { enqueued.push(id); },
    async loadAccount() { return account; },
    async refresh() { return { refreshed: true, expiresAt: "2026-12-21T00:00:00.000Z" }; },
    async persistRefresh(id, patch) { persisted.push({ id, patch }); },
    async alert(entry) { alerts.push(entry); },
    ...overrides,
  };
  return { ports, enqueued, persisted, alerts, account };
}

describe("token-refresh processors (fake ports)", () => {
  test("jobId is per account+day and BullMQ-safe (no colons)", () => {
    expect(tokenRefreshJobId("acc-1", new Date("2026-10-22T15:00:00Z"))).toBe("token-refresh_acc-1_2026-10-22");
  });

  test("scan enqueues one refresh per due account", async () => {
    const f = fakeTokenPorts();
    const res = await processTokenRefreshScan(f.ports, new Date());
    expect(res.enqueued).toBe(1);
    expect(f.enqueued).toEqual(["acc-1"]);
  });

  test("account refresh persists the new expiry + connected status", async () => {
    const f = fakeTokenPorts();
    const res = await processTokenRefreshAccount(f.ports, { accountId: "acc-1" });
    expect(res.refreshed).toBe(true);
    expect(f.persisted).toEqual([{
      id: "acc-1",
      patch: { tokenExpiresAt: "2026-12-21T00:00:00.000Z", status: "connected" },
    }]);
    expect(f.alerts).toHaveLength(0);
  });

  test("adapter saying not-refreshed (outside window) persists nothing", async () => {
    const f = fakeTokenPorts({ async refresh() { return { refreshed: false }; } });
    const res = await processTokenRefreshAccount(f.ports, { accountId: "acc-1" });
    expect(res.refreshed).toBe(false);
    expect(f.persisted).toHaveLength(0);
  });

  test("refresh failure marks refresh_failed, alerts, and rethrows", async () => {
    const f = fakeTokenPorts({
      async refresh() { throw new Error("token expired - re-auth required"); },
    });
    await expect(processTokenRefreshAccount(f.ports, { accountId: "acc-1" }))
      .rejects.toThrow("re-auth required");
    expect(f.persisted).toEqual([{ id: "acc-1", patch: { status: "refresh_failed" } }]);
    expect(f.alerts).toEqual([{
      accountId: "acc-1", channel: "threads", error: "token expired - re-auth required",
    }]);
  });
});

// ------------------------------------------------------------------ publish

function fakePublishPorts(overrides: Partial<PublishPorts> = {}) {
  const post: ScheduledPostSnapshot = {
    id: "post-1", workspaceId: "ws-1", text: "promo", mediaUrls: ["https://media.example.com/a.jpg"],
    targets: [
      { channelAccountId: "ig-1", channel: "instagram", accountExternalId: "ig-user" },
      { channelAccountId: "th-1", channel: "threads", accountExternalId: "th-user" },
    ],
    status: "publishing",
    results: {},
  };
  const recorded: Array<{ id: string; results: Record<string, PublishTargetResult> }> = [];
  const statuses: Array<{ id: string; status: string }> = [];
  const enqueuedPosts: string[] = [];
  const ports: PublishPorts = {
    async loadPost() { return post; },
    async publish(channel) { return { externalPostId: `ext-${channel}` }; },
    async recordResults(id, results) { recorded.push({ id, results }); },
    async updatePostStatus(id, status) { statuses.push({ id, status }); },
    async listDuePosts() { return [{ id: "post-1" }]; },
    async enqueuePublish(id) { enqueuedPosts.push(id); },
    ...overrides,
  };
  return { ports, post, recorded, statuses, enqueuedPosts };
}

describe("publish processors (fake ports)", () => {
  test("publishes to every target and records per-target results", async () => {
    const f = fakePublishPorts();
    const res = await processPublish(f.ports, { postId: "post-1" });
    expect(res).toEqual({ status: "published", sent: 2, failed: 0 });
    expect(f.recorded[0]!.results).toEqual({
      "ig-1": { status: "sent", externalPostId: "ext-instagram" },
      "th-1": { status: "sent", externalPostId: "ext-threads" },
    });
    expect(f.statuses).toEqual([{ id: "post-1", status: "published" }]);
  });

  test("partial failure: one target failing does NOT fail the others", async () => {
    const f = fakePublishPorts({
      async publish(channel) {
        if (channel === "threads") throw new Error("threads quota exceeded");
        return { externalPostId: "ext-instagram" };
      },
    });
    const res = await processPublish(f.ports, { postId: "post-1" });
    expect(res).toEqual({ status: "partial", sent: 1, failed: 1 });
    expect(f.recorded[0]!.results["ig-1"]).toMatchObject({ status: "sent" });
    expect(f.recorded[0]!.results["th-1"]).toMatchObject({ status: "failed", error: "threads quota exceeded" });
    expect(f.statuses).toEqual([{ id: "post-1", status: "partial" }]);
  });

  test("all targets failing -> post failed; re-run skips already-sent targets", async () => {
    const fail = fakePublishPorts({
      async publish() { throw new Error("down"); },
    });
    expect(await processPublish(fail.ports, { postId: "post-1" })).toEqual({ status: "failed", sent: 0, failed: 2 });

    let publishCalls = 0;
    const rerun = fakePublishPorts({
      async loadPost() {
        return {
          ...fail.post,
          status: "partial",
          results: { "ig-1": { status: "sent", externalPostId: "ext-instagram" } },
        };
      },
      async publish() { publishCalls++; return { externalPostId: "ext-threads" }; },
    });
    const res = await processPublish(rerun.ports, { postId: "post-1" });
    expect(publishCalls).toBe(1); // instagram target was already sent - skipped
    expect(res.status).toBe("published");
  });

  test("scan enqueues due posts", async () => {
    const f = fakePublishPorts();
    expect(await processPublishScan(f.ports, new Date())).toEqual({ enqueued: 1 });
    expect(f.enqueuedPosts).toEqual(["post-1"]);
  });
});

// ---------------------------------------------------------------- sequences

function fakeSequencePorts(overrides: Partial<SequencePorts> = {}) {
  const sent: Array<{ idempotencyKey: string; text?: string }> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const enrollment: DueEnrollment = {
    enrollmentId: "enr-1", sequenceId: "seq-1", workspaceId: "ws-1",
    currentStep: 0,
    steps: [
      { delaySeconds: 0, text: "Selamat datang!" },
      { delaySeconds: 3600, text: "Sudah coba fitur X?" },
    ],
    contactId: "c-1", contactExternalId: "628111",
    channelAccountId: "acc-1", channel: "whatsapp", accountExternalId: "62812",
  };
  const ports: SequencePorts = {
    async listDueEnrollments() { return [enrollment]; },
    async enqueueSendMessage(data) { sent.push({ idempotencyKey: data.idempotencyKey, text: data.text }); },
    async updateEnrollment(id, patch) { updates.push({ id, patch }); },
    ...overrides,
  };
  return { ports, sent, updates, enrollment };
}

describe("sequence processor (fake ports)", () => {
  const now = new Date("2026-10-22T00:00:00Z");

  test("sends the due step with a stable key and schedules the next step by its delay", async () => {
    const f = fakeSequencePorts();
    const res = await processSequenceAdvance(f.ports, { now });
    expect(res).toEqual({ advanced: 1, completed: 0 });
    expect(f.sent).toEqual([{ idempotencyKey: "seq:enr-1:0", text: "Selamat datang!" }]);
    expect(f.updates).toEqual([{
      id: "enr-1",
      patch: {
        currentStep: 1,
        lastStepAt: now,
        nextStepAt: new Date(now.getTime() + 3600 * 1000),
      },
    }]);
  });

  test("the final step completes the enrollment", async () => {
    const f = fakeSequencePorts({
      async listDueEnrollments() {
        return [{ ...fakeSequencePorts().enrollment, currentStep: 1 }];
      },
    });
    const res = await processSequenceAdvance(f.ports, { now });
    expect(res.completed).toBe(1);
    expect(f.sent[0]).toEqual({ idempotencyKey: "seq:enr-1:1", text: "Sudah coba fitur X?" });
    expect(f.updates[0]!.patch).toMatchObject({ status: "completed", nextStepAt: null, currentStep: 2 });
  });

  test("an enrollment past its steps is closed without sending", async () => {
    const f = fakeSequencePorts({
      async listDueEnrollments() {
        return [{ ...fakeSequencePorts().enrollment, currentStep: 5 }];
      },
    });
    const res = await processSequenceAdvance(f.ports, { now });
    expect(res.completed).toBe(1);
    expect(f.sent).toHaveLength(0);
  });
});

// ------------------------------------------------------------- email inbound

describe("email-inbound processor (fake ports)", () => {
  test("fetches content, copies attachments to R2 keys, and persists into the conversation", async () => {
    const storedFor: string[] = [];
    let persisted: Parameters<EmailInboundPorts["persistMessage"]>[0] | null = null;
    const published: Array<{ workspaceId: string; conversationId: string; direction: "in" | "out"; messageId?: string }> = [];
    const ports: EmailInboundPorts = {
      async fetchInbound() {
        return {
          from: "pelanggan@mail.com",
          subject: "Tanya harga",
          text: "Berapa harganya?",
          attachments: [{ id: "att-1", filename: "foto.jpg", contentType: "image/jpeg", downloadUrl: "https://tmp.example.com/foto.jpg" }],
        };
      },
      async storeAttachment(input) {
        storedFor.push(input.attachment.id);
        return { key: `email/${input.workspaceId}/${input.emailId}/foto.jpg`, publicUrl: "https://media.example.com/foto.jpg" };
      },
      async findOrCreateConversation() { return { conversationId: "conv-1", contactId: "c-1" }; },
      async persistMessage(input) { persisted = input; return { id: "msg-1" }; },
      async touchLastUserMessage() {},
      async publishInboxMessage(event) { published.push(event); },
    };
    const res = await processEmailInbound(ports, { workspaceId: "ws-1", channelAccountId: "acc-1", emailId: "in-1" });
    expect(res.attachmentsStored).toBe(1);
    expect(storedFor).toEqual(["att-1"]);
    expect(persisted).toMatchObject({
      conversationId: "conv-1",
      externalId: "in-1",
      subject: "Tanya harga",
      body: "Berapa harganya?",
      attachments: [{ key: "email/ws-1/in-1/foto.jpg", filename: "foto.jpg" }],
    });
    // Live inbox: exactly one inbox.message event for the persisted message.
    expect(published).toEqual([
      { workspaceId: "ws-1", conversationId: "conv-1", direction: "in", messageId: "msg-1" },
    ]);
  });

  test("still persists the message when the publisher is missing or throws (fire-and-forget)", async () => {
    let persisted: Parameters<EmailInboundPorts["persistMessage"]>[0] | null = null;
    const noPublisher: EmailInboundPorts = {
      async fetchInbound() {
        return { from: "pelanggan@mail.com", attachments: [] };
      },
      async storeAttachment(input) { return { key: `email/${input.workspaceId}/${input.emailId}/x` }; },
      async findOrCreateConversation() { return { conversationId: "conv-2", contactId: "c-2" }; },
      async persistMessage(input) { persisted = input; return { id: "msg-2" }; },
      async touchLastUserMessage() {},
    };
    await expect(processEmailInbound(noPublisher, { workspaceId: "ws-1", channelAccountId: "acc-1", emailId: "in-2" }))
      .resolves.toMatchObject({ attachmentsStored: 0 });
    expect(persisted).not.toBeNull();
    expect(persisted!.conversationId).toBe("conv-2");

    const throwingPublisher: EmailInboundPorts = {
      ...noPublisher,
      async persistMessage(input) { persisted = input; return { id: "msg-3" }; },
      async publishInboxMessage() { throw new Error("redis down"); },
    };
    await expect(processEmailInbound(throwingPublisher, { workspaceId: "ws-1", channelAccountId: "acc-1", emailId: "in-3" }))
      .resolves.toMatchObject({ attachmentsStored: 0 });
    expect(persisted!.externalId).toBe("in-3");
  });
});
