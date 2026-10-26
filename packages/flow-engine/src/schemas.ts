import { z } from "zod";
// Subpath import: the channels root pulls node:crypto adapters into
// any bundle that touches it; the rich schema module is browser-safe,
// which is what lets the web builder validate graphs client-side.
import { richBlockSchema } from "@botara/channels/rich";

/**
 * Flow node schemas (Fase 0 set). The same Zod schemas validate flows in the
 * API, render node forms in the web builder, and drive the interpreter -
 * one definition, three consumers.
 */
const base = { id: z.string().min(1), next: z.string().min(1).nullable() };

export const triggerNodeSchema = z.object({
  ...base,
  type: z.literal("trigger"),
  trigger: z.enum(["message.received", "comment.received", "keyword", "schedule", "manual"]),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const sendMessageNodeSchema = z.object({
  ...base,
  type: z.literal("send_message"),
  text: z.string(),
  channel: z.string().optional(),
  /**
   * Optional rich block (adopted-features package): buttons / list /
   * carousel / product / catalog, rendered per channel by the adapters.
   * `text` stays the plain-text companion (fallback rendering + the
   * persisted message body derive from the block itself when present).
   */
  rich: richBlockSchema.optional(),
});

export const conditionNodeSchema = z.object({
  ...base,
  type: z.literal("condition"),
  field: z.string().min(1),
  operator: z.enum(["equals", "contains", "exists"]),
  value: z.string().optional(),
  whenTrue: z.string().min(1).nullable(),
  whenFalse: z.string().min(1).nullable(),
});

export const delayNodeSchema = z.object({
  ...base,
  type: z.literal("delay"),
  seconds: z.number().int().min(0),
});

export const webhookNodeSchema = z.object({
  ...base,
  type: z.literal("webhook"),
  url: z.string().url(),
  method: z.enum(["GET", "POST"]).default("POST"),
});

export const setFieldNodeSchema = z.object({
  ...base,
  type: z.literal("set_field"),
  field: z.string().min(1),
  value: z.string(),
});

/**
 * AI reply node (Fase 3): answer the contact with an AI-generated reply
 * grounded in the workspace knowledge base (top-3 chunks by cosine
 * similarity) plus the triggering message. `fallbackText` is sent verbatim
 * whenever AI is unconfigured or the KB has nothing relevant - flows must
 * never dead-end on AI availability.
 */
export const aiReplyNodeSchema = z.object({
  ...base,
  type: z.literal("ai_reply"),
  /** Instruction for the assistant: what to answer, tone, constraints. */
  prompt: z.string().default(""),
  /** Sent verbatim when AI/KB yield nothing. Required, never empty. */
  fallbackText: z.string().min(1),
  channel: z.string().optional(),
});

/**
 * Action steps (adoption package #3): single-next pass-through nodes
 * that MUTATE the world around the run (contact tags, conversation
 * assignment/status, sequence enrollments) instead of sending content.
 * Config is deliberately shallow: ids are validated for SHAPE here;
 * existence (sequence, assignee) is a runtime concern - a missing
 * target produces a run warning, never a save-time rejection or a
 * crashed run.
 */
export const addTagNodeSchema = z.object({
  ...base,
  type: z.literal("add_tag"),
  /** Literal tag (never interpolated - tags are data, not copy). */
  tag: z.string().min(1),
});

export const removeTagNodeSchema = z.object({
  ...base,
  type: z.literal("remove_tag"),
  tag: z.string().min(1),
});

export const assignNodeSchema = z.object({
  ...base,
  type: z.literal("assign"),
  /** Workspace member to own the conversation; null = unassign. */
  userId: z.string().min(1).nullable(),
});

export const setConversationStatusNodeSchema = z.object({
  ...base,
  type: z.literal("set_conversation_status"),
  /** "resolved" is the audit's "archive" step; "open" reopens. */
  status: z.enum(["resolved", "open"]),
});

export const sequenceSubscribeNodeSchema = z.object({
  ...base,
  type: z.literal("sequence_subscribe"),
  sequenceId: z.string().min(1),
});

export const sequenceUnsubscribeNodeSchema = z.object({
  ...base,
  type: z.literal("sequence_unsubscribe"),
  /** A sequence id, or "all" to cancel every active enrollment. */
  sequenceId: z.string().min(1),
});

/**
 * Create-deal step (adoption package #6): open a sales deal for the
 * run's contact. Pipeline/stage are optional - omitted means the
 * workspace default pipeline's first stage. `title` is interpolated
 * like send_message text; empty means the runtime default
 * "Deal for {{contact.name}}". Existence of the pipeline/stage is a
 * runtime concern (warning, never a save-time rejection), exactly like
 * the other action steps.
 */
export const createDealNodeSchema = z.object({
  ...base,
  type: z.literal("create_deal"),
  pipelineId: z.string().min(1).optional(),
  stageId: z.string().min(1).optional(),
  title: z.string().max(300).default(""),
  /** Deal value in the workspace default currency; omitted = unsized. */
  value: z.number().nonnegative().optional(),
});

/**
 * Collect-input step (adoption package #3): send a prompt, PAUSE the
 * run, and resume it with the contact's next reply stored in the run
 * variable bag (readable downstream as `{{vars.<variable>}}`). The
 * optional contact field ALSO persists the answer (readable in later
 * runs as `{{contact.<field>}}`). A timeout (when set) resumes the run
 * with an empty value instead of waiting forever. Single outgoing edge:
 * reply, timeout, and media-only replies all continue at `next`.
 */
export const collectInputNodeSchema = z.object({
  ...base,
  type: z.literal("collect_input"),
  /** The question to send (interpolated like send_message text). */
  promptText: z.string().min(1),
  /** Run-variable name the answer lands in (identifier-shaped). */
  variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  saveToContactField: z.string().min(1).optional(),
  timeoutHours: z.number().positive().max(24 * 30).optional(),
});

export const flowNodeSchema = z.discriminatedUnion("type", [
  triggerNodeSchema, sendMessageNodeSchema, conditionNodeSchema, delayNodeSchema, webhookNodeSchema,
  setFieldNodeSchema, aiReplyNodeSchema,
  addTagNodeSchema, removeTagNodeSchema, assignNodeSchema, setConversationStatusNodeSchema,
  sequenceSubscribeNodeSchema, sequenceUnsubscribeNodeSchema, collectInputNodeSchema,
  createDealNodeSchema,
]);

export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  startNodeId: z.string().min(1),
  nodes: z.array(flowNodeSchema).min(1),
});

export type Flow = z.infer<typeof flowSchema>;
