import { z } from "zod";
import { richBlockSchema } from "@botara/channels";

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

export const flowNodeSchema = z.discriminatedUnion("type", [
  triggerNodeSchema, sendMessageNodeSchema, conditionNodeSchema, delayNodeSchema, webhookNodeSchema,
  setFieldNodeSchema, aiReplyNodeSchema,
]);

export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  startNodeId: z.string().min(1),
  nodes: z.array(flowNodeSchema).min(1),
});

export type Flow = z.infer<typeof flowSchema>;
