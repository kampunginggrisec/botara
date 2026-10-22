import { z } from "zod";
import { flowNodeSchema, type Flow, type FlowNode } from "./schemas";

/**
 * Stored flow graph (Fase 4) - the visual builder's document format.
 *
 * The graph is what apps/api persists (flows.graph jsonb) and what the web
 * builder edits: engine nodes (validated by the Fase 0 node schemas) plus a
 * builder-only `position`, and edges for rendering. Execution does NOT walk
 * edges: the runnable Flow uses each node's `next` / `whenTrue` /
 * `whenFalse` pointers exactly like the Fase 0 interpreter expects. The
 * builder keeps those pointers in sync with its edges on save.
 */

const positionSchema = z.object({ x: z.number(), y: z.number() });

const storedNodeSchema = z.intersection(
  flowNodeSchema,
  z.object({ position: positionSchema.optional() }),
);

export const flowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  /** Condition nodes branch through "true" / "false" handles. */
  sourceHandle: z.string().nullable().optional(),
});

export const storedGraphSchema = z.object({
  startNodeId: z.string().min(1),
  nodes: z.array(storedNodeSchema).min(1),
  edges: z.array(flowEdgeSchema),
});

export type StoredGraph = z.infer<typeof storedGraphSchema>;
export type StoredNode = z.infer<typeof storedNodeSchema>;
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

/** Strip builder-only fields, producing the runnable engine Flow. */
export function toRunnableFlow(flowId: string, graph: StoredGraph): Flow {
  const nodes: FlowNode[] = graph.nodes.map((node) => {
    const { position: _position, ...engineNode } = node as StoredNode & { position?: unknown };
    return engineNode as FlowNode;
  });
  return { id: flowId, version: 1, startNodeId: graph.startNodeId, nodes };
}

/** The graph's trigger node, if it has one (builders always include it). */
export function triggerNodeOf(graph: StoredGraph): Extract<FlowNode, { type: "trigger" }> | undefined {
  return graph.nodes.find(
    (n): n is Extract<FlowNode, { type: "trigger" }> => (n as FlowNode).type === "trigger",
  ) as Extract<FlowNode, { type: "trigger" }> | undefined;
}
