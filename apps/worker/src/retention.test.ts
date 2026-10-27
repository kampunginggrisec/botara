import { describe, expect, test } from "bun:test";
import { DISCONNECT_RETENTION_DAYS, WEBHOOK_RECEIPT_RETENTION_DAYS } from "@botara/shared";
import {
  processRetentionScan, processWebhookReceiptRetention,
  type RetentionPorts, type WebhookReceiptRetentionPorts,
} from "./retention";

/**
 * Item G: the worker retention processor computes the cutoff from the
 * shared policy (now - DISCONNECT_RETENTION_DAYS) and delegates the
 * purge to the repository port. Scheduling (BullMQ job scheduler
 * "retention-daily", 03:30) lives in the worker wiring; the processor
 * itself is time-injected so tests never wait on a clock.
 */
describe("processRetentionScan (item G)", () => {
  test("passes now - 30d as the cutoff and reports the purge count", async () => {
    const now = new Date("2026-10-26T03:30:00.000Z");
    let seenCutoff: Date | null = null;
    const ports: RetentionPorts = {
      async purgeExpired(cutoff) {
        seenCutoff = cutoff;
        return [{ id: "acc-1" }, { id: "acc-2" }];
      },
    };
    const res = await processRetentionScan(ports, now);
    expect(res).toEqual({ purged: 2 });
    expect(seenCutoff).not.toBeNull();
    expect(now.getTime() - seenCutoff!.getTime()).toBe(DISCONNECT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  });

  test("nothing expired -> purged 0", async () => {
    const ports: RetentionPorts = { async purgeExpired() { return []; } };
    expect(await processRetentionScan(ports, new Date())).toEqual({ purged: 0 });
  });
});

describe("processWebhookReceiptRetention (Admin webhook log)", () => {
  test("passes now - 7d as the cutoff and reports the deleted count", async () => {
    const now = new Date("2026-10-27T03:30:00.000Z");
    let seenCutoff: Date | null = null;
    const ports: WebhookReceiptRetentionPorts = {
      async deleteExpiredReceipts(cutoff) {
        seenCutoff = cutoff;
        return 42;
      },
    };
    const res = await processWebhookReceiptRetention(ports, now);
    expect(res).toEqual({ deleted: 42 });
    expect(seenCutoff).not.toBeNull();
    expect(now.getTime() - seenCutoff!.getTime())
      .toBe(WEBHOOK_RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  });

  test("nothing expired -> deleted 0", async () => {
    const ports: WebhookReceiptRetentionPorts = { async deleteExpiredReceipts() { return 0; } };
    expect(await processWebhookReceiptRetention(ports, new Date())).toEqual({ deleted: 0 });
  });
});
