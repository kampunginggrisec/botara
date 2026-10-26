import { CHANNEL_CAPABILITIES, type ChannelKey } from "@botara/channels";
import { buildVariableContext, interpolate, type VariableContext } from "@botara/shared";
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
  template?: {
    name: string;
    language: string;
    latestCategory: string;
    /** Per-recipient body parameter templates (variables #1). */
    templateParams?: string[];
  };
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
  /** Variable-interpolation context (variables #1). */
  contactDisplayName?: string | null;
  contactChannel?: string;
  contactTags?: string[];
  contactCustomFields?: Record<string, unknown>;
  workspaceName?: string | null;
  channelDisplayName?: string | null;
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
    // Variable interpolation (variables #1): the step's text and its
    // template params render against the ENROLLED contact at send time;
    // unknown variables render empty (warned in the log), never raw.
    const varCtx: VariableContext = buildVariableContext({
      contact: {
        displayName: enrollment.contactDisplayName,
        externalId: enrollment.contactExternalId,
        channel: enrollment.contactChannel ?? enrollment.channel,
        tags: enrollment.contactTags,
        customFields: enrollment.contactCustomFields,
      },
      workspaceName: enrollment.workspaceName,
      channelAccount: { displayName: enrollment.channelDisplayName, channel: enrollment.channel },
    });
    const renderStep = (template: string): string => {
      const rendered = interpolate(template, varCtx);
      if (rendered.warnings.length > 0) {
        console.warn(
          `[worker] sequence ${enrollment.sequenceId} enrollment ${enrollment.enrollmentId}: unknown variables rendered empty (${rendered.warnings.map((w) => w.path).join(", ")})`,
        );
      }
      return rendered.text;
    };
    let template: SendMessageJobData["template"];
    if (step.template) {
      const { templateParams, ...templateCore } = step.template;
      template = templateParams && templateParams.length > 0
        ? {
            ...templateCore,
            components: [{
              type: "body",
              parameters: templateParams.map((p) => ({ type: "text", text: renderStep(p) })),
            }],
          }
        : templateCore;
    }
    await ports.enqueueSendMessage({
      workspaceId: enrollment.workspaceId,
      channelAccountId: enrollment.channelAccountId,
      channel: enrollment.channel,
      accountExternalId: enrollment.accountExternalId,
      tokenVaultRef: enrollment.tokenVaultRef,
      toExternalId: enrollment.contactExternalId,
      text: step.text !== undefined ? renderStep(step.text) : undefined,
      template,
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
