import { CHANNEL_CAPABILITIES, type ChannelKey } from "@botara/channels";
import type { SendMessageJobData } from "./processors";

/**
 * Sequence (drip) processor (Fase 2).
 *
 * A sequence is an ordered list of steps; each enrollment tracks the NEXT
 * step index and when it is due. This processor runs as a periodic scan
 * job on the "sequence" queue: for every due enrollment it enqueues the
 * step's send on the send-message queue (stable idempotency key
 * `seq:{enrollmentId}:{stepIndex}` - a re-run can never double-send a step)
 * and advances the enrollment: next step's delay counts from now, and after
 * the final step the enrollment is completed.
 */

export interface SequenceStepSnapshot {
  delaySeconds: number;
  text?: string;
  template?: { name: string; language: string; latestCategory: string };
}

export interface DueEnrollment {
  enrollmentId: string;
  sequenceId: string;
  workspaceId: string;
  currentStep: number;
  steps: SequenceStepSnapshot[];
  contactId: string;
  contactExternalId: string;
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  tokenVaultRef?: string;
}

export interface SequencePorts {
  listDueEnrollments(now: Date): Promise<DueEnrollment[]>;
  enqueueSendMessage(data: SendMessageJobData): Promise<void>;
  updateEnrollment(
    enrollmentId: string,
    patch: { currentStep?: number; status?: string; nextStepAt?: Date | null; lastStepAt?: Date },
  ): Promise<void>;
}

export async function processSequenceAdvance(
  ports: SequencePorts,
  input: { now: Date },
): Promise<{ advanced: number; completed: number }> {
  const due = await ports.listDueEnrollments(input.now);
  let completed = 0;
  let advanced = 0;
  for (const enrollment of due) {
    // Reactive-only channels (TikTok) can never run sequences: a
    // sequence initiates contact on a schedule, which the provider
    // forbids. The API create route rejects these up front; this gate
    // is the backstop for rows that predate it - the enrollment fails
    // terminally (typed in the status) instead of enqueueing sends
    // that would fail one by one in the send processor.
    const caps = CHANNEL_CAPABILITIES[enrollment.channel as ChannelKey];
    if (caps && caps.canInitiate === false) {
      await ports.updateEnrollment(enrollment.enrollmentId, { status: "failed", nextStepAt: null });
      continue;
    }
    const step = enrollment.steps[enrollment.currentStep];
    if (!step) {
      // Nothing left to send (steps were edited shorter): close it out.
      await ports.updateEnrollment(enrollment.enrollmentId, { status: "completed", nextStepAt: null });
      completed++;
      continue;
    }
    advanced++;
    await ports.enqueueSendMessage({
      workspaceId: enrollment.workspaceId,
      channelAccountId: enrollment.channelAccountId,
      channel: enrollment.channel,
      accountExternalId: enrollment.accountExternalId,
      tokenVaultRef: enrollment.tokenVaultRef,
      toExternalId: enrollment.contactExternalId,
      text: step.text,
      template: step.template,
      idempotencyKey: `seq:${enrollment.enrollmentId}:${enrollment.currentStep}`,
    });
    const nextIndex = enrollment.currentStep + 1;
    if (nextIndex >= enrollment.steps.length) {
      await ports.updateEnrollment(enrollment.enrollmentId, {
        currentStep: nextIndex,
        status: "completed",
        nextStepAt: null,
        lastStepAt: input.now,
      });
      completed++;
    } else {
      await ports.updateEnrollment(enrollment.enrollmentId, {
        currentStep: nextIndex,
        lastStepAt: input.now,
        nextStepAt: new Date(input.now.getTime() + enrollment.steps[nextIndex]!.delaySeconds * 1000),
      });
    }
  }
  return { advanced, completed };
}
