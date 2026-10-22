import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position,
  addEdge, useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, ApiError, type ChannelAccount, type Flow, type FlowGraph, type FlowTrigger } from "../api";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";

/**
 * Visual flow builder (Fase 4) on @xyflow/react.
 *
 * The persisted document is the API's graph format: engine nodes (each may
 * carry a builder `position`) + edges. On save, each node's `next` /
 * `whenTrue` / `whenFalse` pointers are derived from the canvas edges, so
 * the stored graph is directly runnable by the flow engine. The flow-level
 * trigger (what the webhook dispatcher matches) is derived from the
 * trigger node, keeping both views of the trigger in sync by construction.
 */

type EngineNode = Record<string, unknown> & { id: string; type: string };
type BuilderNode = Node<{ engine: EngineNode }, "botara">;

const NODE_TYPES = ["trigger", "send_message", "condition", "delay", "webhook", "set_field", "ai_reply"] as const;
type NodeType = (typeof NODE_TYPES)[number];

const NODE_ACCENT: Record<NodeType, string> = {
  trigger: "bg-amber-500",
  send_message: "bg-sky-500",
  condition: "bg-violet-500",
  delay: "bg-slate-500",
  webhook: "bg-emerald-500",
  set_field: "bg-teal-500",
  ai_reply: "bg-fuchsia-500",
};

let nodeSeq = 0;
function newNodeId(type: NodeType): string {
  nodeSeq += 1;
  return `${type.slice(0, 4)}_${Date.now().toString(36)}${nodeSeq}`;
}

function defaultEngineNode(type: NodeType, id: string): EngineNode {
  switch (type) {
    case "trigger":
      return { id, type, trigger: "keyword", config: { flowTriggerType: "keyword", keyword: "", match: "contains" }, next: null };
    case "send_message":
      return { id, type, text: "", next: null };
    case "condition":
      return { id, type, field: "", operator: "equals", value: "", whenTrue: null, whenFalse: null, next: null };
    case "delay":
      return { id, type, seconds: 60, next: null };
    case "webhook":
      return { id, type, url: "https://", method: "POST", next: null };
    case "set_field":
      return { id, type, field: "", value: "", next: null };
    case "ai_reply":
      return { id, type, prompt: "", fallbackText: "", next: null };
  }
}

const str = (node: EngineNode, key: string): string =>
  typeof node[key] === "string" ? (node[key] as string) : "";
const cfg = (node: EngineNode): Record<string, unknown> =>
  (node.config && typeof node.config === "object" ? (node.config as Record<string, unknown>) : {});
const cfgStr = (node: EngineNode, key: string): string => {
  const v = cfg(node)[key];
  return typeof v === "string" ? v : "";
};

function nodeSummary(node: EngineNode): string {
  switch (node.type) {
    case "trigger": {
      const kind = cfgStr(node, "flowTriggerType") || (node.trigger === "keyword" ? "keyword" : "manual");
      if (kind === "keyword") return `"${cfgStr(node, "keyword")}"`;
      if (kind === "postback") return `payload: ${cfgStr(node, "payload")}`;
      return "manual";
    }
    case "send_message": return str(node, "text").slice(0, 60) || "...";
    case "condition": return `${str(node, "field")} ${str(node, "operator")} ${str(node, "value")}`.trim();
    case "delay": return `${String(node.seconds ?? 0)}s`;
    case "webhook": return str(node, "url").slice(0, 40);
    case "set_field": return `${str(node, "field")} = ${str(node, "value")}`;
    case "ai_reply": return str(node, "prompt").slice(0, 50) || "KB-grounded reply";
    default: return "";
  }
}

