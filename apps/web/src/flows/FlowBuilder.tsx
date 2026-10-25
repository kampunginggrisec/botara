import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position,
  addEdge, useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  api, ApiError,
  type CatalogProduct, type ChannelAccount, type Flow, type FlowGraph, type FlowTrigger,
  type RichBlock, type RichButton,
} from "../api";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { RICH_BUTTONS_EXAMPLE } from "../rich-example";

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
      if (kind === "comment_keyword") return `comment: "${cfgStr(node, "keyword")}"`;
      if (kind === "postback") return `payload: ${cfgStr(node, "payload")}`;
      return "manual";
    }
    case "send_message": {
      const rich = node.rich as RichBlock | undefined;
      const base = str(node, "text").slice(0, 60) || "...";
      return rich ? `${base} [+${rich.kind}]` : base;
    }
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
  if (kind === "comment_keyword") {
    return {
      type: "comment_keyword",
      config: {
        keyword: String(config.keyword ?? ""),
        match: config.match === "equals" ? "equals" : "contains",
        ...(typeof config.publicReplyText === "string" && config.publicReplyText ? { publicReplyText: config.publicReplyText } : {}),
        ...(config.autoHide === true ? { autoHide: true } : {}),
        ...(typeof config.privateText === "string" && config.privateText ? { privateText: config.privateText } : {}),
      },
    };
  }
  return { type: "manual", config: {} };
}

const RICH_KINDS = ["buttons", "list", "carousel", "product", "catalog"] as const;

// Same primitives as BuilderInner's locals (kept in sync deliberately).
const richInputCls = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";
const richLabelCls = "block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1";

function defaultRichBlock(kind: RichBlock["kind"]): RichBlock {
  switch (kind) {
    case "buttons": return { kind, text: "", buttons: [{ type: "reply", title: "", payload: "" }] };
    case "list": return { kind, text: "", buttonText: "View", sections: [{ title: "", rows: [{ id: "1", title: "" }] }] };
    case "carousel": return { kind, cards: [{ title: "" }] };
    case "product": return { kind, catalogId: "", productId: "", text: "" };
    case "catalog": return { kind, catalogId: "", text: "" };
  }
}

/**
 * Rich-block editor for send_message nodes (adopted features). Functional
 * over fancy: kind select + the fields each block kind needs. List rows
 * and catalog sections use one-line-per-entry textareas
 * ("id | title | description" / "Section title: id1, id2").
 * Channels render what they support and degrade the rest to text with a
 * typed warning - the editor therefore allows every combination.
 */
