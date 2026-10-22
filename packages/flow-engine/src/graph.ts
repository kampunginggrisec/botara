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

/**
 * The first send_message node reachable by walking `next` pointers from the
 * start node (through the trigger and any pass-through nodes), or null.
 * Comment-to-DM uses this: when a comment trigger has no explicit
 * privateText, this node's text becomes the private reply and the flow run
 * resumes at `nextNodeId` so the message is not sent twice.
 */
export function firstSendMessageOf(
  graph: StoredGraph,
): { nodeId: string; text: string; nextNodeId: string | null } | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n as FlowNode]));
  const visited = new Set<string>();
  let currentId: string | null = graph.startNodeId;
  while (currentId && !visited.has(currentId) && visited.size <= graph.nodes.length) {
    visited.add(currentId);
    const node = byId.get(currentId);
    if (!node) return null;
    if (node.type === "send_message") {
      return { nodeId: node.id, text: node.text, nextNodeId: node.next };
    }
    if (node.type === "condition") return null; // branching: no linear "first" message
    currentId = (node as { next?: string | null }).next ?? null;
  }
  return null;
}