function BotaraNodeCard({ data, selected }: NodeProps<BuilderNode>) {
  const { t } = useI18n();
  const engine = data.engine;
  const type = engine.type as NodeType;
  return (
    <div
      className={`w-56 rounded-lg border bg-white shadow-sm dark:bg-slate-900 ${
        selected ? "border-slate-900 ring-2 ring-slate-400 dark:border-slate-100 dark:ring-slate-600" : "border-slate-300 dark:border-slate-700"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <span className={`h-2.5 w-2.5 rounded-full ${NODE_ACCENT[type] ?? "bg-slate-400"}`} />
        <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
          {t(`flows.node.${type}` as never)}
        </span>
      </div>
      <div className="px-3 py-2 text-xs text-slate-500 break-words dark:text-slate-400">{nodeSummary(engine)}</div>
      {type === "condition" ? (
        <>
          <Handle type="source" position={Position.Bottom} id="true" style={{ left: "30%" }} className="!bg-emerald-500" />
          <Handle type="source" position={Position.Bottom} id="false" style={{ left: "70%" }} className="!bg-red-500" />
          <div className="flex justify-between px-4 pb-1 text-[10px] text-slate-400">
            <span>true</span><span>false</span>
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
      )}
    </div>
  );
}

const nodeTypes = { botara: BotaraNodeCard };

function graphToNodes(graph: FlowGraph): BuilderNode[] {
  return graph.nodes.map((raw, i) => {
    const { position, ...engine } = raw as Record<string, unknown>;
    const pos = (position as { x?: number; y?: number } | undefined) ?? { x: 80 + (i % 3) * 260, y: 60 + Math.floor(i / 3) * 170 };
    return {
      id: String(engine.id),
      type: "botara" as const,
      position: { x: pos.x ?? 80, y: pos.y ?? 60 },
      data: { engine: engine as EngineNode },
    };
  });
}

function graphToEdges(graph: FlowGraph): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
  }));
}

/** Derive the stored graph: engine pointers come from the canvas edges. */
function buildGraph(nodes: BuilderNode[], edges: Edge[]): FlowGraph {
  const nextOf = (id: string, handle?: string): string | null => {
    const edge = edges.find((e) => e.source === id && (handle === undefined
      ? (!e.sourceHandle || e.sourceHandle === "")
      : e.sourceHandle === handle));
    return edge ? edge.target : null;
  };
  const storedNodes = nodes.map((n) => {
    const engine = { ...n.data.engine };
    if (engine.type === "condition") {
      engine.whenTrue = nextOf(n.id, "true");
      engine.whenFalse = nextOf(n.id, "false");
      engine.next = null;
    } else {
      engine.next = nextOf(n.id);
    }
    return { ...engine, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } };
  });
  const triggerNode = storedNodes.find((n) => n.type === "trigger");
  const first = storedNodes[0];
  return {
    startNodeId: (triggerNode?.id as string) ?? (first?.id as string) ?? "",
    nodes: storedNodes as Array<Record<string, unknown>>,
    edges: edges.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    })),
  };
}

/** The flow-level trigger (dispatcher view) derived from the trigger node. */
function deriveTrigger(graph: FlowGraph): FlowTrigger {
  const triggerNode = graph.nodes.find((n) => n.type === "trigger") as EngineNode | undefined;
  if (!triggerNode) return { type: "manual", config: {} };
  const config = cfg(triggerNode);
  const kind = (config.flowTriggerType as string) || (triggerNode.trigger === "keyword" ? "keyword" : "manual");
  if (kind === "keyword") {
    return { type: "keyword", config: { keyword: String(config.keyword ?? ""), match: config.match === "equals" ? "equals" : "contains" } };
  }
  if (kind === "postback") {
    return { type: "postback", config: { payload: String(config.payload ?? ""), match: "equals" } };
  }
  return { type: "manual", config: {} };
}

interface BuilderProps {
  flow: Flow;
  accounts: ChannelAccount[];
  onBack: () => void;
  onChanged: (flow: Flow) => void;
}

function BuilderInner({ flow, accounts, onBack, onChanged }: BuilderProps) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const [name, setName] = useState(flow.name);
  const [nodes, setNodes, onNodesChange] = useNodesState<BuilderNode>(graphToNodes(flow.graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphToEdges(flow.graph));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testText, setTestText] = useState("");
  const [testActions, setTestActions] = useState<Array<Record<string, unknown>> | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId)?.data.engine ?? null,
    [nodes, selectedId],
  );

  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge(connection, eds));
  }, [setEdges]);

  const addNode = (type: NodeType) => {
    const id = newNodeId(type);
    const engine = defaultEngineNode(type, id);
    const node: BuilderNode = {
      id,
      type: "botara",
      position: { x: 120 + (nodes.length % 4) * 90, y: 100 + (nodes.length % 5) * 70 },
      data: { engine },
    };
    setNodes((prev) => [...prev, node]);
    setSelectedId(id);
  };

  const patchSelected = (patch: Record<string, unknown>) => {
    if (!selectedId) return;
    setNodes((prev) => prev.map((n) => (n.id === selectedId
      ? { ...n, data: { engine: { ...n.data.engine, ...patch } } }
      : n)));
  };

  const patchSelectedConfig = (patch: Record<string, unknown>) => {
    if (!selected) return;
    patchSelected({ config: { ...cfg(selected), ...patch } });
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes((prev) => prev.filter((n) => n.id !== selectedId));
    setEdges((prev) => prev.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  };

  const save = async (): Promise<Flow | null> => {
    setBusy(true);
    setError(null);
    try {
      const graph = buildGraph(nodes, edges);
      const res = await api.updateFlow(flow.id, { name: name.trim() || flow.name, trigger: deriveTrigger(graph), graph });
      onChanged(res.flow);
      setNotice(t("flows.saved"));
      return res.flow;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("flows.saveFailed"));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      const res = saved.status === "active" ? await api.deactivateFlow(flow.id) : await api.activateFlow(flow.id);
      onChanged(res.flow);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("flows.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    setTestActions(null);
    try {
      const res = await api.testRunFlow(flow.id, { text: testText });
      setTestActions(res.actions);
      setTestStatus(res.status);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("flows.builder.testFailed"));
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";
  const labelCls = "block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1";

  return (
    <div>
      <button onClick={onBack} className="text-sm text-slate-500 underline dark:text-slate-400">{t("flows.builder.back")}</button>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-lg font-semibold dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <span className={`text-xs px-2 py-0.5 rounded-full ${flow.status === "active" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
          {flow.status === "active" ? t("flows.statusActive") : t("flows.statusDraft")}
        </span>
        <div className="ml-auto flex gap-2">
          <button onClick={() => void toggleActive()} disabled={busy} className="rounded-md border border-slate-900 px-4 py-2 text-sm text-slate-900 disabled:opacity-50 dark:border-slate-100 dark:text-slate-100">
            {flow.status === "active" ? t("flows.deactivate") : t("flows.activate")}
          </button>
          <button onClick={() => void save()} disabled={busy} className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            {t("flows.builder.save")}
          </button>
        </div>
      </div>
      {error && <div className="mt-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</div>}
      {notice && <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{notice}</div>}

      <div className="mt-4 flex flex-wrap gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400 self-center">{t("flows.builder.palette")}:</span>
        {NODE_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => addNode(type)}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <span className={`h-2 w-2 rounded-full ${NODE_ACCENT[type]}`} />
            {t(`flows.node.${type}` as never)}
          </button>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 h-[560px] rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            colorMode={theme}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t("flows.builder.config")}</div>
            {!selected ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t("flows.builder.selectNode")}</p>
            ) : (
              <div className="mt-3 space-y-3">
                {selected.type === "trigger" && (
                  <>
                    <div>
                      <label className={labelCls}>{t("flows.field.triggerKind")}</label>
                      <select
                        value={cfgStr(selected, "flowTriggerType") || "keyword"}
                        onChange={(e) => {
                          const kind = e.target.value;
                          patchSelected({
                            trigger: kind === "keyword" ? "keyword" : kind === "postback" ? "message.received" : "manual",
                          });
                          patchSelectedConfig({ flowTriggerType: kind });
                        }}
                        className={inputCls}
                      >
                        <option value="keyword">keyword</option>
                        <option value="postback">postback</option>
                        <option value="manual">manual</option>
                      </select>
                    </div>
                    {(cfgStr(selected, "flowTriggerType") || "keyword") === "keyword" && (
                      <>
                        <div>
                          <label className={labelCls}>{t("flows.field.keyword")}</label>
                          <input value={cfgStr(selected, "keyword")} onChange={(e) => patchSelectedConfig({ keyword: e.target.value })} className={inputCls} />
                        </div>
                        <div>
                          <label className={labelCls}>{t("flows.field.match")}</label>
                          <select value={cfgStr(selected, "match") || "contains"} onChange={(e) => patchSelectedConfig({ match: e.target.value })} className={inputCls}>
                            <option value="contains">{t("flows.field.matchContains")}</option>
                            <option value="equals">{t("flows.field.matchEquals")}</option>
                          </select>
                        </div>
                      </>
                    )}
                    {cfgStr(selected, "flowTriggerType") === "postback" && (
                      <div>
                        <label className={labelCls}>{t("flows.field.payload")}</label>
                        <input value={cfgStr(selected, "payload")} onChange={(e) => patchSelectedConfig({ payload: e.target.value })} className={inputCls} />
                      </div>
                    )}
                  </>
                )}
                {selected.type === "send_message" && (
                  <>
                    <div>
                      <label className={labelCls}>{t("flows.field.text")}</label>
                      <textarea value={str(selected, "text")} onChange={(e) => patchSelected({ text: e.target.value })} rows={3} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>{t("flows.field.channelAccount")}</label>
                      <select
                        value={str(selected, "channel")}
                        onChange={(e) => patchSelected({ channel: e.target.value || undefined })}
                        className={inputCls}
                      >
                        <option value="">{t("flows.field.channelAny")}</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.channel}>{a.channel} - {a.displayName ?? a.externalId}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
                {selected.type === "condition" && (
                  <>
                    <div>
                      <label className={labelCls}>{t("flows.field.conditionField")}</label>
                      <input value={str(selected, "field")} onChange={(e) => patchSelected({ field: e.target.value })} className={inputCls} placeholder="city / messageText / tier" />
                    </div>
                    <div>
                      <label className={labelCls}>{t("flows.field.operator")}</label>
                      <select value={str(selected, "operator") || "equals"} onChange={(e) => patchSelected({ operator: e.target.value })} className={inputCls}>
                        <option value="equals">{t("flows.field.opEquals")}</option>
                        <option value="contains">{t("flows.field.opContains")}</option>
                        <option value="exists">{t("flows.field.opExists")}</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>{t("flows.field.value")}</label>
                      <input value={str(selected, "value")} onChange={(e) => patchSelected({ value: e.target.value })} className={inputCls} />
                    </div>
                  </>
                )}
                {selected.type === "delay" && (
                  <div>
                    <label className={labelCls}>{t("flows.field.seconds")}</label>
                    <input type="number" min={0} value={String(selected.seconds ?? 0)} onChange={(e) => patchSelected({ seconds: Number(e.target.value) })} className={inputCls} />
                  </div>
                )}
                {selected.type === "webhook" && (
                  <>
                    <div>
                      <label className={labelCls}>{t("flows.field.url")}</label>
                      <input value={str(selected, "url")} onChange={(e) => patchSelected({ url: e.target.value })} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>{t("flows.field.method")}</label>
                      <select value={str(selected, "method") || "POST"} onChange={(e) => patchSelected({ method: e.target.value })} className={inputCls}>
                        <option value="POST">POST</option>
                        <option value="GET">GET</option>
                      </select>
                    </div>
                  </>
                )}
                {selected.type === "set_field" && (
                  <>
                    <div>
                      <label className={labelCls}>{t("flows.field.fieldName")}</label>
                      <input value={str(selected, "field")} onChange={(e) => patchSelected({ field: e.target.value })} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>{t("flows.field.fieldValue")}</label>
                      <input value={str(selected, "value")} onChange={(e) => patchSelected({ value: e.target.value })} className={inputCls} />
                    </div>
                  </>
                )}
                {selected.type === "ai_reply" && (
                  <>
                    <div>
                      <label className={labelCls}>{t("flows.field.prompt")}</label>
                      <textarea value={str(selected, "prompt")} onChange={(e) => patchSelected({ prompt: e.target.value })} rows={2} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>{t("flows.field.fallback")}</label>
                      <textarea value={str(selected, "fallbackText")} onChange={(e) => patchSelected({ fallbackText: e.target.value })} rows={2} className={inputCls} />
                    </div>
                  </>
                )}
                <button onClick={deleteSelected} className="text-xs text-red-600 underline dark:text-red-400">
                  {t("flows.field.deleteNode")}
                </button>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t("flows.builder.testRun")}</div>
            <label className={`${labelCls} mt-3`}>{t("flows.builder.testText")}</label>
            <input value={testText} onChange={(e) => setTestText(e.target.value)} placeholder={t("flows.builder.testTextPlaceholder")} className={inputCls} />
            <button onClick={() => void runTest()} disabled={busy} className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
              {t("flows.builder.testRunButton")}
            </button>
            {testActions !== null && (
              <div className="mt-3">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {t("flows.builder.testResult")} - status: {testStatus}
                </div>
                {testActions.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("flows.builder.testEmpty")}</p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {testActions.map((action, i) => (
                      <li key={i} className="rounded-md bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-700 break-all dark:bg-slate-800 dark:text-slate-200">
                        {JSON.stringify(action)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function FlowBuilder(props: BuilderProps) {
  return (
    <ReactFlowProvider>
      <BuilderInner {...props} />
    </ReactFlowProvider>
  );
}

/** A starter graph for a brand-new flow: keyword trigger -> send_message. */
export function starterGraph(): FlowGraph {
  return {
    startNodeId: "trigger_1",
    nodes: [
      {
        id: "trigger_1", type: "trigger", trigger: "keyword",
        config: { flowTriggerType: "keyword", keyword: "", match: "contains" },
        next: "send_1", position: { x: 120, y: 60 },
      },
      { id: "send_1", type: "send_message", text: "", next: null, position: { x: 120, y: 240 } },
    ],
    edges: [{ id: "e_trigger_send", source: "trigger_1", target: "send_1" }],
  };
}