function RichBlockEditor({ node, patch, t, products }: {
  node: EngineNode;
  patch: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useI18n>["t"];
  /** Synced catalog products for the product/catalog pickers (may be empty). */
  products: CatalogProduct[];
}) {
  const rich = (node.rich && typeof node.rich === "object" ? (node.rich as RichBlock) : null);
  const setRich = (next: RichBlock | undefined) => patch({ rich: next });

  if (!rich) {
    return (
      <button
        onClick={() => setRich(defaultRichBlock("buttons"))}
        className="text-xs text-slate-600 underline dark:text-slate-300"
      >
        {t("flows.rich.add")}
      </button>
    );
  }

  const rowsText = rich.kind === "list"
    ? rich.sections.flatMap((s) => s.rows.map((r) => `${s.title} | ${r.id} | ${r.title}${r.description ? ` | ${r.description}` : ""}`)).join("\n")
    : "";
  const applyRowsText = (text: string) => {
    if (rich.kind !== "list") return;
    const sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> = [];
    for (const line of text.split("\n")) {
      const parts = line.split("|").map((p) => p.trim());
      if (parts.length < 3 || !parts[1] || !parts[2]) continue;
      const [sectionTitle, id, title, description] = parts as [string, string, string, string?];
      let section = sections.find((s) => s.title === sectionTitle);
      if (!section) {
        section = { title: sectionTitle, rows: [] };
        sections.push(section);
      }
      section.rows.push({ id, title, ...(description ? { description } : {}) });
    }
    setRich({ ...rich, sections });
  };

  const sectionsText = rich.kind === "catalog"
    ? (rich.sections ?? []).map((s) => `${s.title}: ${s.productIds.join(",")}`).join("\n")
    : "";
  const applySectionsText = (text: string) => {
    if (rich.kind !== "catalog") return;
    const sections = text.split("\n").map((line) => {
      const idx = line.indexOf(":");
      if (idx < 0) return null;
      const title = line.slice(0, idx).trim();
      const productIds = line.slice(idx + 1).split(",").map((p) => p.trim()).filter(Boolean);
      return title && productIds.length > 0 ? { title, productIds } : null;
    }).filter((s): s is { title: string; productIds: string[] } => s !== null);
    setRich({ ...rich, sections });
  };

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{t("flows.rich.title")}</span>
        <button onClick={() => setRich(undefined)} className="text-xs text-red-600 underline dark:text-red-400">
          {t("common.remove")}
        </button>
      </div>
      <div>
        <label className={richLabelCls}>{t("flows.rich.kind")}</label>
        <select
          value={rich.kind}
          onChange={(e) => setRich(defaultRichBlock(e.target.value as RichBlock["kind"]))}
          className={richInputCls}
        >
          {RICH_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>

      {(rich.kind === "buttons" || rich.kind === "list" || rich.kind === "product" || rich.kind === "catalog") && (
        <div>
          <label className={richLabelCls}>{t("flows.field.text")}</label>
          <textarea
            value={rich.text ?? ""}
            onChange={(e) => setRich({ ...rich, text: e.target.value } as RichBlock)}
            rows={2}
            className={richInputCls}
            placeholder={rich.kind === "buttons" && RICH_BUTTONS_EXAMPLE.kind === "buttons" ? RICH_BUTTONS_EXAMPLE.text : undefined}
          />
        </div>
      )}

      {rich.kind === "buttons" && (
        <div className="space-y-2">
          {rich.buttons.map((b, i) => (
            <div key={i} className="flex flex-wrap gap-2">
              <select
                value={b.type}
                onChange={(e) => {
                  const type = e.target.value as RichButton["type"];
                  const buttons = rich.buttons.map((x, j) => (j === i ? { ...x, type } : x));
                  setRich({ ...rich, buttons });
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="reply">reply</option>
                <option value="postback">postback</option>
                <option value="url">url</option>
              </select>
              <input
                value={b.title}
                onChange={(e) => setRich({ ...rich, buttons: rich.buttons.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                placeholder={RICH_BUTTONS_EXAMPLE.kind === "buttons" ? (RICH_BUTTONS_EXAMPLE.buttons[i]?.title ?? t("flows.rich.buttonTitle")) : t("flows.rich.buttonTitle")}
                className="w-28 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              {b.type === "url" ? (
                <input
                  value={b.url ?? ""}
                  onChange={(e) => setRich({ ...rich, buttons: rich.buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })}
                  placeholder={RICH_BUTTONS_EXAMPLE.kind === "buttons" ? (RICH_BUTTONS_EXAMPLE.buttons[i]?.url ?? "https://example.com") : "https://example.com"}
                  className="w-40 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              ) : (
                <input
                  value={b.payload ?? ""}
                  onChange={(e) => setRich({ ...rich, buttons: rich.buttons.map((x, j) => (j === i ? { ...x, payload: e.target.value } : x)) })}
                  placeholder={RICH_BUTTONS_EXAMPLE.kind === "buttons" ? (RICH_BUTTONS_EXAMPLE.buttons[i]?.payload ?? "HARGA") : "HARGA"}
                  className="w-40 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              )}
              <button
                onClick={() => setRich({ ...rich, buttons: rich.buttons.filter((_, j) => j !== i) })}
                className="text-xs text-red-600 underline dark:text-red-400"
              >
                {t("common.remove")}
              </button>
            </div>
          ))}
          <button
            onClick={() => setRich({ ...rich, buttons: [...rich.buttons, { type: "reply", title: "", payload: "" }] })}
            className="text-xs text-slate-600 underline dark:text-slate-300"
          >
            {t("flows.rich.addButton")}
          </button>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("flows.rich.payloadHint")}</p>
          <button
            onClick={() => setRich(RICH_BUTTONS_EXAMPLE)}
            className="text-xs text-slate-600 underline dark:text-slate-300"
          >
            {t("flows.rich.useExample")}
          </button>
        </div>
      )}

      {rich.kind === "list" && (
        <>
          <div>
            <label className={richLabelCls}>{t("flows.rich.buttonText")}</label>
            <input value={rich.buttonText} onChange={(e) => setRich({ ...rich, buttonText: e.target.value })} className={richInputCls} />
          </div>
          <div>
            <label className={richLabelCls}>{t("flows.rich.rows")}</label>
            <textarea defaultValue={rowsText} key={rowsText} onBlur={(e) => applyRowsText(e.target.value)} rows={4} className={`${richInputCls} font-mono text-xs`} placeholder="Section | id | Title | Description" />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("flows.rich.rowsHint")}</p>
          </div>
        </>
      )}

      {rich.kind === "carousel" && (
        <div className="space-y-2">
          {rich.cards.map((card, i) => (
            <div key={i} className="space-y-1 rounded border border-slate-100 p-2 dark:border-slate-800">
              <input
                value={card.title}
                onChange={(e) => setRich({ ...rich, cards: rich.cards.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                placeholder={t("flows.rich.cardTitle")}
                className={richInputCls}
              />
              <input
                value={card.subtitle ?? ""}
                onChange={(e) => setRich({ ...rich, cards: rich.cards.map((x, j) => (j === i ? { ...x, subtitle: e.target.value } : x)) })}
                placeholder={t("flows.rich.cardSubtitle")}
                className={richInputCls}
              />
              <input
                value={card.imageUrl ?? ""}
                onChange={(e) => setRich({ ...rich, cards: rich.cards.map((x, j) => (j === i ? { ...x, imageUrl: e.target.value } : x)) })}
                placeholder="https://.../image.jpg"
                className={richInputCls}
              />
              <button
                onClick={() => setRich({ ...rich, cards: rich.cards.filter((_, j) => j !== i) })}
                className="text-xs text-red-600 underline dark:text-red-400"
              >
                {t("common.remove")}
              </button>
            </div>
          ))}
          <button
            onClick={() => setRich({ ...rich, cards: [...rich.cards, { title: "" }] })}
            className="text-xs text-slate-600 underline dark:text-slate-300"
          >
            {t("flows.rich.addCard")}
          </button>
        </div>
      )}

      {(rich.kind === "product" || rich.kind === "catalog") && products.length > 0 && (
        <div>
          <label className={richLabelCls}>{t("flows.rich.productPicker")}</label>
          <select
            value={rich.kind === "product" && products.some((p) => p.catalogId === rich.catalogId && p.retailerId === rich.productId)
              ? `${rich.catalogId}::${rich.productId}`
              : ""}
            onChange={(e) => {
              const [catalogId, retailerId] = e.target.value.split("::");
              if (!catalogId || !retailerId) return;
              if (rich.kind === "product") {
                setRich({ ...rich, catalogId, productId: retailerId });
              } else if (rich.kind === "catalog") {
                const sections = rich.sections ?? [];
                const included = sections.some((s) => s.productIds.includes(retailerId));
                const nextSections = included
                  ? sections
                  : sections.length > 0
                    ? sections.map((s, i) => (i === 0 ? { ...s, productIds: [...s.productIds, retailerId] } : s))
                    : [{ title: "Products", productIds: [retailerId] }];
                setRich({ ...rich, catalogId, sections: nextSections });
              }
            }}
            className={richInputCls}
          >
            <option value="">{t("flows.rich.productPicker")}</option>
            {[...new Set(products.map((p) => p.catalogId))].map((catalogId) => (
              <optgroup key={catalogId} label={catalogId}>
                {products.filter((p) => p.catalogId === catalogId).map((p) => (
                  <option key={p.id} value={`${p.catalogId}::${p.retailerId}`}>
                    {p.name} ({p.retailerId})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}
      {(rich.kind === "product" || rich.kind === "catalog") && (
        <div>
          <label className={richLabelCls}>{t("flows.rich.catalogId")}</label>
          <input value={rich.catalogId} onChange={(e) => setRich({ ...rich, catalogId: e.target.value })} className={richInputCls} />
        </div>
      )}
      {rich.kind === "product" && (
        <div>
          <label className={richLabelCls}>{t("flows.rich.productId")}</label>
          <input value={rich.productId} onChange={(e) => setRich({ ...rich, productId: e.target.value })} className={richInputCls} />
        </div>
      )}
      {rich.kind === "catalog" && (
        <div>
          <label className={richLabelCls}>{t("flows.rich.sections")}</label>
          <textarea defaultValue={sectionsText} key={sectionsText} onBlur={(e) => applySectionsText(e.target.value)} rows={3} className={`${richInputCls} font-mono text-xs`} placeholder="Featured: sku-1,sku-2" />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("flows.rich.sectionsHint")}</p>
        </div>
      )}
      <p className="text-xs text-slate-500 dark:text-slate-400">{t("flows.rich.degradeHint")}</p>
    </div>
  );
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
  // Synced catalog products feed the rich product/catalog pickers.
  const [catalogProducts, setCatalogProducts] = useState<CatalogProduct[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.listCatalogProducts({ limit: 200 });
        if (!cancelled) setCatalogProducts(data.products);
      } catch { /* pickers are an enhancement; manual ids still work */ }
    })();
    return () => { cancelled = true; };
  }, []);

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
                            trigger: kind === "keyword" ? "keyword"
                              : kind === "postback" ? "message.received"
                              : kind === "comment_keyword" ? "comment.received"
                              : "manual",
                          });
                          patchSelectedConfig({ flowTriggerType: kind });
                        }}
                        className={inputCls}
                      >
                        <option value="keyword">keyword</option>
                        <option value="postback">postback</option>
                        <option value="comment_keyword">{t("flows.field.triggerComment")}</option>
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
                    {cfgStr(selected, "flowTriggerType") === "comment_keyword" && (
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
                        <div>
                          <label className={labelCls}>{t("flows.field.publicReply")}</label>
                          <input value={cfgStr(selected, "publicReplyText")} onChange={(e) => patchSelectedConfig({ publicReplyText: e.target.value })} placeholder={t("flows.field.publicReplyPlaceholder")} className={inputCls} />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                          <input
                            type="checkbox"
                            checked={cfg(selected).autoHide === true}
                            onChange={(e) => patchSelectedConfig({ autoHide: e.target.checked })}
                          />
                          {t("flows.field.autoHide")}
                        </label>
                        <div>
                          <label className={labelCls}>{t("flows.field.privateText")}</label>
                          <textarea value={cfgStr(selected, "privateText")} onChange={(e) => patchSelectedConfig({ privateText: e.target.value })} rows={2} className={inputCls} />
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("flows.field.privateTextHint")}</p>
                        </div>
                      </>
                    )}
                  </>
                )}
                {selected.type === "send_message" && (
                  <>
                    <div>
                      <label className={labelCls}>{t("flows.field.text")}</label>
                      <textarea value={str(selected, "text")} onChange={(e) => patchSelected({ text: e.target.value })} rows={3} className={inputCls} />
                    </div>
                    <RichBlockEditor node={selected} patch={patchSelected} t={t} products={catalogProducts} />
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
