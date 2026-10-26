import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  api, ApiError, BASE_URL, downloadTextFile, getToken, getWorkspaceId, onUnauthorized, setToken, setWorkspaceId,
  type AdminAuditItem, type AdminBilling, type AdminOverview, type AdminSettingUpdate, type AdminSettingView,
  type AdminUserItem, type AdminWorkspaceItem,
  type ApiTokenInfo, type AuthUser, type BroadcastDetail, type BroadcastEstimate, type BroadcastRecipient,
  type BroadcastRecipientCounts, type BroadcastSummary,
  type CatalogProduct, type CatalogSummary,
  type ChannelAccount, type ConnectionInfo, type Contact,
  type ContactImportResult, type Conversation, type Deal, type Flow, type GrowthLink, type KbDocument,
  type Member, type Message, type Pipeline, type PipelineSummary, type PublicConfig,
  type RichBlock, type ScheduledPost, type SegmentInfo,
  type Sequence, type SequenceStep, type StatsOverview, type Template, type WorkspaceDomain,
  type WorkspaceSummary,
} from "./api";
import { LanguageProvider, LanguageSwitcher, useI18n } from "./i18n";
import {
  connectRealtime, decideInboxRefresh, isRealtimeDegraded,
  type InboxRealtimeEvent, type RealtimeHandle,
} from "./realtime";
import { ThemeProvider, ThemeToggle } from "./theme";
import { FlowBuilder, starterGraph } from "./flows/FlowBuilder";
import { downloadFlowExport, parseFlowImport } from "./flows/flow-transfer";
import { RICH_BUTTONS_EXAMPLE, RICH_BUTTONS_EXAMPLE_COMPOSER } from "./rich-example";
import { dismissToast, getToasts, pushToast, subscribeToasts } from "./toast";
import { VariablePicker } from "./variable-picker";
import { RECIPIENT_STATUSES, broadcastCostUsd, formatUsd, recipientStatusTone, recipientTimeline } from "./broadcast-recipients";
import { formatDealMoney, groupDealsByStage, movedStageOrder, visibleDeals } from "./deals";
import {
  TOKEN_RESOURCES, countPickedResources, defaultTokenFormState, emptyScopePicks, expiryIsoFromDays,
  picksToScopes, scopeParts, tokenIsExpired, type ScopePicks, type TokenResource,
} from "./api-tokens";
import { SavedRepliesPicker } from "./saved-replies-picker";
import {
  buildGroupUpdates, groupHasChanges, inputValueFor, platformConfigured,
  type PlatformCardGroup,
} from "./admin-settings-model";

type PageId = "dashboard" | "inbox" | "contacts" | "flows" | "broadcast" | "sequences" | "deals" | "publish" | "channels" | "knowledge" | "growth" | "settings" | "admin";

const NAV: Array<{ id: PageId; labelKey: Parameters<ReturnType<typeof useI18n>["t"]>[0] }> = [
  { id: "dashboard", labelKey: "nav.dashboard" },
  { id: "inbox", labelKey: "nav.inbox" },
  { id: "contacts", labelKey: "nav.contacts" },
  { id: "flows", labelKey: "nav.flows" },
  { id: "broadcast", labelKey: "nav.broadcast" },
  { id: "sequences", labelKey: "nav.sequences" },
  { id: "deals", labelKey: "nav.deals" },
  { id: "publish", labelKey: "nav.publish" },
  { id: "channels", labelKey: "nav.channels" },
  { id: "knowledge", labelKey: "nav.knowledge" },
  { id: "growth", labelKey: "nav.growth" },
  { id: "settings", labelKey: "nav.settings" },
  { id: "admin", labelKey: "nav.admin" },
];

// Shared dark-aware primitives (Fase 4 theme pass).
const cardCls = "rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const inputCls = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500";
const labelCls = "block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1";
const primaryBtn = "rounded-md bg-slate-900 text-white text-sm px-4 py-2 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900";
const outlineBtn = "rounded-md border border-slate-900 text-slate-900 text-sm px-4 py-2 disabled:opacity-50 dark:border-slate-100 dark:text-slate-100";
const chipBtn = "rounded-full border border-slate-300 px-2.5 py-0.5 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800";
const chipBtnActive = "rounded-full border border-slate-900 bg-slate-900 px-2.5 py-0.5 text-xs text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900";
const chipCls = "text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
const mutedCls = "text-sm text-slate-500 dark:text-slate-400";

function ErrorBox({ error }: { error: string }) {
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {error}
    </div>
  );
}

/** Transient success/failure alerts (top-right stack, auto-dismiss). */
function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed right-4 top-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((item) => (
        <div
          key={item.id}
          role={item.kind === "err" ? "alert" : "status"}
          className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 shadow-lg ${
            item.kind === "err"
              ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
              : "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
          }`}
        >
          <span
            aria-hidden
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${
              item.kind === "err" ? "bg-red-500" : "bg-emerald-500"
            }`}
          >
            {item.kind === "err" ? "!" : "✓"}
          </span>
          <span className="flex-1 text-sm leading-snug">{item.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(item.id)}
            className="shrink-0 px-1 text-base leading-none opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function NoticeBox({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
      {children}
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
      {children}
    </div>
  );
}

function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {subtitle && <p className={`mt-1 ${mutedCls}`}>{subtitle}</p>}
    </>
  );
}

const errText = (err: unknown, fallback: string): string =>
  err instanceof ApiError ? err.message : fallback;

/** Up-to-two-letter initials for an assignee chip (from a name or email). */
const initialsOf = (label: string): string =>
  label.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";

/** The three conversation statuses, in lifecycle order. */
const CONVERSATION_STATUSES = ["open", "pending", "resolved"] as const;
type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** i18n key for a status value; unknown values fall back to "open". */
const statusLabelKey = (status: string): "inbox.statusOpen" | "inbox.statusPending" | "inbox.statusResolved" =>
  status === "pending" ? "inbox.statusPending" : status === "resolved" ? "inbox.statusResolved" : "inbox.statusOpen";

/** Badge palette per status: open = sky, pending = amber, resolved = muted. */
const statusBadgeCls = (status: string): string =>
  status === "pending"
    ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
    : status === "resolved"
      ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
      : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300";

// ------------------------------------------------------------------- Inbox

/**
 * Read-only rendering of a rich message's buttons under its thread
 * bubble, so agents see exactly the choices the visitor was offered.
 * Reply/postback buttons are inert chips; URL buttons stay links.
 * Non-block payloads (webchat click echoes) render nothing.
 */
function RichPayloadChips({ payload }: { payload: Message["payload"] }) {
  if (!payload || typeof payload !== "object" || !("kind" in payload)) return null;
  const chipCls = "rounded-full border border-slate-300 px-2.5 py-0.5 text-xs text-slate-500 dark:border-slate-600 dark:text-slate-400";
  if (payload.kind === "buttons") {
    return (
      <div className="flex flex-wrap gap-1">
        {payload.buttons.map((b, i) => (b.type === "url" && b.url ? (
          <a key={i} href={b.url} target="_blank" rel="noreferrer" className={`${chipCls} underline`}>
            {b.title}
          </a>
        ) : (
          <button key={i} type="button" disabled className={chipCls}>{b.title}</button>
        )))}
      </div>
    );
  }
  if (payload.kind === "list") {
    return (
      <div className="flex flex-col gap-1">
        {payload.sections.map((s, si) => (
          <div key={si} className="flex flex-wrap items-center gap-1">
            {s.title && <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">{s.title}</span>}
            {s.rows.map((r) => (
              <button key={r.id} type="button" disabled className={chipCls}>{r.title}</button>
            ))}
          </div>
        ))}
      </div>
    );
  }
  return null;
}

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i;

/**
 * Stored media under a thread bubble (inbound media pipeline): the
 * bytes were copied into Botara storage at ingest; mediaUrls are the
 * public URLs to render and mediaKeys carry the filename (last path
 * segment). Images render inline and click through to the full file;
 * everything else is a file chip. A stored item whose URL list is
 * empty (storage has no public base configured) shows as an unlinked
 * chip - the file exists, it is just not publicly addressable.
 */
function MessageMediaList({ message }: { message: Message }) {
  const keys = message.mediaKeys ?? [];
  const urls = message.mediaUrls ?? [];
  if (keys.length === 0 && urls.length === 0) return null;
  const names = keys.length > 0 ? keys : urls;
  return (
    <div className="flex flex-col gap-1">
      {names.map((name, i) => {
        const url = urls[i];
        const filename = name.split("/").pop() ?? name;
        if (url && IMAGE_FILE_RE.test(filename)) {
          return (
            <a key={i} href={url} target="_blank" rel="noreferrer">
              <img src={url} alt={filename} className="max-h-48 rounded-lg border border-slate-200 dark:border-slate-700" />
            </a>
          );
        }
        const chipCls = "inline-flex max-w-full items-center gap-1 self-start rounded-full border border-slate-300 px-2.5 py-0.5 text-xs text-slate-500 dark:border-slate-600 dark:text-slate-400";
        return url ? (
          <a key={i} href={url} target="_blank" rel="noreferrer" className={`${chipCls} underline`}>
            <span className="truncate">{filename}</span>
          </a>
        ) : (
          <span key={i} className={chipCls}><span className="truncate">{filename}</span></span>
        );
      })}
    </div>
  );
}

function InboxPage({ liveEvent }: { liveEvent: InboxRealtimeEvent | null }) {
  const { t } = useI18n();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyText, setReplyText] = useState("");
  // Composer mode (package #2): "reply" writes to the customer, "note"
  // adds an internal timeline note. Each mode keeps its own draft, so
  // toggling never loses text.
  const [composerMode, setComposerMode] = useState<"reply" | "note">("reply");
  const [noteText, setNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowClosed, setWindowClosed] = useState(false);
  const [sending, setSending] = useState(false);
  // Assignment: workspace members for the filter + header select, and
  // the list filter itself ("" = all, "me", "unassigned", or a user id).
  const [members, setMembers] = useState<Member[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState("");
  // Status management: the list filter ("" = all) mirrors the API's
  // ?status= enum; the row's status itself changes from the thread header.
  const [statusFilter, setStatusFilter] = useState("");
  // Rich composer (adopted features): reply/url buttons OR a catalog
  // product attached to the reply as a rich block; channels render or
  // degrade them. Synced products for the open conversation's account
  // feed the product picker.
  const [richKind, setRichKind] = useState<"none" | "buttons" | "product">("none");
  const [richButtons, setRichButtons] = useState<Array<{ type: "reply" | "url"; title: string; payload: string; url: string }>>([]);
  const [richWarning, setRichWarning] = useState<string | null>(null);
  const [accountProducts, setAccountProducts] = useState<CatalogProduct[]>([]);
  const [productCatalogId, setProductCatalogId] = useState("");
  const [productRetailerId, setProductRetailerId] = useState("");
  // Contact editing from the thread header (F1): the modal needs the
  // full contact (custom fields), fetched on open via GET /contacts/{id}.
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  // Composer assist (F4/F9): AI suggestion fills the draft; the
  // moderation check only reports a verdict - neither ever sends.
  const [aiBusy, setAiBusy] = useState(false);
  // AI analysis (package #7): the header's Analyze/Refresh button.
  const [aiAnalyzeBusy, setAiAnalyzeBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);

  const showButtons = richKind === "buttons";

  const loadConversations = useCallback(async (): Promise<Conversation[]> => {
    try {
      const data = await api.listConversations({
        ...(assigneeFilter ? { assignee: assigneeFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      });
      setConversations(data.conversations);
      setError(null);
      return data.conversations;
    } catch (err) {
      setError(errText(err, t("inbox.loadFailed")));
      return [];
    }
  }, [t, assigneeFilter, statusFilter]);

  useEffect(() => { void loadConversations(); }, [loadConversations]);

  // Workspace members for assignment (same endpoint Settings uses).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.listMembers(getWorkspaceId());
        if (!cancelled) setMembers(data.members);
      } catch { /* assignment UI degrades to Unassigned-only; inbox still works */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Synced catalog products for the open conversation's WhatsApp account.
  const selectedId = selected?.id;
  const selectedChannel = selected?.channel;
  const selectedAccountId = selected?.channelAccountId;
  useEffect(() => {
    if (!selectedId || selectedChannel !== "whatsapp" || !selectedAccountId) {
      setAccountProducts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.listCatalogProducts({ accountId: selectedAccountId, limit: 200 });
        if (!cancelled) setAccountProducts(data.products);
      } catch {
        if (!cancelled) setAccountProducts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, selectedChannel, selectedAccountId]);

  const openContactEditor = async (conv: Conversation) => {
    try {
      const res = await api.getContact(conv.contactId);
      setEditingContact(res.contact);
    } catch (err) {
      pushToast("err", errText(err, t("contacts.loadFailed")));
    }
  };

  const onContactSaved = (updated: Contact) => {
    const patch = (c: Conversation): Conversation =>
      c.contactId === updated.id
        ? { ...c, contactDisplayName: updated.displayName, contactTags: updated.tags ?? [] }
        : c;
    setConversations((prev) => prev.map(patch));
    setSelected((prev) => (prev ? patch(prev) : prev));
  };

  const runAiSuggest = async () => {
    if (!selected) return;
    setAiBusy(true);
    try {
      const res = await api.aiSuggest(selected.id);
      setReplyText(res.suggestion);
      pushToast("ok", t("inbox.aiSuggested"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        pushToast("err", t("inbox.aiUnavailable"));
      } else {
        pushToast("err", errText(err, t("inbox.aiFailed")));
      }
    } finally {
      setAiBusy(false);
    }
  };

  const runAiAnalyze = async () => {
    if (!selected) return;
    setAiAnalyzeBusy(true);
    try {
      const res = await api.aiAnalyze(selected.id);
      const patch = {
        aiSummary: res.aiSummary, aiSummaryAt: res.aiSummaryAt,
        aiIntent: res.aiIntent, aiIntentScore: res.aiIntentScore,
      };
      setSelected((prev) => (prev && prev.id === selected.id ? { ...prev, ...patch } : prev));
      setConversations((prev) => prev.map((c) => (c.id === selected.id ? { ...c, ...patch } : c)));
      pushToast("ok", t("inbox.aiAnalyzed"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        pushToast("err", t("inbox.aiUnavailable"));
      } else if (err instanceof ApiError && err.status === 502) {
        pushToast("err", t("inbox.aiAnalysisInvalid"));
      } else {
        pushToast("err", errText(err, t("inbox.aiFailed")));
      }
    } finally {
      setAiAnalyzeBusy(false);
    }
  };

  // Takeover (package #7): pause/resume AUTOMATIC AI sends on the open
  // thread. The API returns the fresh conversation row either way.
  const setAiPaused = async (conv: Conversation, paused: boolean) => {
    try {
      const res = paused ? await api.aiPause(conv.id) : await api.aiResume(conv.id);
      setConversations((prev) => prev.map((c) => (c.id === conv.id ? res.conversation : c)));
      if (selectedRef.current?.id === conv.id) setSelected(res.conversation);
    } catch (err) {
      pushToast("err", errText(err, t("inbox.aiFailed")));
    }
  };

  const runModerationCheck = async () => {
    if (!replyText.trim()) {
      pushToast("err", t("inbox.moderationEmpty"));
      return;
    }
    setCheckBusy(true);
    try {
      const res = await api.moderationCheck(replyText);
      if (res.flagged) {
        const terms = [...new Set(res.matches.map((m) => m.term))].join(", ");
        pushToast("err", t("inbox.moderationFlagged", { terms }));
      } else {
        pushToast("ok", t("inbox.moderationClean"));
      }
    } catch (err) {
      pushToast("err", errText(err, t("inbox.moderationFailed")));
    } finally {
      setCheckBusy(false);
    }
  };

  const changeAssignee = async (conv: Conversation, userId: string | null) => {
    try {
      const res = await api.assignConversation(conv.id, userId);
      setConversations((prev) => prev.map((c) => (c.id === conv.id ? res.conversation : c)));
      if (selectedRef.current?.id === conv.id) setSelected(res.conversation);
    } catch (err) {
      setError(errText(err, t("inbox.assignFailed")));
    }
  };

  const changeStatus = async (conv: Conversation, status: "open" | "pending" | "resolved") => {
    try {
      const res = await api.setConversationStatus(conv.id, status);
      setConversations((prev) => prev.map((c) => (c.id === conv.id ? res.conversation : c)));
      if (selectedRef.current?.id === conv.id) setSelected(res.conversation);
    } catch (err) {
      setError(errText(err, t("inbox.statusFailed")));
    }
  };

  // Live updates (realtime socket owned by AuthedApp): an event for the
  // current workspace refreshes the list; an event for the OPEN
  // conversation refetches its messages too - no manual refresh. An
  // inbox.update (assignment) also re-syncs the open thread's header
  // from the fresh list row.
  const selectedRef = useRef<Conversation | null>(null);
  selectedRef.current = selected;
  useEffect(() => {
    if (!liveEvent) return;
    const decision = decideInboxRefresh(liveEvent, {
      workspaceId: getWorkspaceId(),
      openConversationId: selectedRef.current?.id ?? null,
    });
    if (!decision.refreshList && !decision.refreshMessages) return;
    void (async () => {
      const fresh = decision.refreshList ? await loadConversations() : null;
      const open = selectedRef.current;
      if (decision.refreshMessages && open) {
        await openConversation(fresh?.find((c) => c.id === open.id) ?? open);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEvent]);

  // Degraded fallback: while the realtime socket cannot connect, poll
  // every 30s so the inbox still self-refreshes (checked per tick - as
  // soon as the socket recovers, polling goes quiet again).
  useEffect(() => {
    const timer = setInterval(() => {
      if (!isRealtimeDegraded()) return;
      void (async () => {
        const fresh = await loadConversations();
        const open = selectedRef.current;
        if (open) await openConversation(fresh.find((c) => c.id === open.id) ?? open);
      })();
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openConversation = async (conv: Conversation) => {
    setSelected(conv);
    setWindowClosed(false);
    try {
      const data = await api.listMessages(conv.id);
      setMessages(data.messages);
    } catch (err) {
      setError(errText(err, t("inbox.messagesFailed")));
    }
  };

  const sendReply = async () => {
    if (!selected || !replyText.trim()) return;
    setSending(true);
    setRichWarning(null);
    try {
      const validButtons = richButtons.filter((b) => b.title.trim());
      const rich: RichBlock | undefined = richKind === "buttons" && validButtons.length > 0
        ? {
            kind: "buttons",
            text: replyText.trim(),
            buttons: validButtons.map((b) => (b.type === "url"
              ? { type: "url" as const, title: b.title.trim(), url: b.url.trim() }
              : { type: "reply" as const, title: b.title.trim(), payload: b.payload.trim() || b.title.trim() })),
          }
        : richKind === "product" && productCatalogId.trim() && productRetailerId.trim()
          ? {
              kind: "product",
              catalogId: productCatalogId.trim(),
              productId: productRetailerId.trim(),
              text: replyText.trim(),
            }
          : undefined;
      const res = await api.reply(selected.id, { kind: "free_form", text: replyText.trim(), ...(rich ? { rich } : {}) });
      if (res.warnings && res.warnings.length > 0) {
        setRichWarning(t("inbox.richDegraded", { warnings: res.warnings.join(", ") }));
      }
      if (res.interpolationWarnings && res.interpolationWarnings.length > 0) {
        pushToast("err", t("inbox.variablesUnknown", { vars: res.interpolationWarnings.join(", ") }));
      }
      setReplyText("");
      setRichButtons([]);
      setRichKind("none");
      setProductCatalogId("");
      setProductRetailerId("");
      setWindowClosed(false);
      await openConversation(selected);
    } catch (err) {
      if (err instanceof ApiError && err.code === "MESSAGING_WINDOW_CLOSED") {
        setWindowClosed(true);
      } else {
        setError(errText(err, t("inbox.sendFailed")));
      }
    } finally {
      setSending(false);
    }
  };

  // Internal note (package #2): posts to the notes endpoint only - the
  // text is stored verbatim (no variable rendering, no window check)
  // and the thread refetches so the note card appears in place.
  const addNote = async () => {
    if (!selected || !noteText.trim()) return;
    setNoteSaving(true);
    try {
      await api.addNote(selected.id, noteText.trim());
      setNoteText("");
      await openConversation(selected);
    } catch (err) {
      pushToast("err", errText(err, t("inbox.noteFailed")));
    } finally {
      setNoteSaving(false);
    }
  };

  return (
    <div>
      <PageTitle title={t("inbox.title")} subtitle={t("inbox.subtitle")} />
      {error && <div className="mt-4"><ErrorBox error={error} /></div>}
      {editingContact && (
        <ContactEditModal
          contact={editingContact}
          onClose={() => setEditingContact(null)}
          onSaved={onContactSaved}
        />
      )}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <select
              value={["", "me", "unassigned"].includes(assigneeFilter) ? assigneeFilter : ""}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              aria-label={t("inbox.assigneeLabel")}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">{t("inbox.assignFilterAll")}</option>
              <option value="me">{t("inbox.assignFilterMe")}</option>
              <option value="unassigned">{t("inbox.assignFilterUnassigned")}</option>
            </select>
            {members.length > 1 && (
              <select
                value={members.some((m) => m.userId === assigneeFilter) ? assigneeFilter : ""}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                aria-label={t("inbox.assigneeLabel")}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="">{t("inbox.assigneeLabel")}</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>{m.name ?? m.email}</option>
                ))}
              </select>
            )}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label={t("inbox.statusFilterLabel")}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">{t("inbox.statusFilterAll")}</option>
              {CONVERSATION_STATUSES.map((s) => (
                <option key={s} value={s}>{t(statusLabelKey(s))}</option>
              ))}
            </select>
          </div>
          {conversations.length === 0 && !error && <EmptyState>{t("inbox.empty")}</EmptyState>}
          {conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => void openConversation(conv)}
              className={`w-full text-left rounded-lg border p-3 shadow-sm ${selected?.id === conv.id
                ? "border-slate-500 bg-white dark:border-slate-400 dark:bg-slate-900"
                : "border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800"}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{conv.contactDisplayName ?? conv.contactExternalId}</span>
                <span className={chipCls}>{conv.channel}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusBadgeCls(conv.status)}`}>
                  {t(statusLabelKey(conv.status))}
                </span>
                <span>· {t("inbox.windowLabel")}: {conv.windowOpen
                  ? <span className="text-emerald-600 dark:text-emerald-400 font-medium">{t("inbox.windowOpen")}</span>
                  : <span className="text-red-600 dark:text-red-400 font-medium">{t("inbox.windowClosed")}</span>}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                {conv.assignee ? (
                  <>
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-100">
                      {initialsOf(conv.assignee.name ?? conv.assignee.email ?? "?")}
                    </span>
                    <span className="text-slate-600 dark:text-slate-300">{conv.assignee.name ?? conv.assignee.email}</span>
                  </>
                ) : (
                  <span className="text-slate-400 dark:text-slate-500">{t("inbox.unassigned")}</span>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className={`lg:col-span-2 ${cardCls} flex flex-col min-h-96`}>
          {!selected ? (
            <div className="p-6 text-sm text-slate-500 dark:text-slate-400">{t("inbox.selectPrompt")}</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 px-4 py-3">
                <div className="min-w-0">
                  <span className="font-medium text-sm">
                    {selected.contactDisplayName ?? selected.contactExternalId} · {selected.channel}
                  </span>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {(selected.contactTags ?? []).map((tag) => (
                      <span key={tag} className={chipCls}>{tag}</span>
                    ))}
                    <button
                      onClick={() => void openContactEditor(selected)}
                      className="text-xs text-slate-600 underline dark:text-slate-300"
                    >
                      {t("inbox.editContact")}
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    {t("inbox.statusLabel")}
                    <select
                      value={CONVERSATION_STATUSES.includes(selected.status as ConversationStatus) ? selected.status : "open"}
                      onChange={(e) => void changeStatus(selected, e.target.value as ConversationStatus)}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    >
                      {CONVERSATION_STATUSES.map((s) => (
                        <option key={s} value={s}>{t(statusLabelKey(s))}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    {t("inbox.assigneeLabel")}
                    <select
                      value={selected.assignedUserId ?? ""}
                      onChange={(e) => void changeAssignee(selected, e.target.value || null)}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    >
                      <option value="">{t("inbox.unassigned")}</option>
                      {members.map((m) => (
                        <option key={m.userId} value={m.userId}>{m.name ?? m.email} ({m.role})</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              {/* AI copilot strip (package #7): persisted analysis +
                  takeover state for the open thread. */}
              <div className="border-b border-slate-100 dark:border-slate-800 px-4 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                    {t("inbox.aiBadge")}
                  </span>
                  {selected.aiIntent && (
                    <span className={chipCls}>
                      {selected.aiIntent}{selected.aiIntentScore != null ? ` · ${selected.aiIntentScore}` : ""}
                    </span>
                  )}
                  <button
                    onClick={() => void runAiAnalyze()}
                    disabled={aiAnalyzeBusy}
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    {aiAnalyzeBusy
                      ? t("inbox.aiAnalyzing")
                      : selected.aiSummary ? t("inbox.aiRefresh") : t("inbox.aiAnalyze")}
                  </button>
                  {selected.aiPausedAt ? (
                    <>
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        {t("inbox.aiPaused")}
                      </span>
                      <button
                        onClick={() => void setAiPaused(selected, false)}
                        className="rounded-md border border-amber-400 px-2.5 py-1 text-xs font-medium text-amber-800 dark:border-amber-700 dark:text-amber-300"
                      >
                        {t("inbox.aiResume")}
                      </button>
                    </>
                  ) : (
                    <>
                      {messages.some((m) => m.authorKind === "ai") && (
                        <span className="text-[11px] text-slate-400 dark:text-slate-500">{t("inbox.aiActive")}</span>
                      )}
                      <button
                        onClick={() => void setAiPaused(selected, true)}
                        className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200"
                      >
                        {t("inbox.aiPause")}
                      </button>
                    </>
                  )}
                </div>
                {selected.aiSummary && (
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    <span className="font-semibold">{t("inbox.aiSummaryLabel")}:</span> {selected.aiSummary}
                  </p>
                )}
              </div>
              <div className="flex-1 p-4 space-y-2 overflow-y-auto">
                {messages.length === 0 && <div className="text-sm text-slate-400 dark:text-slate-500">{t("inbox.noMessages")}</div>}
                {messages.map((m) => m.kind === "note" ? (
                  // Internal note (package #2): a centered amber card,
                  // visually impossible to confuse with customer traffic.
                  <div key={m.id} className="flex justify-center">
                    <div className="w-full max-w-md rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                      <div className="text-[11px] font-semibold uppercase tracking-wide">
                        {t("inbox.noteLabel")}
                        {m.author ? ` · ${m.author.name ?? m.author.email ?? ""}` : ""}
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap">{m.body}</div>
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                    <div className="flex max-w-md flex-col gap-1">
                      <div className={`rounded-lg px-3 py-2 text-sm ${m.direction === "out"
                        ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                        : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"}`}>
                        <div>{m.body ?? <em>({m.type})</em>}</div>
                        <div className={`mt-1 flex items-center gap-1.5 text-[11px] ${m.direction === "out" ? "text-slate-300 dark:text-slate-500" : "text-slate-400"}`}>
                          {m.authorKind === "ai" && (
                            <span className="rounded-full bg-violet-500/25 px-1.5 py-px font-semibold">
                              {t("inbox.aiBadge")}
                            </span>
                          )}
                          <span>{m.status}</span>
                        </div>
                      </div>
                      <MessageMediaList message={m} />
                      {m.direction === "out" && <RichPayloadChips payload={m.payload} />}
                    </div>
                  </div>
                ))}
              </div>
              {windowClosed && (
                <div className="mx-4 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  <strong>{t("inbox.windowClosedTitle")}</strong> {t("inbox.windowClosedBody")}
                </div>
              )}
              {richWarning && (
                <div className="mx-4 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  {richWarning}
                </div>
              )}
              <div className={`border-t p-3 ${composerMode === "note"
                ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
                : "border-slate-100 dark:border-slate-800"}`}>
                <div className="mb-2 inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700" role="tablist" aria-label={t("inbox.modeReply")}>
                  <button
                    type="button"
                    onClick={() => setComposerMode("reply")}
                    className={`px-3 py-1 text-xs font-medium ${composerMode === "reply"
                      ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                      : "bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-300"}`}
                  >
                    {t("inbox.modeReply")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setComposerMode("note")}
                    className={`px-3 py-1 text-xs font-medium ${composerMode === "note"
                      ? "bg-amber-500 text-white dark:bg-amber-600"
                      : "bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-300"}`}
                  >
                    {t("inbox.modeNote")}
                  </button>
                </div>
                <div className="flex gap-2">
                  <textarea
                    ref={replyTextareaRef}
                    value={composerMode === "note" ? noteText : replyText}
                    onChange={(e) => (composerMode === "note" ? setNoteText(e.target.value) : setReplyText(e.target.value))}
                    rows={2}
                    placeholder={composerMode === "note" ? t("inbox.notePlaceholder") : t("inbox.replyPlaceholder")}
                    className={`flex-1 rounded-md border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 dark:bg-slate-900 dark:text-slate-100 ${composerMode === "note"
                      ? "border-amber-400 focus:ring-amber-400 dark:border-amber-800"
                      : "border-slate-300 focus:ring-slate-400 dark:border-slate-700"}`}
                  />
                  {composerMode === "note" ? (
                    <button
                      onClick={() => void addNote()}
                      disabled={noteSaving || !noteText.trim()}
                      className="self-end rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 dark:bg-amber-600 dark:hover:bg-amber-500"
                    >
                      {noteSaving ? t("inbox.addingNote") : t("inbox.addNote")}
                    </button>
                  ) : (
                    <button onClick={() => void sendReply()} disabled={sending || !replyText.trim()} className={`self-end ${primaryBtn}`}>
                      {sending ? t("common.sending") : t("common.send")}
                    </button>
                  )}
                </div>
                {composerMode === "reply" && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void runAiSuggest()}
                    disabled={aiBusy}
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    {aiBusy ? t("inbox.aiSuggesting") : t("inbox.aiSuggest")}
                  </button>
                  <button
                    onClick={() => void runModerationCheck()}
                    disabled={checkBusy}
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    {checkBusy ? t("inbox.checking") : t("inbox.checkDraft")}
                  </button>
                  <VariablePicker target={() => replyTextareaRef.current} />
                  <SavedRepliesPicker target={() => replyTextareaRef.current} />
                </div>
                )}
                {composerMode === "reply" && (
                <>
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-xs text-slate-500 dark:text-slate-400" htmlFor="inbox-rich-kind">
                    {t("inbox.richKind")}
                  </label>
                  <select
                    id="inbox-rich-kind"
                    value={richKind}
                    onChange={(e) => setRichKind(e.target.value as "none" | "buttons" | "product")}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <option value="none">{t("inbox.richNone")}</option>
                    <option value="buttons">{t("inbox.richButtons")}</option>
                    <option value="product">{t("inbox.richProduct")}</option>
                  </select>
                </div>
                {showButtons && (
                  <div className="mt-2 space-y-2 rounded-md border border-slate-200 p-2 dark:border-slate-700">
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t("inbox.buttonsHint")}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t("inbox.payloadHint")}</p>
                    <button
                      onClick={() => {
                        if (RICH_BUTTONS_EXAMPLE.kind === "buttons") setReplyText(RICH_BUTTONS_EXAMPLE.text);
                        setRichButtons(RICH_BUTTONS_EXAMPLE_COMPOSER.map((b) => ({ ...b })));
                      }}
                      className="text-xs text-slate-600 underline dark:text-slate-300"
                    >
                      {t("inbox.useExample")}
                    </button>
                    {richButtons.map((b, i) => (
                      <div key={i} className="flex flex-wrap gap-2">
                        <select
                          value={b.type}
                          onChange={(e) => setRichButtons((prev) => prev.map((x, j) => (j === i ? { ...x, type: e.target.value as "reply" | "url" } : x)))}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        >
                          <option value="reply">{t("inbox.buttonReply")}</option>
                          <option value="url">{t("inbox.buttonUrl")}</option>
                        </select>
                        <input
                          value={b.title}
                          onChange={(e) => setRichButtons((prev) => prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                          placeholder={RICH_BUTTONS_EXAMPLE_COMPOSER[i]?.title ?? t("inbox.buttonTitle")}
                          className="w-36 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        />
                        {b.type === "url" ? (
                          <input
                            value={b.url}
                            onChange={(e) => setRichButtons((prev) => prev.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                            placeholder={RICH_BUTTONS_EXAMPLE_COMPOSER[i]?.url || "https://example.com"}
                            className="w-52 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          />
                        ) : (
                          <input
                            value={b.payload}
                            onChange={(e) => setRichButtons((prev) => prev.map((x, j) => (j === i ? { ...x, payload: e.target.value } : x)))}
                            placeholder={RICH_BUTTONS_EXAMPLE_COMPOSER[i]?.payload || "HARGA"}
                            className="w-52 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          />
                        )}
                        <button
                          onClick={() => setRichButtons((prev) => prev.filter((_, j) => j !== i))}
                          className="text-xs text-red-600 underline dark:text-red-400"
                        >
                          {t("common.remove")}
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => setRichButtons((prev) => [...prev, { type: "reply", title: "", payload: "", url: "" }])}
                      className="text-xs text-slate-600 underline dark:text-slate-300"
                    >
                      {t("inbox.addButtonRow")}
                    </button>
                  </div>
                )}
                {richKind === "product" && (
                  <div className="mt-2 space-y-2 rounded-md border border-slate-200 p-2 dark:border-slate-700">
                    {accountProducts.length > 0 && (
                      <select
                        value={productCatalogId && productRetailerId ? `${productCatalogId}::${productRetailerId}` : ""}
                        onChange={(e) => {
                          const [catalogId, retailerId] = e.target.value.split("::");
                          setProductCatalogId(catalogId ?? "");
                          setProductRetailerId(retailerId ?? "");
                        }}
                        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      >
                        <option value="">{t("inbox.productPicker")}</option>
                        {[...new Set(accountProducts.map((p) => p.catalogId))].map((catalogId) => (
                          <optgroup key={catalogId} label={catalogId}>
                            {accountProducts.filter((p) => p.catalogId === catalogId).map((p) => (
                              <option key={p.id} value={`${p.catalogId}::${p.retailerId}`}>
                                {p.name} ({p.retailerId})
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <input
                        value={productCatalogId}
                        onChange={(e) => setProductCatalogId(e.target.value)}
                        placeholder={t("flows.rich.catalogId")}
                        className="w-44 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                      <input
                        value={productRetailerId}
                        onChange={(e) => setProductRetailerId(e.target.value)}
                        placeholder={t("flows.rich.productId")}
                        className="w-44 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </div>
                )}
                </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Contacts

/** Tag editor: chips with per-chip remove + an add input (Enter/comma). */
function TagChipEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const add = () => {
    const value = draft.trim().replace(/,+$/, "");
    if (value && !tags.includes(value)) onChange([...tags, value]);
    setDraft("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <span key={tag} className={`${chipCls} inline-flex items-center gap-1`}>
            {tag}
            <button
              type="button"
              aria-label={`remove ${tag}`}
              onClick={() => onChange(tags.filter((x) => x !== tag))}
              className="leading-none text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
        }}
        onBlur={add}
        placeholder={t("contacts.tagPlaceholder")}
        className={`mt-2 ${inputCls}`}
      />
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{t("contacts.tagsHint")}</p>
    </div>
  );
}

/**
 * Shared contact editor (F1): name, tags, and custom fields as editable
 * key/value rows — the imported `field:` data used to be write-only.
 * Used by the Contacts table and the Inbox conversation header; saving
 * goes through PATCH /contacts/{id} (custom fields merge key-wise, so
 * removing a row here does not delete that key server-side).
 */
function ContactEditModal({
  contact,
  onClose,
  onSaved,
}: {
  contact: Contact;
  onClose: () => void;
  onSaved: (updated: Contact) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(contact.displayName ?? "");
  const [tags, setTags] = useState<string[]>(contact.tags ?? []);
  const [fields, setFields] = useState<Array<{ key: string; value: string }>>(() =>
    Object.entries(contact.customFields ?? {}).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    })),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setBusy(true);
    try {
      const customFields: Record<string, unknown> = {};
      for (const row of fields) {
        const key = row.key.trim();
        if (key) customFields[key] = row.value;
      }
      const res = await api.updateContact(contact.id, {
        displayName: name.trim() ? name.trim() : null,
        tags,
        customFields,
      });
      pushToast("ok", t("contacts.saved"));
      onSaved(res.contact);
      onClose();
    } catch (err) {
      pushToast("err", errText(err, t("contacts.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("contacts.editTitle")}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold">{t("contacts.editTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="-mr-1 -mt-1 rounded-full px-2.5 py-1 text-lg leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            ×
          </button>
        </div>
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {contact.channel} · {contact.externalId}
        </div>
        <div className="mt-4 space-y-4">
          <div>
            <label className={labelCls}>{t("common.name")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t("contacts.tags")}</label>
            <TagChipEditor tags={tags} onChange={setTags} />
          </div>
          <div>
            <label className={labelCls}>{t("contacts.customFields")}</label>
            <div className="space-y-2">
              {fields.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={row.key}
                    onChange={(e) => setFields((prev) => prev.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                    placeholder={t("contacts.fieldKeyPlaceholder")}
                    className="w-2/5 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <input
                    value={row.value}
                    onChange={(e) => setFields((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    placeholder={t("contacts.fieldValuePlaceholder")}
                    className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={() => setFields((prev) => prev.filter((_, j) => j !== i))}
                    className="text-xs text-red-600 underline dark:text-red-400"
                  >
                    {t("common.remove")}
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setFields((prev) => [...prev, { key: "", value: "" }])}
                className="text-xs text-slate-600 underline dark:text-slate-300"
              >
                {t("contacts.addField")}
              </button>
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={outlineBtn}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void save()} disabled={busy} className={primaryBtn}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Manual add-contact form (F3): channel + external ID, optional name/tags. */
function ContactAddModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t } = useI18n();
  const [channel, setChannel] = useState<string>("whatsapp");
  const [externalId, setExternalId] = useState("");
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setBusy(true);
    try {
      await api.createContact({
        channel,
        externalId: externalId.trim(),
        ...(name.trim() ? { displayName: name.trim() } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      });
      pushToast("ok", t("contacts.added"));
      onAdded();
      onClose();
    } catch (err) {
      pushToast("err", errText(err, t("contacts.addFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("contacts.addTitle")}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold">{t("contacts.addTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="-mr-1 -mt-1 rounded-full px-2.5 py-1 text-lg leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            ×
          </button>
        </div>
        <div className="mt-4 space-y-4">
          <div>
            <label className={labelCls}>{t("common.channel")}</label>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={inputCls}>
              {CONTACT_CHANNELS.map((ch) => (
                <option key={ch} value={ch}>{channelMeta(ch).label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t("contacts.externalId")}</label>
            <input
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              placeholder={t("contacts.externalIdPlaceholder")}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>{t("common.name")}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("contacts.namePlaceholder")}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>{t("contacts.tags")}</label>
            <TagChipEditor tags={tags} onChange={setTags} />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={outlineBtn}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void submit()} disabled={busy || !externalId.trim()} className={primaryBtn}>
            {busy ? t("common.saving") : t("contacts.addButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ContactsPage() {
  const { t } = useI18n();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Segments (F8): tag chips with per-tag contact counts from GET /segments.
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  // Contact editing (F1) + manual add (F3).
  const [editing, setEditing] = useState<Contact | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  // Import/export (adopted features).
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<"csv" | "json">("csv");
  const [importConflict, setImportConflict] = useState<"skip" | "update">("skip");
  const [importResult, setImportResult] = useState<ContactImportResult | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  const load = useCallback(async (filterTag: string) => {
    try {
      const data = await api.listContacts(filterTag || undefined);
      setContacts(data.contacts);
      setError(null);
    } catch (err) {
      setError(errText(err, t("contacts.loadFailed")));
    }
  }, [t]);

  const loadSegments = useCallback(async () => {
    try {
      const data = await api.listSegments();
      setSegments(data.segments);
    } catch { /* segment chips are an assist; the free-text filter still works */ }
  }, []);

  useEffect(() => { void load(""); }, [load]);
  useEffect(() => { void loadSegments(); }, [loadSegments]);

  const pickSegment = (next: string) => {
    setTag(next);
    void load(next);
  };

  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    setImportText(await file.text());
    setImportFormat(file.name.toLowerCase().endsWith(".json") ? "json" : "csv");
  };

  const runImport = async () => {
    setImportBusy(true);
    setImportResult(null);
    setError(null);
    try {
      const res = await api.importContacts({ format: importFormat, content: importText, conflict: importConflict });
      setImportResult(res);
      await load(tag);
    } catch (err) {
      setError(errText(err, t("contacts.importFailed")));
    } finally { setImportBusy(false); }
  };

  const runExport = async (format: "csv" | "json") => {
    setExportBusy(true);
    setError(null);
    try {
      const text = await api.exportContacts(format);
      downloadTextFile(`contacts.${format}`, text, format === "csv" ? "text/csv" : "application/json");
    } catch (err) {
      setError(errText(err, t("contacts.exportFailed")));
    } finally { setExportBusy(false); }
  };

  return (
    <div>
      <PageTitle title={t("contacts.title")} subtitle={t("contacts.subtitle")} />
      <div className="mt-4 flex flex-wrap gap-2">
        <div className="flex gap-2 max-w-md flex-1 min-w-64">
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder={t("contacts.filterPlaceholder")}
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <button onClick={() => void load(tag)} className={primaryBtn}>{t("common.filter")}</button>
        </div>
        <button onClick={() => setShowImport((v) => !v)} className={outlineBtn}>{t("contacts.import")}</button>
        <button onClick={() => void runExport("csv")} disabled={exportBusy} className={outlineBtn}>{t("contacts.exportCsv")}</button>
        <button onClick={() => void runExport("json")} disabled={exportBusy} className={outlineBtn}>{t("contacts.exportJson")}</button>
        <button onClick={() => setShowAdd(true)} className={primaryBtn}>{t("contacts.addButton")}</button>
      </div>
      {segments.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t("contacts.segmentsLabel")}:</span>
          <button
            onClick={() => pickSegment("")}
            className={tag === "" ? "text-xs px-2 py-0.5 rounded-full bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : chipCls}
          >
            {t("contacts.allContacts")}
          </button>
          {segments.map((s) => (
            <button
              key={s.tag}
              onClick={() => pickSegment(s.tag)}
              className={tag === s.tag ? "text-xs px-2 py-0.5 rounded-full bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : chipCls}
            >
              {s.tag} · {s.contactCount}
            </button>
          ))}
        </div>
      )}
      {showImport && (
        <div className={`mt-4 ${cardCls} p-4 space-y-3 max-w-3xl`}>
          <div className="font-medium text-sm">{t("contacts.importTitle")}</div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("contacts.importHint")}</p>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              type="file"
              accept=".csv,.json,text/csv,application/json"
              onChange={(e) => void onImportFile(e.target.files?.[0])}
              className="text-sm"
            />
            <select value={importFormat} onChange={(e) => setImportFormat(e.target.value as "csv" | "json")} className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
            <select value={importConflict} onChange={(e) => setImportConflict(e.target.value as "skip" | "update")} className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
              <option value="skip">{t("contacts.conflictSkip")}</option>
              <option value="update">{t("contacts.conflictUpdate")}</option>
            </select>
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={6}
            placeholder={t("contacts.importPlaceholder")}
            className={`${inputCls} font-mono text-xs`}
          />
          <button onClick={() => void runImport()} disabled={importBusy || !importText.trim()} className={primaryBtn}>
            {importBusy ? t("common.sending") : t("contacts.importRun")}
          </button>
          {importResult && (
            <div className="rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700">
              <div>
                {t("contacts.importSummary", {
                  inserted: String(importResult.inserted),
                  updated: String(importResult.updated),
                  skipped: String(importResult.skipped),
                })}
              </div>
              {importResult.errors.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs text-red-600 dark:text-red-400">
                  {importResult.errors.slice(0, 20).map((e, i) => (
                    <li key={i}>{t("contacts.importRowError", { row: String(e.row), message: e.message })}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      {error && <div className="mt-4"><ErrorBox error={error} /></div>}
      <div className={`mt-4 ${cardCls} overflow-hidden`}>
        {contacts.length === 0 && !error ? (
          <div className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
            {t("contacts.empty")}{tag ? t("contacts.emptyWithTag", { tag }) : ""}.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">{t("common.name")}</th>
                <th className="px-4 py-2 font-medium">{t("common.channel")}</th>
                <th className="px-4 py-2 font-medium">{t("contacts.externalId")}</th>
                <th className="px-4 py-2 font-medium">{t("contacts.tags")}</th>
                <th className="px-4 py-2 font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((ct) => (
                <tr key={ct.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2">{ct.displayName ?? "-"}</td>
                  <td className="px-4 py-2">{ct.channel}</td>
                  <td className="px-4 py-2">{ct.externalId}</td>
                  <td className="px-4 py-2">
                    <span className="flex gap-1 flex-wrap">
                      {(ct.tags ?? []).map((tg) => (
                        <span key={tg} className={chipCls}>{tg}</span>
                      ))}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <button onClick={() => setEditing(ct)} className="text-xs text-slate-600 underline dark:text-slate-300">
                      {t("common.edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <ContactEditModal
          contact={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
            void loadSegments();
          }}
        />
      )}
      {showAdd && (
        <ContactAddModal
          onClose={() => setShowAdd(false)}
          onAdded={() => { void load(tag); void loadSegments(); }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------- Broadcast

function BroadcastPage() {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  // Template body parameters (variables #1): ordered param templates,
  // each rendered per recipient at send time. Inputs are ref-tracked so
  // the variable picker inserts at the caret of the focused row.
  const [templateParams, setTemplateParams] = useState<string[]>([]);
  const paramInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [channelAccountId, setChannelAccountId] = useState("");
  const [recipients, setRecipients] = useState(100);
  const [country, setCountry] = useState("ID");
  const [estimate, setEstimate] = useState<BroadcastEstimate | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Broadcast history (F5): list + expandable detail from GET /broadcasts.
  const [broadcasts, setBroadcasts] = useState<BroadcastSummary[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [detail, setDetail] = useState<BroadcastDetail | null>(null);
  // Per-recipient delivery records (package #4): rows for the open
  // detail, per-status counts for the WHOLE broadcast, active filter.
  const [recipientRows, setRecipientRows] = useState<BroadcastRecipient[]>([]);
  const [recipientCounts, setRecipientCounts] = useState<BroadcastRecipientCounts | null>(null);
  const [recipientStatusFilter, setRecipientStatusFilter] = useState("");
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  // Template manager (F6): register form + per-template category drafts.
  const [waAccounts, setWaAccounts] = useState<ChannelAccount[]>([]);
  const [tplAccountId, setTplAccountId] = useState("");
  const [tplName, setTplName] = useState("");
  const [tplLanguage, setTplLanguage] = useState("id");
  const [tplCategory, setTplCategory] = useState("marketing");
  const [tplExternalId, setTplExternalId] = useState("");
  const [tplBusy, setTplBusy] = useState(false);
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({});

  const loadTemplates = useCallback(async () => {
    try {
      const data = await api.listTemplates();
      setTemplates(data.templates);
    } catch { /* template list is optional for the estimate flow */ }
  }, []);

  const loadBroadcasts = useCallback(async () => {
    try {
      const data = await api.listBroadcasts();
      setBroadcasts(data.broadcasts);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(errText(err, t("broadcast.historyLoadFailed")));
    }
  }, [t]);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);
  useEffect(() => { void loadBroadcasts(); }, [loadBroadcasts]);
  useEffect(() => {
    api.listChannelAccounts()
      .then((data) => setWaAccounts(data.accounts.filter((a) => a.channel === "whatsapp")))
      .catch(() => { /* selectors degrade to empty lists */ });
  }, []);

  const loadRecipients = useCallback(async (broadcastId: string, status: string) => {
    try {
      const page = await api.listBroadcastRecipients(broadcastId, status || undefined);
      setRecipientRows(page.recipients);
      setRecipientCounts(page.counts);
      setRecipientError(null);
    } catch (err) {
      setRecipientError(errText(err, t("broadcast.historyLoadFailed")));
    }
  }, [t]);

  const openDetail = async (id: string) => {
    if (detail?.id === id) { setDetail(null); return; }
    try {
      const res = await api.getBroadcast(id);
      // The API returns the cost report as SIBLING fields of the
      // broadcast row, not on it - merge them in so the detail matches
      // its declared BroadcastDetail shape (totalCostUsd & friends
      // were undefined at runtime before this).
      setDetail({
        ...res.broadcast,
        totalCostUsd: res.totalCostUsd,
        costEntries: res.costEntries,
        costUnits: res.costUnits,
      });
      setRecipientStatusFilter("");
      void loadRecipients(id, "");
    } catch (err) {
      pushToast("err", errText(err, t("broadcast.historyLoadFailed")));
    }
  };

  const resendFailed = async () => {
    if (!detail || !recipientCounts || recipientCounts.failed === 0) return;
    if (!window.confirm(t("broadcast.resendConfirm", { count: recipientCounts.failed }))) return;
    setResendBusy(true);
    try {
      const res = await api.resendBroadcastFailed(detail.id);
      pushToast("ok", t("broadcast.resent", { count: res.resent }));
      await loadRecipients(detail.id, recipientStatusFilter);
      await loadBroadcasts();
    } catch (err) {
      pushToast("err", errText(err, t("broadcast.resendError")));
    } finally {
      setResendBusy(false);
    }
  };

  const registerTemplate = async () => {
    setTplBusy(true);
    try {
      const accountId = tplAccountId || channelAccountId;
      const res = await api.createTemplate({
        channelAccountId: accountId,
        name: tplName.trim(),
        language: tplLanguage.trim() || undefined,
        category: tplCategory,
        ...(tplExternalId.trim() ? { externalId: tplExternalId.trim() } : {}),
      });
      setTemplates((prev) => [...prev, res.template]);
      setTplName("");
      setTplExternalId("");
      pushToast("ok", t("broadcast.templateRegistered"));
    } catch (err) {
      pushToast("err", errText(err, t("broadcast.templateRegisterFailed")));
    } finally {
      setTplBusy(false);
    }
  };

  const correctCategory = async (tpl: Template) => {
    const latestCategory = categoryDrafts[tpl.id] ?? tpl.latestCategory ?? tpl.category ?? "marketing";
    try {
      const res = await api.updateTemplateCategory(tpl.id, latestCategory);
      setTemplates((prev) => prev.map((x) => (x.id === tpl.id ? res.template : x)));
      pushToast("ok", t("broadcast.templateCategoryUpdated"));
    } catch (err) {
      pushToast("err", errText(err, t("broadcast.templateCategoryFailed")));
    }
  };

  const selectedTemplate = templates.find((tpl) => tpl.id === templateId);
  const category = (selectedTemplate?.latestCategory ?? selectedTemplate?.category ?? "marketing").toLowerCase();

  const doEstimate = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api.estimateBroadcast({
        category,
        countryMix: [{ country: country.toUpperCase(), recipients }],
      });
      setEstimate(data);
    } catch (err) {
      setError(errText(err, t("broadcast.estimateFailed")));
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    const cleanedParams = templateParams.map((p) => p.trim());
    if (templateId && cleanedParams.some((p) => p.length === 0)) {
      setError(t("templateParams.blank"));
      return;
    }
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const data = await api.createBroadcast({
        channelAccountId,
        templateId: templateId || undefined,
        ...(templateId && cleanedParams.length > 0 ? { templateParams: cleanedParams } : {}),
        country: country.toUpperCase(),
        recipientCount: recipients,
      });
      setCreated(t("broadcast.created", { id: data.broadcast.id, status: data.broadcast.status }));
      void loadBroadcasts();
    } catch (err) {
      setError(errText(err, t("broadcast.createFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageTitle title={t("broadcast.title")} subtitle={t("broadcast.subtitle", { version: estimate?.ratesVersion ?? "sample-2026-q4" })} />
      {error && <div className="mt-4 max-w-xl"><ErrorBox error={error} /></div>}
      {created && <div className="mt-4 max-w-xl"><NoticeBox>{created}</NoticeBox></div>}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
        <div>
          <label className={labelCls}>{t("broadcast.template")}</label>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={inputCls}>
            <option value="">{t("broadcast.templatePlaceholder")}</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>{tpl.name} ({tpl.language}) · {tpl.latestCategory ?? tpl.category ?? "-"}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{t("broadcast.accountId")}</label>
          <select value={channelAccountId} onChange={(e) => setChannelAccountId(e.target.value)} className={inputCls}>
            <option value="">{t("broadcast.accountPlaceholder")}</option>
            {waAccounts.filter((a) => a.status === "connected").map((a) => (
              <option key={a.id} value={a.id}>{a.displayName ?? a.externalId}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{t("broadcast.recipients")}</label>
          <input type="number" min={1} value={recipients} onChange={(e) => setRecipients(Number(e.target.value))} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>{t("broadcast.country")}</label>
          <input value={country} onChange={(e) => setCountry(e.target.value)} className={inputCls} />
        </div>
      </div>
      {templateId && (
        <div className="mt-4 max-w-3xl">
          <label className={labelCls}>{t("templateParams.label")}</label>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">{t("templateParams.hint")}</p>
          <div className="space-y-2">
            {templateParams.map((param, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-8 text-xs text-slate-400">{`{{${i + 1}}}`}</span>
                <input
                  ref={(el) => { paramInputRefs.current[i] = el; }}
                  value={param}
                  onChange={(e) => setTemplateParams((prev) => prev.map((p, idx) => (idx === i ? e.target.value : p)))}
                  placeholder={t("templateParams.placeholder")}
                  className={inputCls}
                />
                <VariablePicker target={() => paramInputRefs.current[i] ?? null} />
                <button
                  onClick={() => setTemplateParams((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-xs text-red-600 underline dark:text-red-400"
                >
                  {t("templateParams.remove")}
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={() => setTemplateParams((prev) => [...prev, ""])}
            className="mt-2 text-xs text-slate-600 underline dark:text-slate-300"
          >
            {t("templateParams.add")}
          </button>
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <button onClick={() => void doEstimate()} disabled={busy} className={primaryBtn}>{t("broadcast.estimateButton")}</button>
        <button onClick={() => void doCreate()} disabled={busy || !channelAccountId} className={outlineBtn}>{t("broadcast.createButton")}</button>
      </div>
      {estimate && (
        <div className={`mt-6 max-w-3xl ${cardCls} p-4`}>
          <div className="font-medium text-sm">{t("broadcast.estimateTitle")}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {t("broadcast.estimateMeta", { version: estimate.ratesVersion, date: estimate.ratesEffectiveDate, total: estimate.totalRecipients })}
          </div>
          <table className="w-full text-sm mt-3">
            <thead className="text-left text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-1 font-medium">{t("broadcast.colCountry")}</th>
                <th className="py-1 font-medium">{t("broadcast.colCategory")}</th>
                <th className="py-1 font-medium">{t("broadcast.colBillable")}</th>
                <th className="py-1 font-medium">{t("broadcast.colRate")}</th>
                <th className="py-1 font-medium">{t("broadcast.colSubtotal")}</th>
              </tr>
            </thead>
            <tbody>
              {estimate.lines.map((line, i) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1">{line.country}</td>
                  <td className="py-1">{line.category}</td>
                  <td className="py-1">{line.billable}</td>
                  <td className="py-1">${line.rateUsd.toFixed(4)}</td>
                  <td className="py-1">${line.subtotalUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 text-sm font-semibold">{t("broadcast.total")}: ${estimate.totalUsd.toFixed(4)}</div>
        </div>
      )}
      <div className={`mt-8 max-w-3xl ${cardCls} p-4`}>
        <div className="font-medium text-sm">{t("broadcast.historyTitle")}</div>
        {historyError && <div className="mt-3"><ErrorBox error={historyError} /></div>}
        {broadcasts.length === 0 && !historyError ? (
          <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t("broadcast.historyEmpty")}</div>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-1 font-medium">{t("broadcast.colName")}</th>
                <th className="py-1 font-medium">{t("common.status")}</th>
                <th className="py-1 font-medium">{t("broadcast.colDelivery")}</th>
                <th className="py-1 font-medium">{t("broadcast.colCost")}</th>
                <th className="py-1 font-medium">{t("broadcast.colCreated")}</th>
              </tr>
            </thead>
            <tbody>
              {broadcasts.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => void openDetail(b.id)}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
                >
                  <td className="py-1.5">{b.name ?? t("broadcast.unnamed")}</td>
                  <td className="py-1.5">{b.status}</td>
                  <td className="py-1.5">{b.sentCount}/{b.recipientCount}{b.failedCount > 0 ? ` · ${b.failedCount} ${t("broadcast.failedLabel").toLowerCase()}` : ""}</td>
                  <td className="py-1.5">{formatUsd(broadcastCostUsd(b))}</td>
                  <td className="py-1.5">{fmtDateTime(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {detail && (
          <div className="mt-3 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700">
            <div className="font-medium">{detail.name ?? t("broadcast.unnamed")} · {detail.status}</div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
              <div><dt className="text-slate-500 dark:text-slate-400">{t("broadcast.recipientsLabel")}</dt><dd>{detail.recipientCount}</dd></div>
              <div><dt className="text-slate-500 dark:text-slate-400">{t("broadcast.sentLabel")}</dt><dd>{detail.sentCount}</dd></div>
              <div><dt className="text-slate-500 dark:text-slate-400">{t("broadcast.failedLabel")}</dt><dd>{detail.failedCount}</dd></div>
              <div><dt className="text-slate-500 dark:text-slate-400">{t("broadcast.estimatedCost")}</dt><dd>{formatUsd(detail.estimatedCostUsd)}</dd></div>
              <div><dt className="text-slate-500 dark:text-slate-400">{t("broadcast.actualCost")}</dt><dd>{formatUsd(detail.totalCostUsd)}</dd></div>
              <div><dt className="text-slate-500 dark:text-slate-400">{t("broadcast.costEntries")}</dt><dd>{detail.costEntries} · {detail.costUnits} units</dd></div>
              {detail.tag && <div><dt className="text-slate-500 dark:text-slate-400">{t("broadcast.tagLabel")}</dt><dd>{detail.tag}</dd></div>}
              {detail.country && <div><dt className="text-slate-500 dark:text-slate-400">{t("broadcast.colCountry")}</dt><dd>{detail.country}</dd></div>}
              {detail.templateParams && detail.templateParams.length > 0 && (
                <div><dt className="text-slate-500 dark:text-slate-400">{t("templateParams.detailLabel")}</dt><dd>{detail.templateParams.join(" · ")}</dd></div>
              )}
            </dl>
            <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{t("broadcast.recipientsTitle")}</div>
                {recipientCounts && recipientCounts.failed > 0 && (
                  <button onClick={() => void resendFailed()} disabled={resendBusy} className={outlineBtn}>
                    {t("broadcast.resendFailed")} ({recipientCounts.failed})
                  </button>
                )}
              </div>
              {recipientError && <div className="mt-2"><ErrorBox error={recipientError} /></div>}
              {recipientCounts && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    onClick={() => { setRecipientStatusFilter(""); void loadRecipients(detail.id, ""); }}
                    className={recipientStatusFilter === "" ? chipBtnActive : chipBtn}
                  >
                    {t("broadcast.filterAll")} · {recipientCounts.total}
                  </button>
                  {RECIPIENT_STATUSES.map((status) => (
                    <button
                      key={status}
                      onClick={() => { setRecipientStatusFilter(status); void loadRecipients(detail.id, status); }}
                      className={recipientStatusFilter === status ? chipBtnActive : chipBtn}
                    >
                      {t(`broadcast.recipientStatus.${status}`)} · {recipientCounts[status]}
                    </button>
                  ))}
                </div>
              )}
              {recipientRows.length === 0 && !recipientError ? (
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t("broadcast.recipientsEmpty")}</div>
              ) : (
                <table className="mt-3 w-full text-xs">
                  <thead className="text-left text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="py-1 font-medium">{t("broadcast.colContact")}</th>
                      <th className="py-1 font-medium">{t("common.status")}</th>
                      <th className="py-1 font-medium">{t("broadcast.colTimeline")}</th>
                      <th className="py-1 font-medium">{t("broadcast.colError")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipientRows.map((row) => (
                      <tr key={row.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                        <td className="py-1.5">
                          <div>{row.contactDisplayName}</div>
                          <div className="text-slate-400">{row.contactExternalId}</div>
                        </td>
                        <td className="py-1.5">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] ${recipientStatusTone(row.status)}`}>
                            {t(`broadcast.recipientStatus.${row.status}` as I18nKey)}
                          </span>
                        </td>
                        <td className="py-1.5">
                          {recipientTimeline(row).map((stamp) => (
                            <div key={stamp.status}>
                              {t(`broadcast.recipientStatus.${stamp.status}`)}: {fmtDateTime(stamp.at)}
                            </div>
                          ))}
                        </td>
                        <td className="py-1.5 text-red-600 dark:text-red-400">{row.status === "failed" ? row.error ?? "" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
      <div className={`mt-6 max-w-3xl ${cardCls} p-4`}>
        <div className="font-medium text-sm">{t("broadcast.templatesTitle")}</div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("broadcast.templatesHint")}</p>
        {templates.length === 0 ? (
          <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t("broadcast.templatesEmpty")}</div>
        ) : (
          <div className="mt-3 space-y-2">
            {templates.map((tpl) => (
              <div key={tpl.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
                <span className="font-medium">{tpl.name}</span>
                <span className={chipCls}>{tpl.language}</span>
                <span className={chipCls}>{tpl.latestCategory ?? tpl.category ?? "-"}</span>
                <span className={chipCls}>{tpl.status}</span>
                <span className="ml-auto flex items-center gap-2">
                  <label className="text-xs text-slate-500 dark:text-slate-400">{t("broadcast.correctCategory")}</label>
                  <select
                    value={categoryDrafts[tpl.id] ?? tpl.latestCategory ?? tpl.category ?? "marketing"}
                    onChange={(e) => setCategoryDrafts((prev) => ({ ...prev, [tpl.id]: e.target.value }))}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <option value="marketing">marketing</option>
                    <option value="utility">utility</option>
                    <option value="authentication">authentication</option>
                  </select>
                  <button onClick={() => void correctCategory(tpl)} className="text-xs text-slate-600 underline dark:text-slate-300">
                    {t("common.save")}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>{t("broadcast.templateAccount")}</label>
            {waAccounts.length > 0 ? (
              <select value={tplAccountId} onChange={(e) => setTplAccountId(e.target.value)} className={inputCls}>
                <option value="">-</option>
                {waAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.displayName ?? a.externalId}</option>
                ))}
              </select>
            ) : (
              <input value={tplAccountId} onChange={(e) => setTplAccountId(e.target.value)} placeholder={t("broadcast.accountIdPlaceholder")} className={inputCls} />
            )}
          </div>
          <div>
            <label className={labelCls}>{t("broadcast.templateName")}</label>
            <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder={t("broadcast.templateNamePlaceholder")} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t("broadcast.templateLanguage")}</label>
            <input value={tplLanguage} onChange={(e) => setTplLanguage(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t("broadcast.templateCategory")}</label>
            <select value={tplCategory} onChange={(e) => setTplCategory(e.target.value)} className={inputCls}>
              <option value="marketing">marketing</option>
              <option value="utility">utility</option>
              <option value="authentication">authentication</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>{t("broadcast.templateExternalId")}</label>
            <input value={tplExternalId} onChange={(e) => setTplExternalId(e.target.value)} className={inputCls} />
          </div>
        </div>
        <button
          onClick={() => void registerTemplate()}
          disabled={tplBusy || !tplName.trim() || !(tplAccountId || channelAccountId)}
          className={`mt-3 ${primaryBtn}`}
        >
          {t("broadcast.registerTemplate")}
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- Publish

/** ISO instant -> the `datetime-local` input value in local time. */
const toLocalInputValue = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function PublishPage() {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Telegram publish destinations (item H): per selected telegram
  // account, the channel chat the bot posts to (required by the API).
  const [telegramTargets, setTelegramTargets] = useState<Record<string, string>>({});
  // Edit flow (F10): a prefilled copy of the create form for one post.
  const [editingPost, setEditingPost] = useState<ScheduledPost | null>(null);
  const [editText, setEditText] = useState("");
  const [editMediaUrl, setEditMediaUrl] = useState("");
  const [editScheduledAt, setEditScheduledAt] = useState("");
  const [editSelected, setEditSelected] = useState<Set<string>>(new Set());
  const [editTelegramTargets, setEditTelegramTargets] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [acc, pst] = await Promise.all([api.listChannelAccounts(), api.listPosts()]);
      setAccounts(acc.accounts);
      setPosts(pst.posts);
      setError(null);
    } catch (err) {
      setError(errText(err, t("publish.loadFailed")));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const publishable = accounts.filter((a) => ["instagram", "threads", "messenger", "telegram"].includes(a.channel));
  const accountLabel = (id: string) => {
    const acc = accounts.find((a) => a.id === id);
    return acc ? `${acc.channel} · ${acc.displayName ?? acc.externalId}` : id;
  };

  const toggleIn = (setter: Dispatch<SetStateAction<Set<string>>>) => (id: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggle = toggleIn(setSelected);
  const toggleEdit = toggleIn(setEditSelected);

  /**
   * Build API targets from a selection: telegram accounts additionally
   * carry their channel-chat destination (item H). Returns null when a
   * selected telegram target has no destination yet.
   */
  const buildTargets = (
    ids: Set<string>,
    destinations: Record<string, string>,
  ): Array<{ channelAccountId: string; targetExternalId?: string }> | null => {
    const targets: Array<{ channelAccountId: string; targetExternalId?: string }> = [];
    for (const id of ids) {
      const acc = accounts.find((a) => a.id === id);
      if (acc?.channel === "telegram") {
        const dest = (destinations[id] ?? "").trim();
        if (!dest) return null;
        targets.push({ channelAccountId: id, targetExternalId: dest });
      } else {
        targets.push({ channelAccountId: id });
      }
    }
    return targets;
  };

  /** One destination input per selected telegram account (item H). */
  const telegramInputs = (
    ids: Set<string>,
    values: Record<string, string>,
    setValues: Dispatch<SetStateAction<Record<string, string>>>,
  ) => {
    const telegramIds = [...ids].filter((id) => accounts.find((a) => a.id === id)?.channel === "telegram");
    if (telegramIds.length === 0) return null;
    return (
      <div className="space-y-3">
        {telegramIds.map((id) => (
          <div key={id}>
            <label className={labelCls}>{t("publish.telegramTargetLabel")} · {accountLabel(id)}</label>
            <input
              value={values[id] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [id]: e.target.value }))}
              placeholder="@yourchannel or -1001234567890"
              className={inputCls}
            />
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{t("publish.telegramTargetHelp")}</p>
          </div>
        ))}
      </div>
    );
  };

  const create = async () => {
    const targets = buildTargets(selected, telegramTargets);
    if (!targets) {
      setError(t("publish.telegramTargetRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createPost({
        text: text.trim() || undefined,
        mediaUrls: mediaUrl.trim() ? [mediaUrl.trim()] : undefined,
        targets,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      });
      setText("");
      setMediaUrl("");
      setTelegramTargets({});
      setNotice(scheduledAt ? t("publish.scheduledNotice") : t("publish.draftNotice"));
      setScheduledAt("");
      await load();
    } catch (err) {
      setError(errText(err, t("publish.createFailed")));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (post: ScheduledPost) => {
    setEditingPost(post);
    setEditText(post.text ?? "");
    setEditMediaUrl(post.mediaUrls[0] ?? "");
    setEditScheduledAt(post.scheduledAt ? toLocalInputValue(post.scheduledAt) : "");
    setEditSelected(new Set(post.targets.map((tg) => tg.channelAccountId)));
    setEditTelegramTargets(Object.fromEntries(
      post.targets.filter((tg) => tg.targetExternalId).map((tg) => [tg.channelAccountId, tg.targetExternalId!]),
    ));
    setError(null);
  };

  const saveEdit = async () => {
    if (!editingPost) return;
    const targets = buildTargets(editSelected, editTelegramTargets);
    if (!targets) {
      setError(t("publish.telegramTargetRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updatePost(editingPost.id, {
        text: editText,
        mediaUrls: editMediaUrl.trim() ? [editMediaUrl.trim()] : [],
        targets,
        scheduledAt: editScheduledAt ? new Date(editScheduledAt).toISOString() : null,
      });
      pushToast("ok", t("publish.updated"));
      setEditingPost(null);
      await load();
    } catch (err) {
      pushToast("err", errText(err, t("publish.updateFailed")));
    } finally {
      setBusy(false);
    }
  };

  const publishNow = async (post: ScheduledPost) => {
    setBusy(true);
    setError(null);
    try {
      await api.publishPostNow(post.id);
      setNotice(t("publish.queuedNotice"));
      await load();
    } catch (err) {
      setError(errText(err, t("publish.publishFailed")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (post: ScheduledPost) => {
    setBusy(true);
    try {
      await api.deletePost(post.id);
      await load();
    } catch (err) {
      setError(errText(err, t("publish.deleteFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageTitle title={t("publish.title")} subtitle={t("publish.subtitle")} />
      {error && <div className="mt-4 max-w-3xl"><ErrorBox error={error} /></div>}
      {notice && <div className="mt-4 max-w-3xl"><NoticeBox>{notice}</NoticeBox></div>}

      <div className={`mt-6 max-w-3xl ${cardCls} p-4 space-y-4`}>
        <div>
          <label className={labelCls}>{t("publish.content")}</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={t("publish.contentPlaceholder")} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>{t("publish.mediaUrl")}</label>
          <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://media.example.com/photo.jpg" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>{t("publish.targets")}</label>
          {publishable.length === 0 ? (
            <div className="text-sm text-slate-400 dark:text-slate-500">{t("publish.noTargets")}</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {publishable.map((acc) => (
                <label key={acc.id} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm cursor-pointer ${selected.has(acc.id)
                  ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                  : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
                  <input type="checkbox" checked={selected.has(acc.id)} onChange={() => toggle(acc.id)} className="hidden" />
                  {acc.channel} · {acc.displayName ?? acc.externalId}
                </label>
              ))}
            </div>
          )}
        </div>
        {telegramInputs(selected, telegramTargets, setTelegramTargets)}
        <div className="max-w-xs">
          <label className={labelCls}>{t("publish.schedule")}</label>
          <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className={inputCls} />
        </div>
        <button onClick={() => void create()} disabled={busy || selected.size === 0 || (!text.trim() && !mediaUrl.trim())} className={primaryBtn}>
          {scheduledAt ? t("publish.scheduleButton") : t("publish.draftButton")}
        </button>
      </div>

      {editingPost && (
        <div className={`mt-6 max-w-3xl ${cardCls} p-4 space-y-4`}>
          <div className="font-medium text-sm">{t("publish.editTitle")}</div>
          <div>
            <label className={labelCls}>{t("publish.content")}</label>
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} placeholder={t("publish.contentPlaceholder")} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t("publish.mediaUrl")}</label>
            <input value={editMediaUrl} onChange={(e) => setEditMediaUrl(e.target.value)} placeholder="https://media.example.com/photo.jpg" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t("publish.targets")}</label>
            <div className="flex flex-wrap gap-2">
              {publishable.map((acc) => (
                <label key={acc.id} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm cursor-pointer ${editSelected.has(acc.id)
                  ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                  : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
                  <input type="checkbox" checked={editSelected.has(acc.id)} onChange={() => toggleEdit(acc.id)} className="hidden" />
                  {acc.channel} · {acc.displayName ?? acc.externalId}
                </label>
              ))}
            </div>
          </div>
          {telegramInputs(editSelected, editTelegramTargets, setEditTelegramTargets)}
          <div className="max-w-xs">
            <label className={labelCls}>{t("publish.schedule")}</label>
            <input type="datetime-local" value={editScheduledAt} onChange={(e) => setEditScheduledAt(e.target.value)} className={inputCls} />
          </div>
          <div className="flex gap-2">
            <button onClick={() => void saveEdit()} disabled={busy || editSelected.size === 0} className={primaryBtn}>
              {busy ? t("common.saving") : t("common.save")}
            </button>
            <button onClick={() => setEditingPost(null)} disabled={busy} className={outlineBtn}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 max-w-3xl space-y-3">
        <div className="font-medium text-sm">{t("publish.listTitle")}</div>
        {posts.length === 0 && !error && <EmptyState>{t("publish.empty")}</EmptyState>}
        {posts.map((post) => (
          <div key={post.id} className={`${cardCls} p-4`}>
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm whitespace-pre-wrap">{post.text ?? <em className="text-slate-400">{t("publish.noText")}</em>}</div>
              <span className={`shrink-0 ${chipCls}`}>{post.status}</span>
            </div>
            {post.mediaUrls.length > 0 && (
              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 break-all">{post.mediaUrls.join(", ")}</div>
            )}
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {post.scheduledAt ? t("publish.scheduledFor", { date: new Date(post.scheduledAt).toLocaleString() }) : t("publish.draftManual")}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {post.targets.map((target) => {
                const result = post.results[target.channelAccountId];
                return (
                  <span key={target.channelAccountId} className={`text-xs px-2 py-1 rounded-md border ${result?.status === "sent"
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                    : result?.status === "failed"
                      ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                      : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}>
                    {accountLabel(target.channelAccountId)}
                    {target.targetExternalId && ` → ${target.targetExternalId}`}
                    {result?.status === "sent" && ` ✓ ${result.externalPostId ?? ""}`}
                    {result?.status === "failed" && ` ✗ ${result.error ?? t("publish.failedShort")}`}
                    {!result && ` · ${t("publish.pending")}`}
                  </span>
                );
              })}
            </div>
            <div className="mt-3 flex gap-2">
              {post.status !== "published" && post.status !== "cancelled" && (
                <button onClick={() => void publishNow(post)} disabled={busy} className="rounded-md bg-slate-900 text-white text-xs px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
                  {t("publish.publishNow")}
                </button>
              )}
              {(post.status === "draft" || post.status === "scheduled") && (
                <button onClick={() => startEdit(post)} disabled={busy} className="rounded-md border border-slate-300 text-slate-600 text-xs px-3 py-1.5 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">
                  {t("common.edit")}
                </button>
              )}
              <button onClick={() => void remove(post)} disabled={busy} className="rounded-md border border-slate-300 text-slate-600 text-xs px-3 py-1.5 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">
                {t("common.delete")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------- knowledge base UI

function KnowledgePage() {
  const { t } = useI18n();
  const [documents, setDocuments] = useState<KbDocument[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.listKbDocuments();
      setDocuments(data.documents);
      setError(null);
    } catch (err) {
      setError(errText(err, t("knowledge.loadFailed")));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    try {
      await api.createKbDocument({ title: title.trim(), content: content.trim() });
      setTitle("");
      setContent("");
      await load();
    } catch (err) {
      setError(errText(err, t("knowledge.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteKbDocument(id);
      await load();
    } catch (err) {
      setError(errText(err, t("knowledge.deleteFailed")));
    }
  };

  const upload = async () => {
    if (!uploadFile) return;
    setUploadBusy(true);
    try {
      const result = await api.uploadKbDocument(uploadFile, uploadTitle);
      pushToast("ok", result.extraction.truncated
        ? t("knowledge.uploadDoneTruncated", { chars: result.extraction.chars, filename: result.extraction.sourceFilename })
        : t("knowledge.uploadDone", { chars: result.extraction.chars, filename: result.extraction.sourceFilename }));
      setUploadFile(null);
      setUploadTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await load();
    } catch (err) {
      pushToast("err", errText(err, t("knowledge.uploadFailed")));
    } finally {
      setUploadBusy(false);
    }
  };

  return (
    <div>
      <PageTitle title={t("knowledge.title")} subtitle={t("knowledge.subtitle")} />
      {error && <div className="mt-4 max-w-xl"><ErrorBox error={error} /></div>}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
        <div className="space-y-4">
          <div className={`${cardCls} p-4 space-y-3`}>
            <div className="font-medium text-sm">{t("knowledge.addTitle")}</div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("knowledge.titlePlaceholder")} className={inputCls} />
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} placeholder={t("knowledge.contentPlaceholder")} className={inputCls} />
            <button onClick={() => void create()} disabled={busy || !title.trim() || !content.trim()} className={primaryBtn}>
              {busy ? t("common.saving") : t("knowledge.saveButton")}
            </button>
          </div>
          <div className={`${cardCls} p-4 space-y-3`}>
            <div className="font-medium text-sm">{t("knowledge.uploadTitle")}</div>
            <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,.md" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} className={inputCls} />
            <input value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} placeholder={t("knowledge.uploadTitlePlaceholder")} className={inputCls} />
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("knowledge.uploadHelp")}</p>
            <button onClick={() => void upload()} disabled={uploadBusy || !uploadFile} className={primaryBtn}>
              {uploadBusy ? t("common.saving") : t("knowledge.uploadButton")}
            </button>
          </div>
        </div>
        <div className="space-y-2">
          {documents.length === 0 && !error && <EmptyState>{t("knowledge.empty")}</EmptyState>}
          {documents.map((d) => (
            <div key={d.id} className={`${cardCls} p-3 flex items-center justify-between`}>
              <div>
                <div className="font-medium text-sm">{d.title}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {t("common.status")}: {d.status} · {d.chunkCount} {t("knowledge.chunks")}{d.error ? ` · ${d.error}` : ""}
                </div>
                {d.sourceFilename && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {t("knowledge.fromFile", { filename: d.sourceFilename })}
                  </div>
                )}
              </div>
              <button onClick={() => void remove(d.id)} className="text-xs text-red-600 dark:text-red-400 underline">{t("common.delete")}</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- Dashboard

function DashboardPage({ goTo }: { goTo: (page: PageId) => void }) {
  const { t } = useI18n();
  const [stats, setStats] = useState<StatsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getStatsOverview()
      .then((data) => { setStats(data); setError(null); })
      .catch((err) => setError(errText(err, t("dashboard.loadFailed"))));
  }, [t]);

  const cards: Array<{ label: string; value: number }> = stats ? [
    { label: t("dashboard.contacts"), value: stats.contacts.total },
    { label: t("dashboard.conversationsOpen"), value: stats.conversations.open },
    { label: t("dashboard.conversationsTotal"), value: stats.conversations.total },
    { label: t("dashboard.messagesIn"), value: stats.messagesLast30d.in },
    { label: t("dashboard.messagesOut"), value: stats.messagesLast30d.out },
    { label: t("dashboard.broadcastsSent"), value: stats.broadcastsThisMonth.sent },
    { label: t("dashboard.broadcastsFailed"), value: stats.broadcastsThisMonth.failed },
    { label: t("dashboard.activeFlows"), value: stats.activeFlows },
    { label: t("dashboard.scheduledPending"), value: stats.scheduledPostsPending },
  ] : [];

  return (
    <div>
      <PageTitle title={t("dashboard.title")} subtitle={t("dashboard.subtitle")} />
      {error && <div className="mt-4 max-w-xl"><ErrorBox error={error} /></div>}
      {!stats && !error && <p className={`mt-6 ${mutedCls}`}>{t("app.loading")}</p>}
      {stats && (
        <>
          <div className="mt-6 grid grid-cols-2 md:grid-cols-3 gap-4 max-w-4xl">
            {cards.map((card) => (
              <div key={card.label} className={`${cardCls} p-4`}>
                <div className="text-2xl font-bold">{card.value}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{card.label}</div>
              </div>
            ))}
          </div>
          <div className={`mt-4 max-w-4xl ${cardCls} p-4`}>
            <div className="font-medium text-sm">{t("dashboard.costTitle")}</div>
            {stats.costThisMonth.length === 0 ? (
              <p className={`mt-1 ${mutedCls}`}>{t("dashboard.costEmpty")}</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {stats.costThisMonth.map((row) => (
                  <li key={row.currency} className="flex justify-between max-w-xs">
                    <span className="text-slate-500 dark:text-slate-400">{row.currency}</span>
                    <span className="font-medium">{row.amount.toFixed(4)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={`mt-4 max-w-4xl ${cardCls} p-4`}>
            <div className="flex items-center justify-between">
              <div className="font-medium text-sm">{t("dashboard.recentTitle")}</div>
              <button onClick={() => goTo("inbox")} className="text-xs text-slate-900 underline dark:text-slate-100">{t("dashboard.viewInbox")}</button>
            </div>
            {stats.recentConversations.length === 0 ? (
              <p className={`mt-2 ${mutedCls}`}>{t("dashboard.recentEmpty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
                {stats.recentConversations.map((conv) => (
                  <li key={conv.id}>
                    <button onClick={() => goTo("inbox")} className="flex w-full items-center justify-between py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded px-1">
                      <span>{conv.contactDisplayName ?? conv.contactExternalId}</span>
                      <span className="flex items-center gap-2">
                        <span className={chipCls}>{conv.channel}</span>
                        <span className="text-xs text-slate-400">{conv.status}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Flows

function triggerSummary(flow: Flow, t: ReturnType<typeof useI18n>["t"]): string {
  const { trigger } = flow;
  if (trigger.type === "keyword") {
    const keyword = typeof trigger.config.keyword === "string" ? trigger.config.keyword : "";
    const match = trigger.config.match === "equals" ? "equals" : "contains";
    return t("flows.triggerKeyword", { keyword, match });
  }
  if (trigger.type === "postback") {
    const payload = typeof trigger.config.payload === "string" ? trigger.config.payload : "";
    return t("flows.triggerPostback", { payload });
  }
  if (trigger.type === "comment_keyword") {
    const keyword = typeof trigger.config.keyword === "string" ? trigger.config.keyword : "";
    return t("flows.triggerComment", { keyword });
  }
  return t("flows.triggerManual");
}

function FlowsPage() {
  const { t } = useI18n();
  const [flows, setFlows] = useState<Flow[]>([]);
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [editing, setEditing] = useState<Flow | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Import a `.botara-flow.json` file: the envelope + graph are
   * validated client-side with the engine's own graph schema (the same
   * validator the API applies), then created as a NEW draft through
   * POST /flows - imports never overwrite an existing flow.
   */
  const importFile = async (file: File) => {
    setError(null);
    setImportNotice(null);
    const parsed = parseFlowImport(await file.text());
    if (!parsed.ok) {
      setError(t(`flows.transfer.error.${parsed.error}` as Parameters<typeof t>[0]));
      return;
    }
    setBusy(true);
    try {
      const res = await api.createFlow({ name: parsed.name, trigger: parsed.trigger, graph: parsed.graph });
      setFlows((prev) => [res.flow, ...prev]);
      setImportNotice(t("flows.transfer.imported"));
      setEditing(res.flow);
    } catch (err) {
      setError(errText(err, t("flows.createFailed")));
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const [fl, acc] = await Promise.all([api.listFlows(), api.listChannelAccounts()]);
      setFlows(fl.flows);
      setAccounts(acc.accounts);
      setError(null);
    } catch (err) {
      setError(errText(err, t("flows.loadFailed")));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const res = await api.createFlow({
        name: newName.trim(),
        trigger: { type: "keyword", config: { keyword: "", match: "contains" } },
        graph: starterGraph(),
      });
      setNewName("");
      setFlows((prev) => [res.flow, ...prev]);
      setEditing(res.flow);
    } catch (err) {
      setError(errText(err, t("flows.createFailed")));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (flow: Flow) => {
    try {
      const res = flow.status === "active" ? await api.deactivateFlow(flow.id) : await api.activateFlow(flow.id);
      setFlows((prev) => prev.map((f) => (f.id === flow.id ? res.flow : f)));
    } catch (err) {
      setError(errText(err, t("flows.saveFailed")));
    }
  };

  const remove = async (flow: Flow) => {
    if (!window.confirm(t("flows.deleteConfirm"))) return;
    try {
      await api.deleteFlow(flow.id);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
    } catch (err) {
      setError(errText(err, t("flows.saveFailed")));
    }
  };

  if (editing) {
    return (
      <FlowBuilder
        flow={editing}
        accounts={accounts}
        onBack={() => { setEditing(null); void load(); }}
        onChanged={(flow) => {
          setEditing(flow);
          setFlows((prev) => prev.map((f) => (f.id === flow.id ? flow : f)));
        }}
      />
    );
  }

  return (
    <div>
      <PageTitle title={t("flows.title")} subtitle={t("flows.subtitle")} />
      {error && <div className="mt-4 max-w-xl"><ErrorBox error={error} /></div>}
      <div className="mt-5 flex gap-2 max-w-lg">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("flows.namePlaceholder")} className={inputCls} />
        <button onClick={() => void create()} disabled={busy || !newName.trim()} className={primaryBtn}>{t("flows.new")}</button>
        <label className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 cursor-pointer self-center whitespace-nowrap dark:border-slate-700 dark:text-slate-200">
          {t("flows.transfer.import")}
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importFile(file);
            }}
          />
        </label>
      </div>
      {importNotice && !error && (
        <div className="mt-3 max-w-xl rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{importNotice}</div>
      )}
      <div className="mt-5 space-y-2 max-w-4xl">
        {flows.length === 0 && !error && <EmptyState>{t("flows.empty")}</EmptyState>}
        {flows.map((flow) => (
          <div key={flow.id} className={`${cardCls} p-4 flex flex-wrap items-center gap-3`}>
            <div className="min-w-48 flex-1">
              <div className="font-medium text-sm">{flow.name}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {t("flows.triggerSummary")}: {triggerSummary(flow, t)} · {t("common.updated")}: {new Date(flow.updatedAt).toLocaleString()}
              </div>
            </div>
            <span className={`text-xs px-2 py-0.5 rounded-full ${flow.status === "active"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
              {flow.status === "active" ? t("flows.statusActive") : t("flows.statusDraft")}
            </span>
            <button onClick={() => setEditing(flow)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700">{t("flows.openBuilder")}</button>
            <button onClick={() => downloadFlowExport(flow)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700">{t("flows.transfer.export")}</button>
            <button onClick={() => void toggle(flow)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700">
              {flow.status === "active" ? t("flows.deactivate") : t("flows.activate")}
            </button>
            <button onClick={() => void remove(flow)} className="text-xs text-red-600 dark:text-red-400 underline">{t("common.delete")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- Sequences

interface StepDraft {
  delayHours: number;
  kind: "text" | "template";
  body: string;
  templateName: string;
  templateLanguage: string;
  templateCategory: string;
  /** Per-recipient body parameter templates (variables package #1). */
  templateParams: string[];
}

const emptyStep = (): StepDraft => ({
  delayHours: 24, kind: "text", body: "", templateName: "", templateLanguage: "id", templateCategory: "utility",
  templateParams: [],
});

function stepToDraft(step: SequenceStep): StepDraft {
  return {
    delayHours: Math.round(step.delaySeconds / 3600),
    kind: step.template ? "template" : "text",
    body: step.text ?? "",
    templateName: step.template?.name ?? "",
    templateLanguage: step.template?.language ?? "id",
    templateCategory: step.template?.latestCategory ?? "utility",
    templateParams: step.template?.templateParams ?? [],
  };
}

function draftToStep(draft: StepDraft): SequenceStep {
  return draft.kind === "template"
    ? {
        delaySeconds: Math.max(0, Math.round(draft.delayHours * 3600)),
        template: {
          name: draft.templateName, language: draft.templateLanguage, latestCategory: draft.templateCategory,
          ...(draft.templateParams.some((p) => p.trim()) ? { templateParams: draft.templateParams.map((p) => p.trim()) } : {}),
        },
      }
    : { delaySeconds: Math.max(0, Math.round(draft.delayHours * 3600)), text: draft.body };
}


/**
 * Deals board (adoption package #6): pipelines + Kanban stages.
 *
 * Won/lost is a STATUS shown as a badge on the card - the card stays in
 * its stage column (filter toggle hides closed deals). Moving works by
 * drag-and-drop AND by the stage picker on every card (drag alone is
 * not accessible). All money renders through formatDealMoney - never
 * raw - per the package #4 numeric-string lesson.
 */
function DealsPage({ workspace }: { workspace: WorkspaceSummary | undefined }) {
  const { t } = useI18n();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineId, setPipelineId] = useState("");
  const [deals, setDeals] = useState<Deal[]>([]);
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hideClosed, setHideClosed] = useState(false);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  // Pipeline form
  const [showPipelineForm, setShowPipelineForm] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [withDefaultStages, setWithDefaultStages] = useState(true);
  // Stage manager
  const [newStageName, setNewStageName] = useState("");
  const [stageEditId, setStageEditId] = useState<string | null>(null);
  const [stageEditName, setStageEditName] = useState("");
  // Deal form
  const [showDealForm, setShowDealForm] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [fTitle, setFTitle] = useState("");
  const [fContactId, setFContactId] = useState("");
  const [fConversationId, setFConversationId] = useState("");
  const [fPipelineId, setFPipelineId] = useState("");
  const [fStageId, setFStageId] = useState("");
  const [fValue, setFValue] = useState("");
  const [fCurrency, setFCurrency] = useState("IDR");
  const [fExpectedClose, setFExpectedClose] = useState("");
  const [fNotes, setFNotes] = useState("");

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId) ?? null;
  const defaultCurrency = workspace?.defaultCurrency ?? "IDR";

  const loadPipelines = useCallback(async () => {
    try {
      const res = await api.listPipelines();
      setPipelines(res.pipelines);
      setPipelineId((prev) => {
        if (prev && res.pipelines.some((p) => p.id === prev)) return prev;
        return (res.pipelines.find((p) => p.isDefault) ?? res.pipelines[0])?.id ?? "";
      });
      setError(null);
    } catch (err) {
      setError(errText(err, t("deals.loadFailed")));
    }
  }, [t]);

  const loadBoard = useCallback(async () => {
    if (!pipelineId) { setDeals([]); setSummary(null); return; }
    try {
      const [d, s] = await Promise.all([
        api.listDeals({ pipelineId, limit: 500 }),
        api.getPipelineSummary(pipelineId),
      ]);
      setDeals(d.deals);
      setSummary(s.summary);
    } catch (err) {
      setError(errText(err, t("deals.loadFailed")));
    }
  }, [pipelineId, t]);

  useEffect(() => { void loadPipelines(); }, [loadPipelines]);
  useEffect(() => { void loadBoard(); }, [loadBoard]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [c, cv] = await Promise.all([api.listContacts(), api.listConversations()]);
        if (cancelled) return;
        setContacts(c.contacts);
        setConversations(cv.conversations);
      } catch { /* pickers are an enhancement; the board still renders */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshAll = async () => { await loadPipelines(); await loadBoard(); };

  const createPipeline = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.createPipeline({
        name: newPipelineName.trim(),
        withDefaultStages,
        makeDefault: pipelines.length === 0,
      });
      setShowPipelineForm(false);
      setNewPipelineName("");
      await loadPipelines();
      setPipelineId(res.pipeline.id);
    } catch (err) {
      setError(errText(err, t("deals.saveFailed")));
    } finally { setBusy(false); }
  };

  const deletePipeline = async (p: Pipeline) => {
    if (!window.confirm(t("deals.deletePipelineConfirm"))) return;
    setBusy(true); setError(null);
    try {
      await api.deletePipeline(p.id);
      if (p.id === pipelineId) setPipelineId("");
      await loadPipelines();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        let count = 0;
        try {
          const s = await api.getPipelineSummary(p.id);
          count = s.summary.open.count + s.summary.won.count + s.summary.lost.count;
        } catch { /* count is cosmetic in the confirm text */ }
        if (window.confirm(t("deals.pipelineHasDeals", { count }))) {
          try {
            await api.deletePipeline(p.id, true);
            if (p.id === pipelineId) setPipelineId("");
            await loadPipelines();
          } catch (err2) {
            setError(errText(err2, t("deals.saveFailed")));
          }
        }
      } else {
        setError(errText(err, t("deals.saveFailed")));
      }
    } finally { setBusy(false); }
  };

  const moveDeal = async (deal: Deal, stageId: string) => {
    if (stageId === deal.stageId || !stageId) return;
    setError(null);
    try {
      await api.updateDeal(deal.id, { stageId });
      await loadBoard();
    } catch (err) {
      setError(errText(err, t("deals.saveFailed")));
    }
  };

  const setDealStatus = async (deal: Deal, status: Deal["status"]) => {
    setError(null);
    try {
      await api.updateDeal(deal.id, { status });
      await loadBoard();
    } catch (err) {
      setError(errText(err, t("deals.saveFailed")));
    }
  };

  const deleteDeal = async (deal: Deal) => {
    if (!window.confirm(t("deals.deleteDealConfirm"))) return;
    setError(null);
    try {
      await api.deleteDeal(deal.id);
      await loadBoard();
    } catch (err) {
      setError(errText(err, t("deals.saveFailed")));
    }
  };

  const openNewDeal = () => {
    if (!selectedPipeline) return;
    setEditingDeal(null);
    setFTitle("");
    setFContactId("");
    setFConversationId("");
    setFPipelineId(selectedPipeline.id);
    setFStageId("");
    setFValue("");
    setFCurrency(defaultCurrency);
    setFExpectedClose("");
    setFNotes("");
    setShowDealForm(true);
  };

  const openEditDeal = (deal: Deal) => {
    setEditingDeal(deal);
    setFTitle(deal.title);
    setFContactId(deal.contactId);
    setFConversationId(deal.conversationId ?? "");
    setFPipelineId(deal.pipelineId);
    setFStageId(deal.stageId);
    setFValue(deal.value === null ? "" : String(deal.value));
    setFCurrency(deal.currency);
    setFExpectedClose(deal.expectedCloseDate ?? "");
    setFNotes(deal.notes ?? "");
    setShowDealForm(true);
  };

  const saveDeal = async () => {
    setBusy(true); setError(null);
    try {
      const body = {
        title: fTitle.trim(),
        contactId: fContactId,
        conversationId: fConversationId || null,
        value: fValue.trim() === "" ? null : Number(fValue),
        currency: fCurrency.trim().toUpperCase() || defaultCurrency,
        expectedCloseDate: fExpectedClose || null,
        notes: fNotes.trim() || null,
        ...(fStageId ? { stageId: fStageId } : {}),
      };
      if (editingDeal) {
        await api.updateDeal(editingDeal.id, { ...body, pipelineId: fPipelineId });
      } else {
        await api.createDeal({ ...body, pipelineId: fPipelineId });
      }
      setShowDealForm(false);
      if (fPipelineId !== pipelineId) setPipelineId(fPipelineId);
      await loadBoard();
    } catch (err) {
      setError(errText(err, t("deals.saveFailed")));
    } finally { setBusy(false); }
  };

  const addStage = async () => {
    if (!selectedPipeline || !newStageName.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.createPipelineStage(selectedPipeline.id, { name: newStageName.trim() });
      setNewStageName("");
      await refreshAll();
    } catch (err) {
      setError(errText(err, t("deals.saveFailed")));
    } finally { setBusy(false); }
  };

  const renameStage = async (stageId: string) => {
    if (!selectedPipeline || !stageEditName.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.updatePipelineStage(selectedPipeline.id, stageId, { name: stageEditName.trim() });
      setStageEditId(null);
      await refreshAll();
    } catch (err) {
      setError(errText(err, t("deals.saveFailed")));
    } finally { setBusy(false); }
  };

  const moveStage = async (stageId: string, direction: -1 | 1) => {
    if (!selectedPipeline) return;
    const order = movedStageOrder(selectedPipeline.stages, stageId, direction);
    if (!order) return;
    setError(null);
    try {
      await api.reorderPipelineStages(selectedPipeline.id, order);
      await refreshAll();
    } catch (err) {
      setError(errText(err, t("deals.saveFailed")));
    }
  };

  const deleteStage = async (stageId: string) => {
    if (!selectedPipeline) return;
    if (!window.confirm(t("deals.deleteStageConfirm"))) return;
    setError(null);
    try {
      await api.deletePipelineStage(selectedPipeline.id, stageId);
      await refreshAll();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError(t("deals.stageHasDeals"));
      else setError(errText(err, t("deals.saveFailed")));
    }
  };

  const formPipeline = pipelines.find((p) => p.id === fPipelineId) ?? null;
  const formConversations = conversations.filter((c) => c.contactId === fContactId);
  const boardDeals = visibleDeals(deals, hideClosed);
  const columns = selectedPipeline ? groupDealsByStage(selectedPipeline.stages, boardDeals) : [];
  const stageSummary = (stageId: string) => summary?.stages.find((s) => s.stageId === stageId);

  const statusBadge = (deal: Deal) => deal.status === "open" ? null : (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${deal.status === "won"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300"
      : "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300"}`}>
      {t(`deals.status.${deal.status}`)}
    </span>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("deals.title")}</h2>
          <p className={mutedCls}>{t("deals.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={pipelineId}
            onChange={(e) => setPipelineId(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.isDefault ? " ★" : ""}</option>
            ))}
          </select>
          {selectedPipeline && !selectedPipeline.isDefault && (
            <button
              onClick={() => void api.updatePipeline(selectedPipeline.id, { isDefault: true }).then(refreshAll)}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
            >
              {t("deals.makeDefault")}
            </button>
          )}
          {selectedPipeline && (
            <button
              onClick={() => void deletePipeline(selectedPipeline)}
              disabled={busy}
              className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 dark:border-red-800 dark:text-red-400"
            >
              {t("deals.deletePipeline")}
            </button>
          )}
          <button onClick={() => setShowPipelineForm((v) => !v)} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            {t("deals.newPipeline")}
          </button>
          <button onClick={openNewDeal} disabled={!selectedPipeline || selectedPipeline.stages.length === 0} className={primaryBtn}>
            {t("deals.newDeal")}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {showPipelineForm && (
        <div className={`${cardCls} flex flex-wrap items-end gap-3 p-4`}>
          <div className="min-w-56 flex-1">
            <label className={labelCls}>{t("deals.pipelineName")}</label>
            <input value={newPipelineName} onChange={(e) => setNewPipelineName(e.target.value)} className={inputCls} />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={withDefaultStages} onChange={(e) => setWithDefaultStages(e.target.checked)} />
            {t("deals.withDefaultStages")}
          </label>
          <button onClick={() => void createPipeline()} disabled={busy || !newPipelineName.trim()} className={primaryBtn}>
            {t("common.create")}
          </button>
          <button onClick={() => setShowPipelineForm(false)} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            {t("common.cancel")}
          </button>
        </div>
      )}

      {pipelines.length === 0 && !showPipelineForm && (
        <div className={`${cardCls} p-6 text-center`}>
          <div className="font-medium">{t("deals.emptyTitle")}</div>
          <p className={mutedCls}>{t("deals.emptyBody")}</p>
        </div>
      )}

      {selectedPipeline && (
        <>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span>
              {t("deals.openTotal")}: <strong>{summary?.open.count ?? 0}</strong>
              {" · "}{formatDealMoney(summary?.open.value ?? null, defaultCurrency)}
            </span>
            <span>
              {t("deals.wonTotal")}: <strong>{summary?.won.count ?? 0}</strong>
              {" · "}{formatDealMoney(summary?.won.value ?? null, defaultCurrency)}
            </span>
            <span>
              {t("deals.lostTotal")}: <strong>{summary?.lost.count ?? 0}</strong>
              {" · "}{formatDealMoney(summary?.lost.value ?? null, defaultCurrency)}
            </span>
            <label className="ml-auto flex items-center gap-2">
              <input type="checkbox" checked={hideClosed} onChange={(e) => setHideClosed(e.target.checked)} />
              {t("deals.hideClosed")}
            </label>
          </div>

          {selectedPipeline.stages.length === 0 ? (
            <p className={mutedCls}>{t("deals.noStages")}</p>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {columns.map(({ stage, deals: columnDeals }) => (
                <div
                  key={stage.id}
                  onDragOver={(e) => { e.preventDefault(); setDragOverStage(stage.id); }}
                  onDragLeave={() => setDragOverStage((cur) => (cur === stage.id ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverStage(null);
                    const dealId = e.dataTransfer.getData("text/plain");
                    const deal = deals.find((d) => d.id === dealId);
                    if (deal) void moveDeal(deal, stage.id);
                  }}
                  className={`flex w-72 shrink-0 flex-col rounded-lg border bg-slate-50 dark:bg-slate-900/60 ${dragOverStage === stage.id
                    ? "border-slate-500" : "border-slate-200 dark:border-slate-800"}`}
                >
                  <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
                    <div className="text-sm font-medium">{stage.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {stageSummary(stage.id)?.openCount ?? 0} · {formatDealMoney(stageSummary(stage.id)?.openValue ?? null, defaultCurrency)}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {columnDeals.map((deal) => (
                      <div
                        key={deal.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", deal.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        className={`${cardCls} cursor-grab p-3`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-sm font-medium">{deal.title}</div>
                          {statusBadge(deal)}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {deal.contactDisplayName} · {deal.contactChannel}
                        </div>
                        <div className="mt-1 text-sm">{formatDealMoney(deal.value, deal.currency)}</div>
                        {deal.expectedCloseDate && (
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {t("deals.expectedClose")}: {deal.expectedCloseDate}
                          </div>
                        )}
                        <label className="mt-2 block">
                          <span className="sr-only">{t("deals.moveTo")}</span>
                          <select
                            value={deal.stageId}
                            onChange={(e) => void moveDeal(deal, e.target.value)}
                            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          >
                            {selectedPipeline.stages.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        </label>
                        <div className="mt-2 flex flex-wrap gap-1 text-xs">
                          {deal.status === "open" ? (
                            <>
                              <button onClick={() => void setDealStatus(deal, "won")} className="rounded border border-emerald-300 px-2 py-1 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
                                {t("deals.markWon")}
                              </button>
                              <button onClick={() => void setDealStatus(deal, "lost")} className="rounded border border-red-300 px-2 py-1 text-red-700 dark:border-red-800 dark:text-red-300">
                                {t("deals.markLost")}
                              </button>
                            </>
                          ) : (
                            <button onClick={() => void setDealStatus(deal, "open")} className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">
                              {t("deals.reopen")}
                            </button>
                          )}
                          <button onClick={() => openEditDeal(deal)} className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">
                            {t("common.edit")}
                          </button>
                          <button onClick={() => void deleteDeal(deal)} className="rounded border border-slate-300 px-2 py-1 text-red-600 dark:border-slate-700 dark:text-red-400">
                            {t("common.delete")}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className={`${cardCls} p-4`}>
            <div className="text-sm font-medium">{t("deals.manageStages")}</div>
            <div className="mt-2 space-y-2">
              {selectedPipeline.stages.map((stage, idx) => (
                <div key={stage.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-6 text-slate-400">{idx + 1}.</span>
                  {stageEditId === stage.id ? (
                    <>
                      <input value={stageEditName} onChange={(e) => setStageEditName(e.target.value)} className="w-56 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
                      <button onClick={() => void renameStage(stage.id)} disabled={busy || !stageEditName.trim()} className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700">
                        {t("common.save")}
                      </button>
                      <button onClick={() => setStageEditId(null)} className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700">
                        {t("common.cancel")}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="w-56">{stage.name}</span>
                      <button onClick={() => void moveStage(stage.id, -1)} disabled={idx === 0} className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-slate-700">↑</button>
                      <button onClick={() => void moveStage(stage.id, 1)} disabled={idx === selectedPipeline.stages.length - 1} className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-slate-700">↓</button>
                      <button onClick={() => { setStageEditId(stage.id); setStageEditName(stage.name); }} className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700">
                        {t("common.edit")}
                      </button>
                      <button onClick={() => void deleteStage(stage.id)} className="rounded border border-slate-300 px-2 py-1 text-xs text-red-600 dark:border-slate-700 dark:text-red-400">
                        {t("common.delete")}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div>
                <label className={labelCls}>{t("deals.stageName")}</label>
                <input value={newStageName} onChange={(e) => setNewStageName(e.target.value)} className="w-56 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
              </div>
              <button onClick={() => void addStage()} disabled={busy || !newStageName.trim()} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
                {t("deals.addStage")}
              </button>
            </div>
          </div>
        </>
      )}

      {showDealForm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className={`${cardCls} max-h-full w-full max-w-lg space-y-3 overflow-y-auto p-5`}>
            <div className="text-base font-semibold">{editingDeal ? t("deals.editDeal") : t("deals.newDeal")}</div>
            <div>
              <label className={labelCls}>{t("deals.formTitle")}</label>
              <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t("deals.contact")} *</label>
              <select value={fContactId} onChange={(e) => { setFContactId(e.target.value); setFConversationId(""); }} className={inputCls}>
                <option value="">{t("deals.contactPick")}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName} ({c.channel})</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{t("deals.conversation")}</label>
              <select value={fConversationId} onChange={(e) => setFConversationId(e.target.value)} className={inputCls} disabled={!fContactId}>
                <option value="">{t("deals.conversationNone")}</option>
                {formConversations.map((c) => (
                  <option key={c.id} value={c.id}>{c.channel} · {c.status} · {c.id.slice(0, 8)}…</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{t("deals.pipeline")}</label>
                <select value={fPipelineId} onChange={(e) => { setFPipelineId(e.target.value); setFStageId(""); }} className={inputCls}>
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>{t("deals.stage")}</label>
                <select value={fStageId} onChange={(e) => setFStageId(e.target.value)} className={inputCls}>
                  <option value="">{formPipeline?.stages[0]?.name ?? ""}</option>
                  {(formPipeline?.stages ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>{t("deals.value")}</label>
                <input type="number" min={0} step="any" value={fValue} onChange={(e) => setFValue(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>{t("deals.currency")}</label>
                <input value={fCurrency} onChange={(e) => setFCurrency(e.target.value.toUpperCase().slice(0, 3))} className={inputCls} maxLength={3} />
              </div>
              <div>
                <label className={labelCls}>{t("deals.expectedClose")}</label>
                <input type="date" value={fExpectedClose} onChange={(e) => setFExpectedClose(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>{t("deals.notes")}</label>
              <textarea value={fNotes} onChange={(e) => setFNotes(e.target.value)} rows={3} className={inputCls} />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDealForm(false)} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
                {t("common.cancel")}
              </button>
              <button onClick={() => void saveDeal()} disabled={busy || !fTitle.trim() || !fContactId || !fPipelineId} className={primaryBtn}>
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SequencesPage() {
  const { t } = useI18n();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([emptyStep()]);
  const [enrollTags, setEnrollTags] = useState<Record<string, string>>({});
  const [enrollResults, setEnrollResults] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sq, acc] = await Promise.all([api.listSequences(), api.listChannelAccounts()]);
      setSequences(sq.sequences);
      setAccounts(acc.accounts);
      setError(null);
    } catch (err) {
      setError(errText(err, t("sequences.loadFailed")));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const openNew = () => {
    setEditingId(null);
    setName("");
    // TikTok accounts are excluded (reactive-only channel, no sequences).
    setAccountId(accounts.find((a) => a.channel !== "tiktok")?.id ?? "");
    setSteps([emptyStep()]);
    setShowForm(true);
  };

  const openEdit = (seq: Sequence) => {
    setEditingId(seq.id);
    setName(seq.name);
    setAccountId(seq.channelAccountId);
    setSteps((seq.steps ?? []).map(stepToDraft));
    setShowForm(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payloadSteps = steps.map(draftToStep);
      if (editingId) {
        await api.updateSequence(editingId, { name: name.trim(), steps: payloadSteps });
      } else {
        await api.createSequence({ channelAccountId: accountId, name: name.trim(), steps: payloadSteps });
      }
      setShowForm(false);
      await load();
    } catch (err) {
      setError(errText(err, t("sequences.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (seq: Sequence) => {
    if (!window.confirm(t("sequences.deleteConfirm"))) return;
    try {
      await api.deleteSequence(seq.id);
      await load();
    } catch (err) {
      setError(errText(err, t("sequences.saveFailed")));
    }
  };

  const enroll = async (seq: Sequence) => {
    const tag = (enrollTags[seq.id] ?? "").trim();
    if (!tag) return;
    setBusy(true);
    try {
      const res = await api.enrollSequence(seq.id, tag);
      setEnrollResults((prev) => ({ ...prev, [seq.id]: t("sequences.enrolledResult", { enrolled: res.enrolled, skipped: res.skipped, total: res.total }) }));
      await load();
    } catch (err) {
      setError(errText(err, t("sequences.enrollFailed")));
    } finally {
      setBusy(false);
    }
  };

  const patchStep = (index: number, patch: Partial<StepDraft>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  // Variable-picker targets (variables #1): text-step bodies by step
  // index, template-param inputs by "step:param" key.
  const stepTextRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const stepParamRefs = useRef(new Map<string, HTMLInputElement | null>());
  const patchStepParam = (stepIndex: number, paramIndex: number, value: string) => {
    setSteps((prev) => prev.map((s, i) => (i === stepIndex
      ? { ...s, templateParams: s.templateParams.map((p, j) => (j === paramIndex ? value : p)) }
      : s)));
  };

  return (
    <div>
      <PageTitle title={t("sequences.title")} subtitle={t("sequences.subtitle")} />
      {error && <div className="mt-4 max-w-xl"><ErrorBox error={error} /></div>}
      <button onClick={openNew} className={`mt-5 ${primaryBtn}`}>{t("sequences.new")}</button>

      {showForm && (
        <div className={`mt-4 max-w-3xl ${cardCls} p-4 space-y-4`}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t("sequences.nameLabel")}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t("sequences.accountLabel")}</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls} disabled={Boolean(editingId)}>
                <option value="">-</option>
                {accounts.filter((a) => a.channel !== "tiktok").map((a) => (
                  <option key={a.id} value={a.id}>{a.channel} · {a.displayName ?? a.externalId}</option>
                ))}
              </select>
              {accounts.filter((a) => a.channel !== "tiktok").length === 0 && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("sequences.noAccounts")}</p>}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium mb-2">{t("sequences.stepsLabel")}</div>
            <div className="space-y-3">
              {steps.map((step, i) => (
                <div key={i} className="rounded-md border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                  <div className="flex flex-wrap gap-3">
                    <div className="w-32">
                      <label className={labelCls}>{t("sequences.stepDelay")}</label>
                      <input type="number" min={0} value={step.delayHours} onChange={(e) => patchStep(i, { delayHours: Number(e.target.value) })} className={inputCls} />
                    </div>
                    <div className="w-40">
                      <label className={labelCls}>{t("sequences.stepKind")}</label>
                      <select value={step.kind} onChange={(e) => patchStep(i, { kind: e.target.value as StepDraft["kind"] })} className={inputCls}>
                        <option value="text">{t("sequences.kindText")}</option>
                        <option value="template">{t("sequences.kindTemplate")}</option>
                      </select>
                    </div>
                    <button onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))} className="self-end text-xs text-red-600 dark:text-red-400 underline pb-2">
                      {t("sequences.removeStep")}
                    </button>
                  </div>
                  {step.kind === "text" ? (
                    <div>
                      <label className={labelCls}>{t("sequences.stepBody")}</label>
                      <textarea
                        ref={(el) => { stepTextRefs.current[i] = el; }}
                        value={step.body}
                        onChange={(e) => patchStep(i, { body: e.target.value })}
                        rows={2}
                        className={inputCls}
                      />
                      <div className="mt-1">
                        <VariablePicker target={() => stepTextRefs.current[i] ?? null} />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                          <label className={labelCls}>{t("sequences.templateName")}</label>
                          <input value={step.templateName} onChange={(e) => patchStep(i, { templateName: e.target.value })} className={inputCls} />
                        </div>
                        <div>
                          <label className={labelCls}>{t("sequences.templateLanguage")}</label>
                          <input value={step.templateLanguage} onChange={(e) => patchStep(i, { templateLanguage: e.target.value })} className={inputCls} />
                        </div>
                        <div>
                          <label className={labelCls}>{t("sequences.templateCategory")}</label>
                          <select value={step.templateCategory} onChange={(e) => patchStep(i, { templateCategory: e.target.value })} className={inputCls}>
                            <option value="marketing">marketing</option>
                            <option value="utility">utility</option>
                            <option value="authentication">authentication</option>
                            <option value="service">service</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>{t("templateParams.label")}</label>
                        <div className="space-y-2">
                          {step.templateParams.map((param, j) => (
                            <div key={j} className="flex items-center gap-2">
                              <span className="w-8 text-xs text-slate-400">{`{{${j + 1}}}`}</span>
                              <input
                                ref={(el) => { stepParamRefs.current.set(`${i}:${j}`, el); }}
                                value={param}
                                onChange={(e) => patchStepParam(i, j, e.target.value)}
                                placeholder={t("templateParams.placeholder")}
                                className={inputCls}
                              />
                              <VariablePicker target={() => stepParamRefs.current.get(`${i}:${j}`) ?? null} />
                              <button
                                onClick={() => patchStep(i, { templateParams: step.templateParams.filter((_, idx) => idx !== j) })}
                                className="text-xs text-red-600 underline dark:text-red-400"
                              >
                                {t("templateParams.remove")}
                              </button>
                            </div>
                          ))}
                        </div>
                        <button
                          onClick={() => patchStep(i, { templateParams: [...step.templateParams, ""] })}
                          className="mt-1 text-xs text-slate-600 underline dark:text-slate-300"
                        >
                          {t("templateParams.add")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button onClick={() => setSteps((prev) => [...prev, emptyStep()])} className="mt-2 text-xs underline text-slate-600 dark:text-slate-300">
              {t("sequences.addStep")}
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void save()} disabled={busy || !name.trim() || steps.length === 0 || (!editingId && !accountId)} className={primaryBtn}>
              {busy ? t("common.saving") : t("common.save")}
            </button>
            <button onClick={() => setShowForm(false)} className={outlineBtn}>{t("common.cancel")}</button>
          </div>
        </div>
      )}

      <div className="mt-5 space-y-2 max-w-4xl">
        {sequences.length === 0 && !error && !showForm && <EmptyState>{t("sequences.empty")}</EmptyState>}
        {sequences.map((seq) => (
          <div key={seq.id} className={`${cardCls} p-4`}>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-48 flex-1">
                <div className="font-medium text-sm">{seq.name}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {t("sequences.stepsCount", { count: seq.stepCount ?? (seq.steps?.length ?? 0) })} · {t("sequences.enrollmentsCount", { count: seq.enrollmentCount ?? 0 })} · {seq.status}
                </div>
              </div>
              <button onClick={() => openEdit(seq)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700">{t("common.edit")}</button>
              <button onClick={() => void remove(seq)} className="text-xs text-red-600 dark:text-red-400 underline">{t("common.delete")}</button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t("sequences.enrollTitle")}:</span>
              <input
                value={enrollTags[seq.id] ?? ""}
                onChange={(e) => setEnrollTags((prev) => ({ ...prev, [seq.id]: e.target.value }))}
                placeholder={t("sequences.enrollPlaceholder")}
                className="w-44 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <button onClick={() => void enroll(seq)} disabled={busy || !(enrollTags[seq.id] ?? "").trim()} className="rounded-md bg-slate-900 text-white text-xs px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
                {t("sequences.enrollButton")}
              </button>
              {enrollResults[seq.id] && <span className="text-xs text-emerald-700 dark:text-emerald-400">{enrollResults[seq.id]}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Channels

declare global {
  interface Window {
    FB?: {
      init: (opts: Record<string, unknown>) => void;
      login: (cb: (res: { authResponse?: { code?: string } }) => void, opts: Record<string, unknown>) => void;
    };
    fbAsyncInit?: () => void;
  }
}

function loadFacebookSdk(appId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.FB) { resolve(); return; }
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: false, version: "v26.0" });
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("sdk load failed"));
    document.body.appendChild(script);
  });
}

/**
 * Meta Catalog sync block on a WhatsApp account card: mirrors the
 * account's product catalogs so the FlowBuilder / Inbox pickers can
 * offer real products. The 503 CONFIGURATION case gets its own honest
 * message - the account needs a valid vault token first.
 */
function CatalogSyncSection({ accountId }: { accountId: string }) {
  const { t } = useI18n();
  const [summary, setSummary] = useState<CatalogSummary | null>(null);
  const [catalogIdInput, setCatalogIdInput] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api.getCatalogSummary(accountId));
    } catch { /* the summary line is informational only */ }
  }, [accountId]);
  useEffect(() => { void loadSummary(); }, [loadSummary]);

  const runSync = async () => {
    setSyncing(true);
    setMessage(null);
    setErrorText(null);
    try {
      const res = await api.syncCatalog(accountId, catalogIdInput.trim() || undefined);
      setMessage(t("channels.catalog.synced", { products: res.products, catalogs: res.catalogs }));
      await loadSummary();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIGURATION") {
        setErrorText(t("channels.catalog.needToken"));
      } else {
        setErrorText(errText(err, t("channels.catalog.failed")));
      }
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("channels.catalog.title")}</span>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          {summary && summary.productCount > 0 && summary.lastSyncedAt
            ? `${t("channels.catalog.products", { count: summary.productCount })} · ${t("channels.catalog.lastSync", { date: new Date(summary.lastSyncedAt).toLocaleString() })}`
            : t("channels.catalog.never")}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={catalogIdInput}
          onChange={(e) => setCatalogIdInput(e.target.value)}
          placeholder={t("channels.catalog.catalogIdPlaceholder")}
          aria-label={t("channels.catalog.catalogIdLabel")}
          className="w-64 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
        />
        <button
          onClick={() => void runSync()}
          disabled={syncing}
          className="rounded-md border border-slate-900 px-3 py-1.5 text-xs text-slate-900 disabled:opacity-50 dark:border-slate-100 dark:text-slate-100"
        >
          {syncing ? t("channels.catalog.syncing") : t("channels.catalog.sync")}
        </button>
      </div>
      {message && <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">{message}</p>}
      {errorText && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{errorText}</p>}
    </div>
  );
}

const CHANNEL_META: Record<string, { label: string; glyph: string; accent: string }> = {
  whatsapp: { label: "WhatsApp", glyph: "W", accent: "bg-emerald-500" },
  telegram: { label: "Telegram", glyph: "T", accent: "bg-sky-500" },
  instagram: { label: "Instagram", glyph: "I", accent: "bg-rose-500" },
  threads: { label: "Threads", glyph: "@", accent: "bg-slate-900 dark:bg-slate-600" },
  messenger: { label: "Messenger", glyph: "M", accent: "bg-blue-600" },
  tiktok: { label: "TikTok", glyph: "♪", accent: "bg-slate-800 dark:bg-slate-600" },
  webchat: { label: "Webchat", glyph: "W", accent: "bg-violet-500" },
};

const CHANNEL_ORDER = ["whatsapp", "telegram", "instagram", "threads", "messenger", "tiktok", "webchat"] as const;

/** Channels a contact can belong to (canonical list + email). */
const CONTACT_CHANNELS: string[] = [...CHANNEL_ORDER, "email"];

function channelMeta(channel: string): { label: string; glyph: string; accent: string } {
  return CHANNEL_META[channel] ?? { label: channel, glyph: channel.charAt(0).toUpperCase(), accent: "bg-slate-500" };
}

/**
 * Account avatar for a Channels card: the real profile picture when the
 * platform provided one (avatarUrl for Meta channels; the authenticated
 * API proxy for telegram, whose file URLs embed the bot token), falling
 * back to the platform initial chip when there is no picture or the
 * image fails to load.
 */
function ChannelAccountAvatar({ account }: { account: ChannelAccount }) {
  const meta = channelMeta(account.channel);
  const [failed, setFailed] = useState(false);
  const src = account.avatarUrl
    ?? (account.channel === "telegram"
      ? `${BASE_URL}/channels/accounts/${account.id}/avatar?workspace_id=${encodeURIComponent(getWorkspaceId())}`
      : undefined);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className="h-10 w-10 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${meta.accent}`}>{meta.glyph}</span>
  );
}

/**
 * Email sending-domain manager (F2) for the Channels connect modal:
 * lists the workspace's registered domains with their status and adds /
 * removes them via /channels/email/domains. Mounted only while the
 * connect modal is open, so it loads on open.
 */
function EmailDomainsCard({ className }: { className: string }) {
  const { t } = useI18n();
  const [domains, setDomains] = useState<WorkspaceDomain[]>([]);
  const [emailAccounts, setEmailAccounts] = useState<ChannelAccount[]>([]);
  const [domain, setDomain] = useState("");
  const [accountId, setAccountId] = useState("");
  const [resendId, setResendId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.listEmailDomains();
      setDomains(data.domains);
    } catch (err) {
      pushToast("err", errText(err, t("channels.email.loadFailed")));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api.listChannelAccounts()
      .then((data) => setEmailAccounts(data.accounts.filter((a) => a.channel === "email")))
      .catch(() => { /* the account link is optional */ });
  }, []);

  const add = async () => {
    setBusy(true);
    try {
      const res = await api.addEmailDomain({
        domain: domain.trim(),
        ...(accountId ? { channelAccountId: accountId } : {}),
        ...(resendId.trim() ? { resendDomainId: resendId.trim() } : {}),
      });
      pushToast("ok", t("channels.email.added", { domain: res.domain.domain }));
      setDomain("");
      setResendId("");
      await load();
    } catch (err) {
      pushToast("err", errText(err, t("channels.email.addFailed")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: WorkspaceDomain) => {
    setBusy(true);
    try {
      await api.deleteEmailDomain(d.id);
      pushToast("ok", t("channels.email.deleted", { domain: d.domain }));
      await load();
    } catch (err) {
      pushToast("err", errText(err, t("channels.email.deleteFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <div className="font-medium text-sm">{t("channels.email.title")}</div>
      <p className={`mt-1 ${mutedCls}`}>{t("channels.email.body")}</p>
      {domains.length === 0 ? (
        <div className="mt-3 text-sm text-slate-400 dark:text-slate-500">{t("channels.email.domainsEmpty")}</div>
      ) : (
        <div className="mt-3 space-y-2">
          {domains.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm dark:border-slate-700">
              <span className="font-mono text-xs">{d.domain}</span>
              <span className={chipCls}>{d.status}</span>
              <button
                onClick={() => void remove(d)}
                disabled={busy}
                className="ml-auto text-xs text-red-600 underline disabled:opacity-50 dark:text-red-400"
              >
                {t("common.delete")}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-2">
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder={t("channels.email.domainPlaceholder")}
          className={inputCls}
        />
        {emailAccounts.length > 0 && (
          <div>
            <label className={labelCls}>{t("channels.email.accountLabel")}</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls}>
              <option value="">-</option>
              {emailAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.displayName ?? a.externalId}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls}>{t("channels.email.resendIdLabel")}</label>
          <input value={resendId} onChange={(e) => setResendId(e.target.value)} className={inputCls} />
        </div>
        <button onClick={() => void add()} disabled={busy || !domain.trim()} className={primaryBtn}>
          {t("channels.email.addButton")}
        </button>
      </div>
    </div>
  );
}

function ChannelsPage() {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [tgLabel, setTgLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPages, setPendingPages] = useState<Array<{ id: string; name: string }> | null>(null);
  const [copied, setCopied] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);
  const [disconnectBusyId, setDisconnectBusyId] = useState<string | null>(null);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);
  const [purgeBusyId, setPurgeBusyId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [acc, cfg] = await Promise.all([api.listChannelAccounts(), api.getPublicConfig()]);
      setAccounts(acc.accounts);
      setConfig(cfg);
      setError(null);
    } catch (err) {
      setError(errText(err, t("channels.loadFailed")));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  // The connect modal closes on Escape while open.
  useEffect(() => {
    if (!connectOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setConnectOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connectOpen]);

  // A pending Messenger Page selection (OAuth round-trip) opens the
  // connect modal so the picker stays discoverable.
  useEffect(() => {
    if (pendingPages !== null) setConnectOpen(true);
  }, [pendingPages]);

  // OAuth round-trip signals arrive in the hash: #/channels?connected=...
  useEffect(() => {
    const hash = window.location.hash;
    const qIndex = hash.indexOf("?");
    if (qIndex < 0) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const connected = params.get("connected");
    const errorCode = params.get("error");
    if (connected) {
      const text = t("channels.connectedBanner", { channel: connected });
      setBanner({ kind: "ok", text });
      pushToast("ok", text);
      void load();
    } else if (errorCode) {
      const reasonKey = `channels.error.${errorCode}` as never;
      const text = t("channels.errorBanner", { reason: t(reasonKey) });
      setBanner({ kind: "err", text });
      pushToast("err", text);
    }
    if (params.get("messenger") === "select") {
      api.getMessengerPendingPages()
        .then((res) => setPendingPages(res.pages))
        .catch(() => setPendingPages([]));
    }
    history.replaceState(null, "", window.location.pathname);
  }, [t, load]);

  const connectTelegram = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.connectTelegram({ botToken: tgToken.trim(), label: tgLabel.trim() || undefined });
      const text = t("channels.telegram.connected", { name: res.account.displayName });
      setNotice(text);
      pushToast("ok", text);
      setTgToken("");
      setTgLabel("");
      await load();
      setConnectOpen(false);
    } catch (err) {
      const text = errText(err, t("channels.telegram.connectFailed"));
      setError(text);
      pushToast("err", text);
    } finally {
      setBusy(false);
    }
  };

  const launchWhatsApp = async () => {
    if (!config?.metaAppId || !config.whatsappEmbeddedConfigId) return;
    setError(null);
    try {
      await loadFacebookSdk(config.metaAppId);
      // Embedded Signup session info (phone/waba ids) arrives via postMessage.
      const sessionPromise = new Promise<{ phoneNumberId?: string; wabaId?: string; isCoexistence?: boolean }>((resolve) => {
        const handler = (event: MessageEvent) => {
          if (!/facebook\.com$/.test(new URL(event.origin).hostname)) return;
          try {
            const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
            if (data?.type === "WA_EMBEDDED_SIGNUP") {
              window.removeEventListener("message", handler);
              const d = (data.data ?? {}) as Record<string, unknown>;
              resolve({
                phoneNumberId: d.phone_number_id as string | undefined,
                wabaId: d.waba_id as string | undefined,
                isCoexistence: Boolean(d.is_coexistence),
              });
            }
          } catch { /* not a signup message */ }
        };
        window.addEventListener("message", handler);
        setTimeout(() => resolve({}), 10 * 60 * 1000);
      });
      const code = await new Promise<string | null>((resolve) => {
        window.FB?.login((res) => resolve(res.authResponse?.code ?? null), {
          config_id: config.whatsappEmbeddedConfigId,
          response_type: "code",
          override_default_response_type: true,
          extras: { setup: {} },
        });
      });
      if (!code) {
        const text = t("channels.whatsapp.noCode");
        setError(text);
        pushToast("err", text);
        return;
      }
      const session = await Promise.race([
        sessionPromise,
        new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 1500)),
      ]);
      await api.exchangeWhatsAppSignup({ code, sessionInfo: session });
      const text = t("channels.whatsapp.exchanged");
      setNotice(text);
      pushToast("ok", text);
      await load();
      setConnectOpen(false);
    } catch (err) {
      const text = errText(err, t("channels.whatsapp.exchangeFailed"));
      setError(text);
      pushToast("err", text);
    }
  };

  const selectPage = async (pageId: string) => {
    setBusy(true);
    try {
      await api.selectMessengerPage(pageId);
      setPendingPages(null);
      const text = t("channels.connectedBanner", { channel: "messenger" });
      setBanner({ kind: "ok", text });
      pushToast("ok", text);
      await load();
    } catch (err) {
      const text = errText(err, t("channels.messenger.selectFailed"));
      setError(text);
      pushToast("err", text);
    } finally {
      setBusy(false);
    }
  };

  const oauthHref = (channel: string, extra = "") => {
    const params = new URLSearchParams(extra.startsWith("?") ? extra.slice(1) : extra);
    params.set("workspace_id", workspaceId);
    return `${BASE_URL}/channels/${channel}/oauth/start?${params.toString()}`;
  };
  const workspaceId = getWorkspaceId();
  const widgetSnippet = `<script src="${window.location.origin}/widget.js" data-workspace-id="${workspaceId}" data-api-url="${window.location.origin}/api" data-lang="en" data-theme="auto" async></script>`;

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(widgetSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable in this browser context */ }
  };

  const disconnect = async (a: ChannelAccount) => {
    setDisconnectBusyId(a.id);
    try {
      const res = await api.deleteChannelAccount(a.id);
      // "deleted": the account had no data and is gone entirely.
      // "disconnected": history exists - the account is soft-disconnected
      // and its card stays (with the disconnected badge) after reload.
      pushToast("ok", t(res.mode === "disconnected" ? "channels.disconnectedKeptData" : "channels.disconnected", {
        name: a.displayName ?? a.channel,
      }));
      setConfirmDisconnectId(null);
      await load();
    } catch (err) {
      pushToast("err", errText(err, t("channels.disconnectFailed")));
    } finally {
      setDisconnectBusyId(null);
    }
  };

  const purgeAccount = async (a: ChannelAccount) => {
    setPurgeBusyId(a.id);
    try {
      await api.deleteChannelAccount(a.id, true);
      pushToast("ok", t("channels.purged", { name: a.displayName ?? a.channel }));
      setConfirmPurgeId(null);
      await load();
    } catch (err) {
      pushToast("err", errText(err, t("channels.purgeFailed")));
    } finally {
      setPurgeBusyId(null);
    }
  };

  const connectCard = "rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900";

  const filteredAccounts = platformFilter === "all" ? accounts : accounts.filter((a) => a.channel === platformFilter);
  const pillBase = "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors";
  const pillActive = "border-sky-400 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-200";
  const pillInactive = "border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300";

  return (
    <div className="max-w-[1400px]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <PageTitle title={t("channels.title")} subtitle={t("channels.subtitle")} />
        </div>
        <button
          type="button"
          onClick={() => setConnectOpen(true)}
          className="shrink-0 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900"
        >
          {`+ ${t("channels.connectAccount")}`}
        </button>
      </div>
      {banner && (
        <div className="mt-4 max-w-3xl">
          {banner.kind === "ok" ? <NoticeBox>{banner.text}</NoticeBox> : <ErrorBox error={banner.text} />}
        </div>
      )}
      {error && <div className="mt-4 max-w-3xl"><ErrorBox error={error} /></div>}
      {notice && <div className="mt-4 max-w-3xl"><NoticeBox>{notice}</NoticeBox></div>}

      <h2 className="mt-6 text-base font-semibold">{t("channels.connectedTitle")}</h2>
      {accounts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setPlatformFilter("all")}
            className={`${pillBase} ${platformFilter === "all" ? pillActive : pillInactive}`}
          >
            {`${t("channels.allPlatforms")} (${accounts.length})`}
          </button>
          {CHANNEL_ORDER.filter((ch) => accounts.some((a) => a.channel === ch)).map((ch) => {
            const meta = channelMeta(ch);
            const count = accounts.filter((a) => a.channel === ch).length;
            return (
              <button
                key={ch}
                type="button"
                onClick={() => setPlatformFilter(ch)}
                className={`${pillBase} ${platformFilter === ch ? pillActive : pillInactive}`}
              >
                <span className="font-semibold">{meta.glyph}</span>
                {`${meta.label} (${count})`}
              </button>
            );
          })}
          {accounts
            .map((a) => a.channel)
            .filter((ch, idx, arr) => !(CHANNEL_ORDER as readonly string[]).includes(ch) && arr.indexOf(ch) === idx)
            .map((ch) => {
              const meta = channelMeta(ch);
              const count = accounts.filter((a) => a.channel === ch).length;
              return (
                <button
                  key={ch}
                  type="button"
                  onClick={() => setPlatformFilter(ch)}
                  className={`${pillBase} ${platformFilter === ch ? pillActive : pillInactive}`}
                >
                  <span className="font-semibold">{meta.glyph}</span>
                  {`${meta.label} (${count})`}
                </button>
              );
            })}
        </div>
      )}
      {accounts.length === 0 ? (
        !error && (
          <div className="mt-3">
            <EmptyState>{t("channels.connectedEmpty")}</EmptyState>
          </div>
        )
      ) : filteredAccounts.length === 0 ? (
        <div className="mt-3">
          <EmptyState>{t("channels.connectedEmpty")}</EmptyState>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredAccounts.map((a) => {
            const meta = channelMeta(a.channel);
            const handle = a.displayName ?? a.externalId;
            return (
              <div key={a.id} className={`flex flex-col ${cardCls} p-4`}>
                <div className="flex items-center gap-2.5">
                  <ChannelAccountAvatar account={a} />
                  <span className="font-medium text-sm">{meta.label}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      a.status === "connected"
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                    }`}
                  >
                    {a.status}
                  </span>
                  <span className="ml-auto" title={a.authMode ?? a.externalId}>
                    <svg className="h-4 w-4 text-slate-300 dark:text-slate-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                  </span>
                </div>
                <div className="mt-3 truncate font-semibold" title={handle}>{handle}</div>
                <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  <span>{t("channels.connectedOn", { date: new Date(a.createdAt).toLocaleDateString() })}</span>
                </div>
                <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  {a.hasCredential ? t("channels.hasCredential") : t("channels.noCredential")}
                  {a.tokenExpiresAt ? ` · ${t("channels.expires", { date: new Date(a.tokenExpiresAt).toLocaleDateString() })}` : ""}
                </div>
                {a.channel === "whatsapp" && a.isCoexistence && (
                  <div className="mt-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300">{t("channels.coexistence")}</span>
                  </div>
                )}
                {a.channel === "whatsapp" && <CatalogSyncSection accountId={a.id} />}
                {a.status === "disconnected" && a.purgeAt && (
                  <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                    {t("channels.autoPurgeNote", { date: new Date(a.purgeAt).toLocaleDateString() })}
                  </p>
                )}
                <div className="mt-auto pt-4">
                  {a.status === "disconnected" ? (
                    confirmPurgeId === a.id ? (
                      <div>
                        <p className="text-xs leading-relaxed text-red-600 dark:text-red-400">
                          {t("channels.deletePermanentlyWarning")}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => void purgeAccount(a)}
                            disabled={purgeBusyId === a.id}
                            className="flex-1 rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
                          >
                            {t("channels.deletePermanentlyConfirm")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmPurgeId(null)}
                            className="rounded-full border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
                          >
                            {t("common.cancel")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmPurgeId(a.id)}
                        className="w-full rounded-full border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        {t("channels.deletePermanently")}
                      </button>
                    )
                  ) : confirmDisconnectId === a.id ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void disconnect(a)}
                        disabled={disconnectBusyId === a.id}
                        className="flex-1 rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
                      >
                        {t("channels.disconnectConfirm")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDisconnectId(null)}
                        className="rounded-full border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDisconnectId(a.id)}
                      className="w-full rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-red-300 hover:text-red-600 dark:border-slate-700 dark:text-slate-200 dark:hover:border-red-900 dark:hover:text-red-400"
                    >
                      {t("channels.disconnect")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {connectOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          onClick={() => setConnectOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("channels.connectTitle")}
            className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-base font-semibold">{t("channels.connectTitle")}</h2>
              <button
                type="button"
                onClick={() => setConnectOpen(false)}
                aria-label={t("common.close")}
                className="-mr-1 -mt-1 rounded-full px-2.5 py-1 text-lg leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                ×
              </button>
            </div>
      {pendingPages !== null && (
        <div className="mt-4 rounded-lg border border-sky-300 bg-sky-50 p-4 dark:border-sky-900 dark:bg-sky-950">
          <div className="font-medium text-sm text-sky-900 dark:text-sky-100">{t("channels.messenger.selectTitle")}</div>
          <p className="mt-1 text-sm text-sky-800 dark:text-sky-200">{t("channels.messenger.selectBody")}</p>
          <div className="mt-3 space-y-2">
            {pendingPages.map((page) => (
              <div key={page.id} className="flex items-center justify-between rounded-md bg-white px-3 py-2 dark:bg-slate-900">
                <span className="text-sm">{page.name}</span>
                <button onClick={() => void selectPage(page.id)} disabled={busy} className="rounded-md bg-slate-900 text-white text-xs px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
                  {t("channels.messenger.selectButton")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className={connectCard}>
          <div className="font-medium text-sm">{t("channels.whatsapp.title")}</div>
          <p className={`mt-1 ${mutedCls}`}>{t("channels.whatsapp.body")}</p>
          {config?.metaAppId && config?.whatsappEmbeddedConfigId ? (
            <button onClick={() => void launchWhatsApp()} className={`mt-3 ${primaryBtn}`}>{t("channels.whatsapp.button")}</button>
          ) : (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {t("channels.whatsapp.notConfigured")}
            </div>
          )}
        </div>

        <div className={connectCard}>
          <div className="font-medium text-sm">{t("channels.telegram.title")}</div>
          <p className={`mt-1 ${mutedCls}`}>{t("channels.telegram.body")}</p>
          <div className="mt-3 space-y-2">
            <div>
              <label className={labelCls}>{t("channels.telegram.tokenLabel")}</label>
              <PasswordInput value={tgToken} onChange={setTgToken} placeholder="123456:ABC-..." />
            </div>
            <div>
              <label className={labelCls}>{t("channels.telegram.labelLabel")}</label>
              <input value={tgLabel} onChange={(e) => setTgLabel(e.target.value)} className={inputCls} />
            </div>
            <button onClick={() => void connectTelegram()} disabled={busy || tgToken.trim().length < 10} className={primaryBtn}>
              {t("channels.telegram.button")}
            </button>
          </div>
        </div>

        <div className={connectCard}>
          <div className="font-medium text-sm">{t("channels.instagram.title")}</div>
          <p className={`mt-1 ${mutedCls}`}>{t("channels.instagram.body")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={oauthHref("instagram", "?mode=instagram-login")} className={primaryBtn}>{t("channels.instagram.buttonIg")}</a>
            <a href={oauthHref("instagram", "?mode=facebook-login")} className={outlineBtn}>{t("channels.instagram.buttonFb")}</a>
          </div>
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">{t("channels.oauth.openNote", { provider: "Meta" })}</p>
        </div>

        <div className={connectCard}>
          <div className="font-medium text-sm">{t("channels.threads.title")}</div>
          <p className={`mt-1 ${mutedCls}`}>{t("channels.threads.body")}</p>
          <a href={oauthHref("threads")} className={`mt-3 inline-block ${primaryBtn}`}>{t("channels.threads.button")}</a>
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">{t("channels.oauth.openNote", { provider: "Threads" })}</p>
        </div>

        <div className={connectCard}>
          <div className="font-medium text-sm">{t("channels.messenger.title")}</div>
          <p className={`mt-1 ${mutedCls}`}>{t("channels.messenger.body")}</p>
          <a href={oauthHref("messenger")} className={`mt-3 inline-block ${primaryBtn}`}>{t("channels.messenger.button")}</a>
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">{t("channels.oauth.openNote", { provider: "Facebook" })}</p>
        </div>

        <div className={connectCard}>
          <div className="font-medium text-sm">{t("channels.tiktok.title")}</div>
          <p className={`mt-1 ${mutedCls}`}>{t("channels.tiktok.body")}</p>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t("channels.tiktok.hint")}</p>
          {config?.tiktokAppId ? (
            <>
              <a href={oauthHref("tiktok")} className={`mt-3 inline-block ${primaryBtn}`}>{t("channels.tiktok.button")}</a>
              <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">{t("channels.oauth.openNote", { provider: "TikTok" })}</p>
            </>
          ) : (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {t("channels.tiktok.notConfigured")}
            </div>
          )}
        </div>

        <div className={connectCard}>
          <div className="font-medium text-sm">{t("channels.webchat.title")}</div>
          <p className={`mt-1 ${mutedCls}`}>{t("channels.webchat.body")}</p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-50 p-3 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">{widgetSnippet}</pre>
          <button onClick={() => void copySnippet()} className={`mt-3 ${outlineBtn}`}>
            {copied ? t("channels.webchat.copied") : t("channels.webchat.copy")}
          </button>
        </div>

        <EmailDomainsCard className={connectCard} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- Settings

const ROLES = ["owner", "admin", "member", "agent"];

// ----------------------------------------------------------------- Growth

function GrowthPage() {
  const { t } = useI18n();
  const [links, setLinks] = useState<GrowthLink[]>([]);
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [accountId, setAccountId] = useState("");
  const [label, setLabel] = useState("");
  const [prefilledText, setPrefilledText] = useState("");
  const [boundFlowId, setBoundFlowId] = useState("");
  const [targetRef, setTargetRef] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [qrSvgs, setQrSvgs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ln, acc, fl] = await Promise.all([
        api.listGrowthLinks(), api.listChannelAccounts(), api.listFlows(),
      ]);
      setLinks(ln.links);
      setAccounts(acc.accounts);
      setFlows(fl.flows);
      setError(null);
    } catch (err) {
      setError(errText(err, t("growth.loadFailed")));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const kind = selectedAccount?.channel ?? "";

  const create = async () => {
    if (!accountId || !label.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.createGrowthLink({
        channelAccountId: accountId,
        label: label.trim(),
        ...(prefilledText.trim() ? { prefilledText: prefilledText.trim() } : {}),
        ...(boundFlowId ? { boundFlowId } : {}),
        ...(targetRef.trim() ? { targetRef: targetRef.trim() } : {}),
        ...(targetUrl.trim() ? { targetUrl: targetUrl.trim() } : {}),
      });
      setLabel("");
      setPrefilledText("");
      setTargetRef("");
      setTargetUrl("");
      setBoundFlowId("");
      setNotice(t("growth.created"));
      await load();
    } catch (err) {
      setError(errText(err, t("growth.createFailed")));
    } finally { setBusy(false); }
  };

  const remove = async (link: GrowthLink) => {
    if (!window.confirm(t("growth.deleteConfirm"))) return;
    try {
      await api.deleteGrowthLink(link.id);
      await load();
    } catch (err) {
      setError(errText(err, t("growth.deleteFailed")));
    }
  };

  const toggleQr = async (link: GrowthLink) => {
    if (qrSvgs[link.id]) {
      setQrSvgs((prev) => { const next = { ...prev }; delete next[link.id]; return next; });
      return;
    }
    try {
      const svg = await api.growthLinkQrSvg(link.id);
      setQrSvgs((prev) => ({ ...prev, [link.id]: svg }));
    } catch (err) {
      setError(errText(err, t("growth.qrFailed")));
    }
  };

  return (
    <div>
      <PageTitle title={t("growth.title")} subtitle={t("growth.subtitle")} />
      {error && <div className="mt-4 max-w-3xl"><ErrorBox error={error} /></div>}
      {notice && <div className="mt-4 max-w-3xl"><NoticeBox>{notice}</NoticeBox></div>}

      <div className={`mt-6 ${cardCls} p-4 space-y-3 max-w-3xl`}>
        <div className="font-medium text-sm">{t("growth.createTitle")}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t("growth.account")}</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls}>
              <option value="">{t("growth.selectAccount")}</option>
              {accounts.filter((a) => a.channel !== "tiktok").map((a) => (
                <option key={a.id} value={a.id}>{a.channel} · {a.displayName ?? a.externalId}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t("growth.label")}</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("growth.labelPlaceholder")} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t("growth.prefilledText")}</label>
            <input value={prefilledText} onChange={(e) => setPrefilledText(e.target.value)} placeholder={t("growth.prefilledPlaceholder")} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t("growth.boundFlow")}</label>
            <select value={boundFlowId} onChange={(e) => setBoundFlowId(e.target.value)} className={inputCls}>
              <option value="">{t("growth.noBoundFlow")}</option>
              {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          {(kind === "whatsapp" || kind === "messenger" || kind === "telegram" || kind === "instagram") && (
            <div>
              <label className={labelCls}>{t("growth.targetRef")}</label>
              <input value={targetRef} onChange={(e) => setTargetRef(e.target.value)} placeholder={t("growth.targetRefPlaceholder")} className={inputCls} />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("growth.targetRefHint")}</p>
            </div>
          )}
          {kind === "webchat" && (
            <div>
              <label className={labelCls}>{t("growth.targetUrl")}</label>
              <input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="https://..." className={inputCls} />
            </div>
          )}
        </div>
        <button onClick={() => void create()} disabled={busy || !accountId || !label.trim()} className={primaryBtn}>
          {t("growth.create")}
        </button>
      </div>

      <div className={`mt-4 ${cardCls} overflow-hidden`}>
        {links.length === 0 && !error ? (
          <div className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">{t("growth.empty")}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">{t("growth.label")}</th>
                <th className="px-4 py-2 font-medium">{t("common.channel")}</th>
                <th className="px-4 py-2 font-medium">{t("growth.shortUrl")}</th>
                <th className="px-4 py-2 font-medium">{t("growth.clicks")}</th>
                <th className="px-4 py-2 font-medium">{t("growth.conversions")}</th>
                <th className="px-4 py-2 font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                  <td className="px-4 py-2">{link.label}</td>
                  <td className="px-4 py-2">{link.kind}</td>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2">
                      <code className="text-xs break-all">{link.shortUrl}</code>
                      <button onClick={() => void navigator.clipboard.writeText(link.shortUrl)} className="text-xs text-slate-600 underline dark:text-slate-300">
                        {t("common.copy")}
                      </button>
                    </span>
                    {qrSvgs[link.id] && (
                      <span className="mt-2 flex items-start gap-2">
                        <span className="block h-24 w-24 bg-white p-1 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: qrSvgs[link.id] ?? "" }} />
                        <button
                          onClick={() => downloadTextFile(`qr-${link.slug}.svg`, qrSvgs[link.id] ?? "", "image/svg+xml")}
                          className="text-xs text-slate-600 underline dark:text-slate-300"
                        >
                          {t("growth.qrDownload")}
                        </button>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{link.clicks}</td>
                  <td className="px-4 py-2">{link.conversions}</td>
                  <td className="px-4 py-2">
                    <span className="flex gap-2">
                      <button onClick={() => void toggleQr(link)} className="text-xs text-slate-600 underline dark:text-slate-300">
                        {t("growth.qr")}
                      </button>
                      <button onClick={() => void remove(link)} className="text-xs text-red-600 underline dark:text-red-400">
                        {t("common.delete")}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------- Platform admin
// Operator panel (deployment-scoped, NOT workspace-scoped). Rendered
// only for users with isPlatformAdmin; every /admin route also enforces
// the flag server-side (401/403 otherwise).

type AdminTab = "overview" | "users" | "workspaces" | "billing" | "settings" | "audit";

const ADMIN_TABS: Array<{ id: AdminTab; labelKey: Parameters<ReturnType<typeof useI18n>["t"]>[0] }> = [
  { id: "overview", labelKey: "admin.tab.overview" },
  { id: "users", labelKey: "admin.tab.users" },
  { id: "workspaces", labelKey: "admin.tab.workspaces" },
  { id: "billing", labelKey: "admin.tab.billing" },
  { id: "settings", labelKey: "admin.tab.settings" },
  { id: "audit", labelKey: "admin.tab.audit" },
];

/** Managed-setting groups are rendered by AdminSettingsView: meta /
 * instagram / threads / tiktok as platform cards, the rest as plain
 * group cards (both lists declared next to that view). */

const adminGroupLabelKey = (group: string): "admin.group.meta" | "admin.group.threads" | "admin.group.instagram" | "admin.group.tiktok" | "admin.group.telegram" | "admin.group.storage" | "admin.group.email" | "admin.group.ai" => {
  switch (group) {
    case "threads": return "admin.group.threads";
    case "instagram": return "admin.group.instagram";
    case "tiktok": return "admin.group.tiktok";
    case "telegram": return "admin.group.telegram";
    case "storage": return "admin.group.storage";
    case "email": return "admin.group.email";
    case "ai": return "admin.group.ai";
    default: return "admin.group.meta";
  }
};

const fmtDateTime = (iso: string): string => new Date(iso).toLocaleString();

/** Any i18n key (for dynamically composed keys, e.g. per-webhook hints). */
type I18nKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];

const adminGroupDescKey = (group: string): I18nKey => `admin.groupDesc.${group}` as I18nKey;

/** The i18n translate function, passed to presentational admin components. */
type AdminTranslate = ReturnType<typeof useI18n>["t"];

/** One URL sub-box in a platform card; url absent = note-only box. */
interface AdminUrlBoxSpec {
  id: string;
  label: string;
  url?: string;
  note: string;
}

/**
 * Inset URL panel (reference layout): a label, the URL in mono with a
 * copy button, and a note saying where it is registered / where its
 * verify token lives. Note-only boxes (no url) state honestly that
 * Botara serves no such URL yet instead of inventing one.
 */
function AdminUrlBox({ spec, onCopy, t }: { spec: AdminUrlBoxSpec; onCopy: (url: string) => void; t: AdminTranslate }) {
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
      <div className="text-xs font-medium text-slate-600 dark:text-slate-300">{spec.label}</div>
      {spec.url && (
        <div className="mt-1 flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-slate-700 dark:text-slate-200">{spec.url}</code>
          <button
            type="button"
            onClick={() => onCopy(spec.url as string)}
            className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"
          >
            {t("admin.connection.copy")}
          </button>
        </div>
      )}
      <p className="mt-1 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">{spec.note}</p>
    </div>
  );
}

/**
 * Platform card (reference layout): header with monogram, name, an
 * honest configured badge and subtitle; the card's URL sub-boxes from
 * GET /admin/connection-info; then the group's credential fields and
 * a per-card Save.
 */
function AdminPlatformCard({ title, monogram, configured, boxes, infoFailed, onCopy, onSave, saving, hasChanges, t, children }: {
  title: string;
  monogram: string;
  configured: boolean;
  boxes: AdminUrlBoxSpec[] | null;
  infoFailed: boolean;
  onCopy: (url: string) => void;
  onSave: () => void;
  saving: boolean;
  hasChanges: boolean;
  t: AdminTranslate;
  children: ReactNode;
}) {
  const badgeCls = configured
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400";
  return (
    <div className={`mt-4 ${cardCls} p-4`}>
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {monogram}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeCls}`}>
              {t(configured ? "admin.platform.badge.configured" : "admin.platform.badge.notConfigured")}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t(configured ? "admin.platform.subtitle.configured" : "admin.platform.subtitle.notConfigured")}
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {infoFailed ? (
          <ErrorBox error={t("admin.connection.loadFailed")} />
        ) : boxes === null ? (
          <p className={mutedCls}>{t("app.loading")}</p>
        ) : (
          boxes.map((spec) => <AdminUrlBox key={spec.id} spec={spec} onCopy={onCopy} t={t} />)
        )}
      </div>
      <div className="mt-4 space-y-4">{children}</div>
      <button type="button" onClick={onSave} disabled={saving || !hasChanges} className={`mt-4 ${primaryBtn}`}>
        {saving ? t("common.saving") : t("common.save")}
      </button>
    </div>
  );
}

/**
 * One credential field: label + source chip, hint, the input (prefilled
 * for non-secrets; empty with a masked "saved" placeholder for
 * secrets), and - for panel-saved values only - the red "delete saved
 * value (back to env)" text action. Env values are not panel-clearable.
 */
function AdminSettingField({ setting, value, onChange, onClear, clearing, sourceLabel, t }: {
  setting: AdminSettingView;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  clearing: boolean;
  sourceLabel: string;
  t: AdminTranslate;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label className={labelCls} htmlFor={`admin-setting-${setting.key}`}>
          {setting.label} <span className="font-mono normal-case">({setting.key})</span>
        </label>
        <span className={chipCls}>{sourceLabel}</span>
      </div>
      {setting.hint && <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">{setting.hint}</p>}
      <input
        id={`admin-setting-${setting.key}`}
        type={setting.secret ? "password" : "text"}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={setting.secret && setting.isSet ? t("admin.settings.placeholderSavedMasked") : t("admin.settings.placeholderNotSet")}
        className={inputCls}
      />
      {setting.source === "db" && (
        <button
          type="button"
          onClick={onClear}
          disabled={clearing}
          className="mt-1 text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
        >
          {t("admin.settings.clearSaved")}
        </button>
      )}
      {setting.updatedAt && (
        <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
          {t("common.updated")}: {fmtDateTime(setting.updatedAt)}
        </p>
      )}
    </div>
  );
}

/**
 * Slim card for the webhook URLs that do not belong to a platform app
 * card: Telegram (auto-configured at connect time) and Resend.
 */
function AdminOtherEndpointsCard({ info, failed, onCopy, t }: {
  info: ConnectionInfo | null;
  failed: boolean;
  onCopy: (url: string) => void;
  t: AdminTranslate;
}) {
  const rows = info ? info.webhooks.filter((w) => w.id === "telegram" || w.id === "resend") : [];
  return (
    <div className={`mt-4 ${cardCls} p-4`}>
      <div className="font-medium text-sm">{t("admin.platform.otherEndpoints")}</div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("admin.platform.otherEndpointsNote")}</p>
      {failed && <div className="mt-3"><ErrorBox error={t("admin.connection.loadFailed")} /></div>}
      {info && (
        <div className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="w-36 shrink-0 text-xs font-medium text-slate-600 dark:text-slate-300">{w.id}</span>
              <code className="min-w-0 flex-1 break-all rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">{w.url}</code>
              <button
                type="button"
                onClick={() => onCopy(w.url)}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"
              >
                {t("admin.connection.copy")}
              </button>
              <span className="w-full text-[11px] text-slate-400 dark:text-slate-500">
                {t(`admin.connection.hint.webhook.${w.id}` as I18nKey)}
                {w.autoConfigured ? ` ${t("admin.connection.autoConfigured")}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AdminPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<AdminTab>("overview");
  return (
    <div>
      <PageTitle title={t("admin.title")} subtitle={t("admin.subtitle")} />
      <div className="mt-6 flex flex-wrap gap-2">
        {ADMIN_TABS.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={tab === item.id ? primaryBtn : outlineBtn}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {tab === "overview" && <AdminOverviewView />}
        {tab === "users" && <AdminUsersView />}
        {tab === "workspaces" && <AdminWorkspacesView />}
        {tab === "billing" && <AdminBillingView />}
        {tab === "settings" && <AdminSettingsView />}
        {tab === "audit" && <AdminAuditView />}
      </div>
    </div>
  );
}

function AdminOverviewView() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminOverview()
      .then((data) => { setOverview(data); setError(null); })
      .catch((err) => setError(errText(err, t("admin.overviewLoadFailed"))));
  }, [t]);

  const cards: Array<{ label: string; value: number }> = overview ? [
    { label: t("admin.totalUsers"), value: overview.totals.users },
    { label: t("admin.activeUsers7d"), value: overview.activeUsers.last7d },
    { label: t("admin.activeUsers30d"), value: overview.activeUsers.last30d },
    { label: t("admin.totalWorkspaces"), value: overview.totals.workspaces },
    { label: t("admin.channelAccounts"), value: overview.totals.channelAccounts },
    { label: t("admin.messages"), value: overview.totals.messages },
    { label: t("admin.messages30d"), value: overview.totals.messagesLast30d },
  ] : [];

  return (
    <div>
      {error && <div className="max-w-xl"><ErrorBox error={error} /></div>}
      {!overview && !error && <p className={mutedCls}>{t("app.loading")}</p>}
      {overview && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 max-w-4xl">
            {cards.map((card) => (
              <div key={card.label} className={`${cardCls} p-4`}>
                <div className="text-2xl font-bold">{card.value}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{card.label}</div>
              </div>
            ))}
          </div>
          <div className={`mt-4 max-w-4xl ${cardCls} p-4`}>
            <div className="font-medium text-sm">{t("admin.byChannel")}</div>
            {overview.channelAccountsByChannel.length === 0 ? (
              <p className={`mt-1 ${mutedCls}`}>{t("admin.byChannelEmpty")}</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {overview.channelAccountsByChannel.map((row) => (
                  <li key={row.channel} className="flex justify-between max-w-xs">
                    <span className="text-slate-500 dark:text-slate-400">{row.channel}</span>
                    <span className="font-medium">{row.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={`mt-4 max-w-4xl ${cardCls} p-4`}>
            <div className="font-medium text-sm">{t("admin.recentRegistrations")}</div>
            {overview.recentRegistrations.length === 0 ? (
              <p className={`mt-2 ${mutedCls}`}>{t("admin.recentEmpty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
                {overview.recentRegistrations.map((reg) => (
                  <li key={reg.id} className="flex items-center justify-between py-2 text-sm">
                    <span>{reg.email}{reg.name ? ` · ${reg.name}` : ""}</span>
                    <span className="text-xs text-slate-400">{fmtDateTime(reg.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AdminUsersView() {
  const { t } = useI18n();
  const [users, setUsers] = useState<AdminUserItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.adminUsers();
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError(errText(err, t("admin.users.loadFailed")));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const toggleAdmin = async (target: AdminUserItem) => {
    const grant = !target.isPlatformAdmin;
    if (!window.confirm(grant ? t("admin.grantConfirm") : t("admin.revokeConfirm"))) return;
    setBusyId(target.id);
    setError(null);
    try {
      await api.adminSetPlatformAdmin(target.id, grant);
      await load();
    } catch (err) {
      // errText surfaces the server message (e.g. the 409 last-admin guard).
      setError(errText(err, t("admin.users.actionFailed")));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      {error && <div className="max-w-2xl"><ErrorBox error={error} /></div>}
      {!users && !error && <p className={mutedCls}>{t("app.loading")}</p>}
      {users && (
        <div className={`${cardCls} overflow-hidden max-w-5xl`}>
          {users.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">{t("admin.users.empty")}</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("admin.users.email")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.users.name")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.users.workspaces")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.users.created")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.users.lastLogin")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.users.platformAdmin")}</th>
                  <th className="px-4 py-2 font-medium">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800 align-top">
                    <td className="px-4 py-2">{u.email}</td>
                    <td className="px-4 py-2">{u.name ?? "-"}</td>
                    <td className="px-4 py-2">
                      <span className="flex gap-1 flex-wrap">
                        {u.workspaces.map((w) => (
                          <span key={w.id} className={chipCls}>{w.name} ({w.role})</span>
                        ))}
                      </span>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(u.createdAt)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : t("admin.users.neverLoggedIn")}</td>
                    <td className="px-4 py-2">
                      {u.isPlatformAdmin && <span className={chipCls}>{t("admin.platformAdminBadge")}</span>}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <button
                        onClick={() => void toggleAdmin(u)}
                        disabled={busyId === u.id}
                        className={`text-xs underline disabled:opacity-50 ${u.isPlatformAdmin ? "text-red-600 dark:text-red-400" : "text-slate-900 dark:text-slate-100"}`}
                      >
                        {u.isPlatformAdmin ? t("admin.revoke") : t("admin.grant")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function AdminWorkspacesView() {
  const { t } = useI18n();
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminWorkspaces()
      .then((data) => { setWorkspaces(data.workspaces); setError(null); })
      .catch((err) => setError(errText(err, t("admin.workspaces.loadFailed"))));
  }, [t]);

  return (
    <div>
      {error && <div className="max-w-2xl"><ErrorBox error={error} /></div>}
      {!workspaces && !error && <p className={mutedCls}>{t("app.loading")}</p>}
      {workspaces && (
        <div className={`${cardCls} overflow-hidden max-w-5xl`}>
          {workspaces.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">{t("admin.workspaces.empty")}</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("admin.workspaces.name")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.workspaces.owner")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.workspaces.members")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.workspaces.channelAccounts")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.workspaces.messages")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.workspaces.created")}</th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((w) => (
                  <tr key={w.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2">{w.name} <span className="text-xs text-slate-400">({w.slug})</span></td>
                    <td className="px-4 py-2">{w.ownerEmail ?? "-"}</td>
                    <td className="px-4 py-2">{w.memberCount}</td>
                    <td className="px-4 py-2">{w.channelAccountCount}</td>
                    <td className="px-4 py-2">{w.messageCount}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(w.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const ADMIN_BILLING_PERIODS: Array<{ days: number; labelKey: "admin.billing.days7" | "admin.billing.days30" | "admin.billing.days90" }> = [
  { days: 7, labelKey: "admin.billing.days7" },
  { days: 30, labelKey: "admin.billing.days30" },
  { days: 90, labelKey: "admin.billing.days90" },
];

function AdminBillingView() {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [billing, setBilling] = useState<AdminBilling | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBilling(null);
    api.adminBilling(days)
      .then((data) => { if (!cancelled) { setBilling(data); setError(null); } })
      .catch((err) => { if (!cancelled) setError(errText(err, t("admin.billing.loadFailed"))); });
    return () => { cancelled = true; };
  }, [t, days]);

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {ADMIN_BILLING_PERIODS.map((period) => (
          <button
            key={period.days}
            onClick={() => setDays(period.days)}
            className={days === period.days ? primaryBtn : outlineBtn}
          >
            {t(period.labelKey)}
          </button>
        ))}
      </div>
      {error && <div className="mt-4 max-w-2xl"><ErrorBox error={error} /></div>}
      {!billing && !error && <p className={`mt-4 ${mutedCls}`}>{t("app.loading")}</p>}
      {billing && (
        <>
          <div className={`mt-4 max-w-5xl ${cardCls} overflow-hidden`}>
            {billing.workspaces.length === 0 ? (
              <div className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">{t("admin.billing.empty")}</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t("admin.billing.workspace")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.billing.category")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.billing.units")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.billing.entries")}</th>
                    <th className="px-4 py-2 font-medium">{t("admin.billing.cost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {billing.workspaces.map((ws) => (
                    <Fragment key={`${ws.workspaceId}-${ws.currency}`}>
                      <tr className="border-t border-slate-100 dark:border-slate-800 font-medium">
                        <td className="px-4 py-2">{ws.workspaceName} <span className={chipCls}>{ws.currency}</span></td>
                        <td className="px-4 py-2">{t("admin.billing.total")}</td>
                        <td className="px-4 py-2">{ws.units}</td>
                        <td className="px-4 py-2">{ws.entries}</td>
                        <td className="px-4 py-2">{ws.amount.toFixed(4)}</td>
                      </tr>
                      {ws.byCategory.map((cat) => (
                        <tr key={`${ws.workspaceId}-${ws.currency}-${cat.category}`} className="text-slate-500 dark:text-slate-400">
                          <td className="px-4 py-1.5" />
                          <td className="px-4 py-1.5">{cat.category}</td>
                          <td className="px-4 py-1.5">{cat.units}</td>
                          <td className="px-4 py-1.5">{cat.entries}</td>
                          <td className="px-4 py-1.5">{cat.amount.toFixed(4)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {billing.totals.length > 0 && (
            <div className={`mt-4 max-w-5xl ${cardCls} p-4`}>
              <div className="font-medium text-sm">{t("admin.billing.totals")}</div>
              <ul className="mt-2 space-y-1 text-sm">
                {billing.totals.map((row) => (
                  <li key={row.currency} className="flex justify-between max-w-md">
                    <span className="text-slate-500 dark:text-slate-400">{row.currency} · {row.units} · {row.entries}</span>
                    <span className="font-medium">{row.amount.toFixed(4)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Groups rendered as plain cards below the platform cards. */
const ADMIN_PLAIN_GROUPS = ["telegram", "storage", "email", "ai"] as const;

/** Platform cards, in display order, with their header monograms. */
const ADMIN_PLATFORM_CARDS: Array<{ group: PlatformCardGroup; monogram: string }> = [
  { group: "meta", monogram: "Me" },
  { group: "instagram", monogram: "Ig" },
  { group: "threads", monogram: "Th" },
  { group: "tiktok", monogram: "Tt" },
];

function AdminSettingsView() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AdminSettingView[] | null>(null);
  const [connInfo, setConnInfo] = useState<ConnectionInfo | null>(null);
  const [connFailed, setConnFailed] = useState(false);
  // Draft inputs keyed by setting key. A key ABSENT from this record is
  // untouched: non-secret inputs show their current value, secrets stay
  // empty. See admin-settings-model.ts for the draft semantics.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingGroup, setSavingGroup] = useState<string | null>(null);
  const [clearingKey, setClearingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.adminSettings();
      setSettings(data.settings);
      setError(null);
    } catch (err) {
      setError(errText(err, t("admin.settings.loadFailed")));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    api.adminConnectionInfo()
      .then((data) => { if (!cancelled) setConnInfo(data); })
      .catch(() => { if (!cancelled) setConnFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const copyUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      pushToast("ok", t("admin.connection.copied"));
    } catch {
      pushToast("err", t("admin.connection.copyFailed"));
    }
  }, [t]);

  const sourceLabel = (setting: AdminSettingView): string =>
    setting.source === "db"
      ? t("admin.settings.sourcePanel")
      : setting.source === "env"
        ? t("admin.settings.sourceEnv")
        : t("admin.settings.sourceNotSet");

  const saveGroup = async (group: string) => {
    if (!settings) return;
    const updates: AdminSettingUpdate[] = buildGroupUpdates(settings, group, drafts);
    if (updates.length === 0) return;
    setSavingGroup(group);
    setError(null);
    setNotice(null);
    try {
      const res = await api.adminUpdateSettings(updates);
      setSettings(res.settings);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const u of updates) delete next[u.key];
        return next;
      });
      setNotice(t("admin.settings.saved"));
    } catch (err) {
      setError(errText(err, t("admin.settings.saveFailed")));
    } finally {
      setSavingGroup(null);
    }
  };

  const clearSetting = async (setting: AdminSettingView) => {
    if (!window.confirm(t("admin.settings.clearConfirm"))) return;
    setClearingKey(setting.key);
    setError(null);
    setNotice(null);
    try {
      const updates: AdminSettingUpdate[] = [{ key: setting.key, clear: true }];
      const res = await api.adminUpdateSettings(updates);
      setSettings(res.settings);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[setting.key];
        return next;
      });
      setNotice(t("admin.settings.saved"));
    } catch (err) {
      setError(errText(err, t("admin.settings.saveFailed")));
    } finally {
      setClearingKey(null);
    }
  };

  const renderField = (setting: AdminSettingView) => (
    <AdminSettingField
      key={setting.key}
      setting={setting}
      value={inputValueFor(setting, drafts)}
      onChange={(value) => setDrafts((prev) => ({ ...prev, [setting.key]: value }))}
      onClear={() => void clearSetting(setting)}
      clearing={clearingKey === setting.key}
      sourceLabel={sourceLabel(setting)}
      t={t}
    />
  );

  // URL sub-boxes per platform card, from GET /admin/connection-info
  // (null while it loads; each card shows its own failure state).
  const webhookById = (id: string) => connInfo?.webhooks.find((w) => w.id === id);
  const redirectById = (id: string) => connInfo?.oauthRedirects.find((o) => o.id === id);
  const boxLabel = (kind: "callback" | "webhook" | "deletion", qualifier?: string): string => {
    const baseKey = kind === "callback"
      ? "admin.platform.box.callback"
      : kind === "webhook"
        ? "admin.platform.box.webhook"
        : "admin.platform.box.dataDeletion";
    return qualifier ? `${t(baseKey)} — ${qualifier}` : t(baseKey);
  };
  const webhookNote = (id: string): string => {
    const w = webhookById(id);
    const hint = t(`admin.connection.hint.webhook.${id}` as I18nKey);
    return w?.verifyTokenKey ? `${hint} ${t("admin.connection.verifyToken", { key: w.verifyTokenKey })}` : hint;
  };
  const platformBoxes = (group: PlatformCardGroup): AdminUrlBoxSpec[] | null => {
    if (!connInfo) return null;
    const cb = (id: string, note: string, qualifier?: string): AdminUrlBoxSpec => ({
      id: `cb-${id}`, label: boxLabel("callback", qualifier), url: redirectById(id)?.url, note,
    });
    const wh = (id: string, note: string, qualifier?: string): AdminUrlBoxSpec => ({
      id: `wh-${id}`, label: boxLabel("webhook", qualifier), url: webhookById(id)?.url, note,
    });
    switch (group) {
      case "meta":
        return [
          cb("messenger", t("admin.platform.callbackNote.meta"), "Messenger"),
          cb("instagram", t("admin.platform.callbackNote.meta"), "Instagram"),
          wh("whatsapp", webhookNote("whatsapp"), "WhatsApp"),
          wh("messenger", webhookNote("messenger"), "Messenger"),
          wh("instagram", webhookNote("instagram"), "Instagram"),
          {
            id: "del-meta", label: boxLabel("deletion"), url: webhookById("meta-data-deletion")?.url,
            note: t("admin.connection.hint.webhook.meta-data-deletion"),
          },
        ];
      case "instagram":
        return [
          cb("instagram", t("admin.platform.note.instagramCallback")),
          wh("instagram", `${t("admin.platform.note.instagramWebhook")} ${webhookNote("instagram")}`),
          // Same shared deletion endpoint as the Meta card: it verifies
          // signed requests from all three app secrets, so this app's
          // console registers this very URL.
          {
            id: "del-instagram", label: boxLabel("deletion"), url: webhookById("meta-data-deletion")?.url,
            note: t("admin.platform.note.deletionInstagram"),
          },
        ];
      case "threads":
        return [
          cb("threads", t("admin.platform.callbackNote")),
          wh("threads", webhookNote("threads")),
          // Same shared deletion endpoint as the Meta card: it verifies
          // signed requests from all three app secrets, so this app's
          // console registers this very URL.
          {
            id: "del-threads", label: boxLabel("deletion"), url: webhookById("meta-data-deletion")?.url,
            note: t("admin.platform.note.deletionThreads"),
          },
        ];
      case "tiktok":
        return [
          cb("tiktok", t("admin.platform.callbackNote")),
          wh("tiktok", `${webhookNote("tiktok")} ${t("admin.platform.note.tiktokWebhook")}`),
        ];
    }
  };

  return (
    <div className="max-w-4xl">
      <p className={mutedCls}>{t("admin.settings.propagationNote")}</p>
      <p className={`mt-1 ${mutedCls}`}>{t("admin.settings.overrideNote")}</p>
      {error && <div className="mt-4"><ErrorBox error={error} /></div>}
      {notice && <div className="mt-4"><NoticeBox>{notice}</NoticeBox></div>}
      {!settings && !error && <p className={`mt-4 ${mutedCls}`}>{t("app.loading")}</p>}
      {settings && ADMIN_PLATFORM_CARDS.map(({ group, monogram }) => (
        <AdminPlatformCard
          key={group}
          title={t(adminGroupLabelKey(group))}
          monogram={monogram}
          configured={platformConfigured(group, settings)}
          boxes={connFailed ? [] : platformBoxes(group)}
          infoFailed={connFailed}
          onCopy={(url) => void copyUrl(url)}
          onSave={() => void saveGroup(group)}
          saving={savingGroup === group}
          hasChanges={groupHasChanges(settings, group, drafts)}
          t={t}
        >
          {settings.filter((s) => s.group === group).map(renderField)}
        </AdminPlatformCard>
      ))}
      <AdminOtherEndpointsCard info={connInfo} failed={connFailed} onCopy={(url) => void copyUrl(url)} t={t} />
      {settings && ADMIN_PLAIN_GROUPS.map((group) => {
        const groupSettings = settings.filter((s) => s.group === group);
        if (groupSettings.length === 0) return null;
        return (
          <div key={group} className={`mt-4 ${cardCls} p-4 space-y-4`}>
            <div>
              <div className="font-medium text-sm">{t(adminGroupLabelKey(group))}</div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t(adminGroupDescKey(group))}</p>
            </div>
            {groupSettings.map(renderField)}
            <button
              type="button"
              onClick={() => void saveGroup(group)}
              disabled={savingGroup === group || !groupHasChanges(settings, group, drafts)}
              className={primaryBtn}
            >
              {savingGroup === group ? t("common.saving") : t("common.save")}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function AdminAuditView() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<AdminAuditItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminAudit(50)
      .then((data) => { setEntries(data.entries); setError(null); })
      .catch((err) => setError(errText(err, t("admin.audit.loadFailed"))));
  }, [t]);

  return (
    <div>
      {error && <div className="max-w-2xl"><ErrorBox error={error} /></div>}
      {!entries && !error && <p className={mutedCls}>{t("app.loading")}</p>}
      {entries && (
        <div className={`${cardCls} overflow-hidden max-w-5xl`}>
          {entries.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">{t("admin.audit.empty")}</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("admin.audit.time")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.audit.actor")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.audit.action")}</th>
                  <th className="px-4 py-2 font-medium">{t("admin.audit.details")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-t border-slate-100 dark:border-slate-800 align-top">
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(entry.createdAt)}</td>
                    <td className="px-4 py-2">{entry.actorEmail ?? entry.userId ?? "-"}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{entry.action}</td>
                    <td className="px-4 py-2"><code className="text-xs break-all">{JSON.stringify(entry.details)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/** i18n keys for the API-token scope resources (adoption #5). */
const TOKEN_RESOURCE_LABEL_KEYS = {
  contacts: "settings.tokenResource.contacts",
  conversations: "settings.tokenResource.conversations",
  broadcasts: "settings.tokenResource.broadcasts",
  flows: "settings.tokenResource.flows",
  sequences: "settings.tokenResource.sequences",
  deals: "settings.tokenResource.deals",
  templates: "settings.tokenResource.templates",
  channels: "settings.tokenResource.channels",
  kb: "settings.tokenResource.kb",
  posts: "settings.tokenResource.posts",
  settings: "settings.tokenResource.settings",
} as const satisfies Record<TokenResource, string>;

function SettingsPage({ user, workspace, refreshSession }: {
  user: AuthUser;
  workspace: WorkspaceSummary | undefined;
  refreshSession: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(user.name ?? "");
  const [wsName, setWsName] = useState(workspace?.name ?? "");
  const [wsCurrency, setWsCurrency] = useState(workspace?.defaultCurrency ?? "IDR");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // API tokens (adopted features): raw token shown ONCE after creation.
  // Scoped tokens (#5): optional workspace binding, scope picks, expiry.
  const [apiTokens, setApiTokens] = useState<ApiTokenInfo[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [newRawToken, setNewRawToken] = useState<string | null>(null);
  const [tokenWorkspaces, setTokenWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [tokenWorkspaceId, setTokenWorkspaceId] = useState("");
  const [tokenFullAccess, setTokenFullAccess] = useState(true);
  const [tokenPicks, setTokenPicks] = useState<ScopePicks>(() => emptyScopePicks());
  const [tokenExpiryDays, setTokenExpiryDays] = useState("");

  useEffect(() => { setWsName(workspace?.name ?? ""); }, [workspace?.name]);

  const loadTokens = useCallback(async () => {
    try {
      const res = await api.listApiTokens();
      setApiTokens(res.tokens);
    } catch (err) {
      setError(errText(err, t("settings.tokensFailed")));
    }
  }, [t]);
  useEffect(() => { void loadTokens(); }, [loadTokens]);

  const loadTokenWorkspaces = useCallback(async () => {
    try {
      const res = await api.listWorkspaces();
      setTokenWorkspaces(res.workspaces);
    } catch {
      // The binding select simply stays unbound-only; token CRUD still works.
      setTokenWorkspaces([]);
    }
  }, []);
  useEffect(() => { void loadTokenWorkspaces(); }, [loadTokenWorkspaces]);

  const createToken = async () => {
    if (!tokenName.trim()) return;
    if (!tokenFullAccess && countPickedResources(tokenPicks) === 0) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const body: { name: string; workspaceId?: string; scopes?: string[]; expiresAt?: string } = {
        name: tokenName.trim(),
      };
      if (tokenWorkspaceId) body.workspaceId = tokenWorkspaceId;
      if (!tokenFullAccess) body.scopes = picksToScopes(tokenPicks);
      else if (tokenWorkspaceId || tokenExpiryDays) body.scopes = ["*"];
      if (tokenExpiryDays) body.expiresAt = expiryIsoFromDays(Number(tokenExpiryDays));
      const res = await api.createApiToken(body);
      setNewRawToken(res.token);
      // Rider (package #7): reset the WHOLE form to factory defaults -
      // previously only the name cleared, so the next token silently
      // inherited this one's workspace binding, scope picks and expiry.
      // The one-time raw-token banner above is intentionally untouched.
      const fresh = defaultTokenFormState();
      setTokenName(fresh.name);
      setTokenWorkspaceId(fresh.workspaceId);
      setTokenFullAccess(fresh.fullAccess);
      setTokenPicks(fresh.picks);
      setTokenExpiryDays(fresh.expiryDays);
      await loadTokens();
    } catch (err) {
      setError(errText(err, t("settings.tokensFailed")));
    } finally { setBusy(false); }
  };

  const revokeToken = async (token: ApiTokenInfo) => {
    if (!window.confirm(t("settings.tokenRevokeConfirm"))) return;
    try {
      await api.revokeApiToken(token.id);
      if (newRawToken && newRawToken.startsWith(token.prefix)) setNewRawToken(null);
      await loadTokens();
    } catch (err) {
      setError(errText(err, t("settings.tokensFailed")));
    }
  };

  const loadMembers = useCallback(async () => {
    if (!workspace) return;
    try {
      const res = await api.listMembers(workspace.id);
      setMembers(res.members);
    } catch (err) {
      setError(errText(err, t("settings.membersFailed")));
    }
  }, [workspace, t]);
  useEffect(() => { void loadMembers(); }, [loadMembers]);

  const canRename = workspace && (workspace.role === "owner" || workspace.role === "admin");

  const saveProfile = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.patchMe({ name: name.trim() });
      setNotice(t("settings.profileSaved"));
      refreshSession();
    } catch (err) {
      setError(errText(err, t("settings.profileFailed")));
    } finally { setBusy(false); }
  };

  const saveWorkspace = async () => {
    if (!workspace) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.renameWorkspace(workspace.id, { name: wsName.trim(), defaultCurrency: wsCurrency });
      setNotice(t("settings.workspaceSaved"));
      refreshSession();
    } catch (err) {
      setError(errText(err, t("settings.workspaceFailed")));
    } finally { setBusy(false); }
  };

  const changePassword = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setNotice(t("settings.passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      setError(errText(err, t("settings.passwordFailed")));
    } finally { setBusy(false); }
  };

  const invite = async () => {
    if (!workspace || !inviteEmail.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.inviteMember(workspace.id, { email: inviteEmail.trim(), role: inviteRole });
      setNotice(t("settings.inviteDone"));
      setInviteEmail("");
      await loadMembers();
    } catch (err) {
      setError(errText(err, t("settings.inviteFailed")));
    } finally { setBusy(false); }
  };

  const changeRole = async (member: Member, role: string) => {
    if (!workspace) return;
    try {
      await api.patchMemberRole(workspace.id, member.userId, role);
      await loadMembers();
    } catch (err) {
      setError(errText(err, t("settings.inviteFailed")));
    }
  };

  const removeMember = async (member: Member) => {
    if (!workspace || !window.confirm(t("settings.removeConfirm"))) return;
    try {
      await api.removeMember(workspace.id, member.userId);
      await loadMembers();
    } catch (err) {
      setError(errText(err, t("settings.removeFailed")));
    }
  };

  const section = `${cardCls} p-4 space-y-3`;

  return (
    <div>
      <PageTitle title={t("settings.title")} subtitle={t("settings.subtitle")} />
      {error && <div className="mt-4 max-w-2xl"><ErrorBox error={error} /></div>}
      {notice && <div className="mt-4 max-w-2xl"><NoticeBox>{notice}</NoticeBox></div>}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
        <div className={section}>
          <div className="font-medium text-sm">{t("settings.profileTitle")}</div>
          <div>
            <label className={labelCls}>{t("settings.email")}</label>
            <input value={user.email} disabled className={`${inputCls} opacity-60`} />
          </div>
          <div>
            <label className={labelCls}>{t("settings.displayName")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </div>
          <button onClick={() => void saveProfile()} disabled={busy || !name.trim()} className={primaryBtn}>{t("common.save")}</button>
        </div>

        <div className={section}>
          <div className="font-medium text-sm">{t("settings.workspaceTitle")}</div>
          <div>
            <label className={labelCls}>{t("settings.workspaceName")}</label>
            <input value={wsName} onChange={(e) => setWsName(e.target.value)} disabled={!canRename} className={`${inputCls} ${!canRename ? "opacity-60" : ""}`} />
          </div>
          <div>
            <label className={labelCls}>{t("settings.defaultCurrency")}</label>
            <input
              value={wsCurrency}
              onChange={(e) => setWsCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))}
              disabled={!canRename}
              maxLength={3}
              className={`${inputCls} ${!canRename ? "opacity-60" : ""}`}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("settings.defaultCurrencyHint")}</p>
          </div>
          {!canRename && <p className="text-xs text-amber-600 dark:text-amber-400">{t("settings.renameForbidden")}</p>}
          <button onClick={() => void saveWorkspace()} disabled={busy || !canRename || !wsName.trim() || wsCurrency.length !== 3} className={primaryBtn}>{t("common.save")}</button>
        </div>

        <div className={section}>
          <div className="font-medium text-sm">{t("settings.passwordTitle")}</div>
          <div>
            <label className={labelCls}>{t("settings.currentPassword")}</label>
            <PasswordInput value={currentPassword} onChange={setCurrentPassword} />
          </div>
          <div>
            <label className={labelCls}>{t("settings.newPassword")}</label>
            <PasswordInput value={newPassword} onChange={setNewPassword} />
          </div>
          <button onClick={() => void changePassword()} disabled={busy || !currentPassword || newPassword.length < 8} className={primaryBtn}>
            {t("settings.passwordTitle")}
          </button>
        </div>

        <div className={section}>
          <div className="font-medium text-sm">{t("settings.languageTitle")}</div>
          <p className={mutedCls}>{t("settings.languageBody")}</p>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </div>

      <div className={`mt-4 max-w-4xl ${cardCls} p-4`}>
        <div className="font-medium text-sm">{t("settings.tokensTitle")}</div>
        <p className={`mt-1 ${mutedCls}`}>{t("settings.tokensBody")}</p>
        {newRawToken && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
            <div className="text-xs font-medium text-amber-900 dark:text-amber-200">{t("settings.tokenOnce")}</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-white px-2 py-1 text-xs text-slate-900 dark:bg-slate-900 dark:text-slate-100">{newRawToken}</code>
              <button
                onClick={() => void navigator.clipboard.writeText(newRawToken)}
                className="text-xs text-slate-700 underline dark:text-slate-200"
              >
                {t("common.copy")}
              </button>
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <input
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder={t("settings.tokenNamePlaceholder")}
            className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
            {t("settings.tokenWorkspace")}
            <select
              value={tokenWorkspaceId}
              onChange={(e) => setTokenWorkspaceId(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">{t("settings.tokenWorkspaceAny")}</option>
              {tokenWorkspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
            {t("settings.tokenExpires")}
            <select
              value={tokenExpiryDays}
              onChange={(e) => setTokenExpiryDays(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">{t("settings.tokenExpiryNever")}</option>
              {[30, 90, 365].map((days) => (
                <option key={days} value={String(days)}>{t("settings.tokenExpiryDays", { days })}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() => void createToken()}
            disabled={busy || !tokenName.trim() || (!tokenFullAccess && countPickedResources(tokenPicks) === 0)}
            className={primaryBtn}
          >
            {t("settings.tokenCreate")}
          </button>
        </div>
        <div className="mt-3">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{t("settings.tokenScopes")}</div>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={tokenFullAccess}
              onChange={(e) => setTokenFullAccess(e.target.checked)}
            />
            {t("settings.tokenFullAccess")}
          </label>
          {!tokenFullAccess && (
            <div className="mt-2 grid max-w-2xl grid-cols-1 gap-1 sm:grid-cols-2">
              {TOKEN_RESOURCES.map((resource) => (
                <div key={resource} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1.5 dark:border-slate-800">
                  <span className="text-sm">{t(TOKEN_RESOURCE_LABEL_KEYS[resource])}</span>
                  <span className="flex items-center gap-3 text-xs">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={tokenPicks[resource].read || tokenPicks[resource].write}
                        disabled={tokenPicks[resource].write}
                        onChange={(e) => setTokenPicks((prev) => ({
                          ...prev,
                          [resource]: { ...prev[resource], read: e.target.checked },
                        }))}
                      />
                      {t("settings.tokenScopeRead")}
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={tokenPicks[resource].write}
                        onChange={(e) => setTokenPicks((prev) => ({
                          ...prev,
                          [resource]: { read: prev[resource].read || e.target.checked, write: e.target.checked },
                        }))}
                      />
                      {t("settings.tokenScopeWrite")}
                    </label>
                  </span>
                </div>
              ))}
              {countPickedResources(tokenPicks) === 0 && (
                <p className={`text-xs ${mutedCls}`}>{t("settings.tokenScopePickHint")}</p>
              )}
            </div>
          )}
        </div>
        {apiTokens.length === 0 ? (
          <p className={`mt-3 ${mutedCls}`}>{t("settings.tokensEmpty")}</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">{t("common.name")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.tokenPrefix")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.tokenWorkspace")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.tokenScopes")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.tokenCreated")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.tokenExpires")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.tokenLastUsed")}</th>
                <th className="px-3 py-2 font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {apiTokens.map((token) => {
                const expired = tokenIsExpired(token.expiresAt);
                const boundWorkspace = token.workspaceId
                  ? tokenWorkspaces.find((w) => w.id === token.workspaceId)
                  : undefined;
                return (
                  <tr key={token.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2">
                      {token.name}
                      {token.revokedAt && (
                        <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                          {t("settings.tokenRevoked")}
                        </span>
                      )}
                      {!token.revokedAt && expired && (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-300">
                          {t("settings.tokenExpired")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2"><code className="text-xs">{token.prefix}...</code></td>
                    <td className="px-3 py-2">
                      {token.workspaceId ? (boundWorkspace?.name ?? `${token.workspaceId.slice(0, 8)}...`) : t("settings.tokenAllWorkspaces")}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {token.scopes === null || (token.scopes.length === 1 && token.scopes[0] === "*")
                        ? t("settings.tokenFullAccess")
                        : token.scopes.length === 0
                          ? t("settings.tokenScopesNone")
                          : token.scopes.map((s) => {
                              const parts = scopeParts(s);
                              if (parts.level === "all") return t("settings.tokenFullAccess");
                              const label = TOKEN_RESOURCE_LABEL_KEYS[parts.resource as TokenResource];
                              const resourceLabel = label ? t(label) : parts.resource;
                              return `${resourceLabel}: ${parts.level === "write" ? t("settings.tokenScopeWrite") : t("settings.tokenScopeRead")}`;
                            }).join(", ")}
                    </td>
                    <td className="px-3 py-2">{new Date(token.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      {token.expiresAt ? new Date(token.expiresAt).toLocaleString() : t("settings.tokenExpiryNever")}
                    </td>
                    <td className="px-3 py-2">{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "-"}</td>
                    <td className="px-3 py-2">
                      {!token.revokedAt && (
                        <button onClick={() => void revokeToken(token)} className="text-xs text-red-600 dark:text-red-400 underline">
                          {t("settings.tokenRevoke")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className={`mt-4 max-w-4xl ${cardCls} p-4`}>
        <div className="font-medium text-sm">{t("settings.membersTitle")}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder={t("settings.inviteEmail")}
            className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button onClick={() => void invite()} disabled={busy || !inviteEmail.trim()} className={primaryBtn}>{t("settings.inviteButton")}</button>
        </div>
        <table className="mt-4 w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">{t("settings.email")}</th>
              <th className="px-3 py-2 font-medium">{t("common.name")}</th>
              <th className="px-3 py-2 font-medium">{t("common.role")}</th>
              <th className="px-3 py-2 font-medium">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2">{m.email}</td>
                <td className="px-3 py-2">{m.name ?? "-"}</td>
                <td className="px-3 py-2">
                  <select
                    value={m.role}
                    onChange={(e) => void changeRole(m, e.target.value)}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <button onClick={() => void removeMember(m)} className="text-xs text-red-600 dark:text-red-400 underline">{t("settings.remove")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Password field with an eye toggle (show/hide) - used for the auth
 *  form, the Settings change-password fields, and bot-token entry. */
function PasswordInput({ value, onChange, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        className={`${inputCls} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t("auth.hidePassword") : t("auth.showPassword")}
        title={visible ? t("auth.hidePassword") : t("auth.showPassword")}
        className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
      >
        {visible ? (
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178a1.012 1.012 0 010-.639z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        )}
      </button>
    </div>
  );
}

// ------------------------------------------------------------ auth (Fase 3)

function AuthPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = mode === "login"
        ? await api.login({ email, password })
        : await api.register({
            email, password,
            name: name || undefined,
            workspaceName: workspaceName || undefined,
          });
      setToken(res.token);
      if (res.workspace) setWorkspaceId(res.workspace.id);
      onAuthenticated();
    } catch (err) {
      setError(errText(err, t("auth.failed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-3 flex justify-end gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm p-6">
          <div className="text-2xl font-bold tracking-tight">Botara</div>
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {mode === "login" ? t("auth.loginSubtitle") : t("auth.registerSubtitle")}
          </div>
          {error && <div className="mt-4"><ErrorBox error={error} /></div>}
          <div className="mt-5 space-y-3">
            {mode === "register" && (
              <>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("auth.namePlaceholder")} className={inputCls} />
                <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder={t("auth.workspacePlaceholder")} className={inputCls} />
              </>
            )}
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder={t("auth.emailPlaceholder")} className={inputCls} />
            <PasswordInput value={password} onChange={setPassword} placeholder={t("auth.passwordPlaceholder")} />
            <button
              onClick={() => void submit()}
              disabled={busy || !email || password.length < 8}
              className={`w-full ${primaryBtn}`}
            >
              {busy ? t("auth.processing") : mode === "login" ? t("auth.login") : t("auth.register")}
            </button>
          </div>
          <div className="mt-4 text-sm text-slate-500 dark:text-slate-400 text-center">
            {mode === "login" ? (
              <>{t("auth.noAccount")}{" "}
                <button className="text-slate-900 dark:text-slate-100 underline" onClick={() => setMode("register")}>{t("auth.register")}</button></>
            ) : (
              <>{t("auth.haveAccount")}{" "}
                <button className="text-slate-900 dark:text-slate-100 underline" onClick={() => setMode("login")}>{t("auth.login")}</button></>
            )}
          </div>
          <div className="mt-6 text-center text-xs text-slate-400 dark:text-slate-500 space-x-3">
            <a href="/privacy" className="underline">{t("common.privacy")}</a>
            <a href="/terms" className="underline">{t("common.terms")}</a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- legal pages
// TEMPLATE legal text - the business owner must have these reviewed by
// their own legal counsel before production use (see docs/app-review).
// Body copy follows the selected UI language (EN default / ID).

function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between">
          <a href="/" className="text-sm text-slate-500 dark:text-slate-400 underline">← Botara</a>
          <div className="flex gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
        <h1 className="text-3xl font-bold mt-4">{title}</h1>
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <strong>TEMPLATE.</strong> {t("legal.templateBanner")}
        </div>
        <div className="mt-6 space-y-4 text-sm leading-6 text-slate-700 dark:text-slate-300">{children}</div>
      </div>
    </div>
  );
}

function LegalSection({ heading, children }: { heading: string; children: string }) {
  return (
    <>
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{heading}</h2>
      <p>{children}</p>
    </>
  );
}

function PrivacyPage() {
  const { t } = useI18n();
  return (
    <LegalShell title={t("legal.privacy.title")}>
      <p><strong>{t("legal.privacy.updated")}</strong></p>
      <LegalSection heading={t("legal.privacy.s1h")}>{t("legal.privacy.s1")}</LegalSection>
      <LegalSection heading={t("legal.privacy.s2h")}>{t("legal.privacy.s2")}</LegalSection>
      <LegalSection heading={t("legal.privacy.s3h")}>{t("legal.privacy.s3")}</LegalSection>
      <LegalSection heading={t("legal.privacy.s4h")}>{t("legal.privacy.s4")}</LegalSection>
      <LegalSection heading={t("legal.privacy.s5h")}>{t("legal.privacy.s5")}</LegalSection>
      <LegalSection heading={t("legal.privacy.s6h")}>{t("legal.privacy.s6")}</LegalSection>
    </LegalShell>
  );
}

function TermsPage() {
  const { t } = useI18n();
  return (
    <LegalShell title={t("legal.terms.title")}>
      <p><strong>{t("legal.terms.updated")}</strong></p>
      <LegalSection heading={t("legal.terms.s1h")}>{t("legal.terms.s1")}</LegalSection>
      <LegalSection heading={t("legal.terms.s2h")}>{t("legal.terms.s2")}</LegalSection>
      <LegalSection heading={t("legal.terms.s3h")}>{t("legal.terms.s3")}</LegalSection>
      <LegalSection heading={t("legal.terms.s4h")}>{t("legal.terms.s4")}</LegalSection>
      <LegalSection heading={t("legal.terms.s5h")}>{t("legal.terms.s5")}</LegalSection>
    </LegalShell>
  );
}

// ------------------------------------------------------------------ shell

export function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AppRoutes />
      </LanguageProvider>
    </ThemeProvider>
  );
}

function AppRoutes() {
  // Public legal routes are pathname-based (the SPA has no router) and
  // never require auth - Meta App Review links straight to them.
  if (window.location.pathname === "/privacy") return <PrivacyPage />;
  if (window.location.pathname === "/terms") return <TermsPage />;
  return <AuthedApp />;
}

function AuthedApp() {
  const { t } = useI18n();
  // OAuth callbacks return to /#/channels?connected=... - land on the
  // Channels page so its success/error banner is the first thing seen.
  const [page, setPage] = useState<PageId>(() =>
    window.location.hash.startsWith("#/channels") ? "channels" : "dashboard",
  );
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceIdState] = useState(getWorkspaceId());
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);

  const loadSession = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setReady(true);
      return;
    }
    try {
      const me = await api.me();
      setUser(me.user);
      const list = await api.listWorkspaces();
      setWorkspaces(list.workspaces);
      const stored = getWorkspaceId();
      if (!list.workspaces.some((w) => w.id === stored)) {
        const first = list.workspaces[0];
        if (first) {
          setWorkspaceId(first.id);
          setWorkspaceIdState(first.id);
        }
      }
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void loadSession(); }, [loadSession]);

  useEffect(() => {
    onUnauthorized(() => {
      setUser(null);
      setWorkspaces([]);
    });
  }, []);

  // Realtime socket lifecycle: one connection per signed-in session,
  // re-subscribed on workspace switches, torn down on logout (the
  // cleanup runs when `user` clears). Events land in state and the
  // Inbox page decides what to refresh.
  const [liveEvent, setLiveEvent] = useState<InboxRealtimeEvent | null>(null);
  const realtimeRef = useRef<RealtimeHandle | null>(null);
  useEffect(() => {
    if (!user) return;
    const handle = connectRealtime({
      workspaceId: getWorkspaceId(),
      onInboxMessage: (event) => setLiveEvent(event),
    });
    realtimeRef.current = handle;
    return () => {
      handle.close();
      realtimeRef.current = null;
    };
  }, [user]);
  useEffect(() => {
    realtimeRef.current?.setWorkspace(workspaceId);
  }, [workspaceId]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        {t("app.loading")}
      </div>
    );
  }

  // Route guard: no valid session -> login/register, nothing else renders.
  if (!user) {
    return <AuthPage onAuthenticated={() => { setReady(false); void loadSession(); }} />;
  }

  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  const changeWorkspace = (id: string) => {
    setWorkspaceIdState(id);
    setWorkspaceId(id);
  };

  // Create workspace (F7): the switcher's "+ New workspace" entry opens
  // a small name modal; on success the app switches to the new workspace.
  // (State hooks live with the other AuthedApp hooks above the early
  // returns — hooks after a conditional return crash React (#310).)
  const createWorkspace = async () => {
    setCreatingWorkspace(true);
    try {
      const res = await api.createWorkspace({ name: newWorkspaceName.trim() });
      setWorkspaces((prev) => [...prev, { ...res.workspace, role: "owner" }]);
      changeWorkspace(res.workspace.id);
      pushToast("ok", t("workspace.created"));
      setShowNewWorkspace(false);
      setNewWorkspaceName("");
    } catch (err) {
      pushToast("err", errText(err, t("workspace.createFailed")));
    } finally {
      setCreatingWorkspace(false);
    }
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
    setWorkspaces([]);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex">
      <Toasts />
      <aside className="w-60 shrink-0 bg-slate-900 text-slate-100 flex flex-col dark:border-r dark:border-slate-800">
        <div className="px-5 py-5 border-b border-slate-700">
          <div className="text-xl font-bold tracking-tight">Botara</div>
          <div className="text-xs text-slate-400 mt-1">{t("app.tagline")}</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.filter((item) => item.id !== "admin" || user.isPlatformAdmin).map((item) => (
            <a
              key={item.id}
              href="#"
              onClick={(e) => { e.preventDefault(); setPage(item.id); }}
              className={`block rounded-md px-3 py-2 text-sm ${page === item.id ? "bg-slate-700 font-medium" : "text-slate-300 hover:bg-slate-800"}`}
            >
              {t(item.labelKey)}
            </a>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-slate-700 space-y-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">{t("common.workspace")}</label>
            <select
              value={workspaceId}
              onChange={(e) => {
                if (e.target.value === "__new__") {
                  setShowNewWorkspace(true);
                } else {
                  changeWorkspace(e.target.value);
                }
              }}
              className="w-full rounded-md bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 focus:outline-none"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name} ({w.role})</option>
              ))}
              <option value="__new__">+ {t("workspace.new")}</option>
            </select>
          </div>
          <div className="text-[11px] text-slate-500">
            {user.email}{currentWorkspace ? ` · ${t("common.role")}: ${currentWorkspace.role}` : ""}
          </div>
          <button
            onClick={() => void logout()}
            className="w-full rounded-md bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 hover:bg-slate-700"
          >
            {t("common.logout")}
          </button>
          <div className="text-[11px] text-slate-500 space-x-2">
            <a href="/privacy" className="underline">{t("common.privacy")}</a>
            <a href="/terms" className="underline">{t("common.terms")}</a>
          </div>
        </div>
      </aside>

      <main className="flex-1 p-8 min-w-0">
        <div className="mb-5 flex items-center justify-end gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
        {page === "dashboard" && <DashboardPage goTo={setPage} />}
        {page === "inbox" && <InboxPage liveEvent={liveEvent} />}
        {page === "contacts" && <ContactsPage />}
        {page === "flows" && <FlowsPage />}
        {page === "broadcast" && <BroadcastPage />}
        {page === "sequences" && <SequencesPage />}
        {page === "deals" && <DealsPage workspace={currentWorkspace} />}
        {page === "publish" && <PublishPage />}
        {page === "channels" && <ChannelsPage />}
        {page === "knowledge" && <KnowledgePage />}
        {page === "growth" && <GrowthPage />}
        {page === "settings" && (
          <SettingsPage
            user={user}
            workspace={currentWorkspace}
            refreshSession={() => { void loadSession(); }}
          />
        )}
        {page === "admin" && user.isPlatformAdmin && <AdminPage />}
      </main>
      {showNewWorkspace && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" onClick={() => setShowNewWorkspace(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("workspace.createTitle")}
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold">{t("workspace.createTitle")}</h2>
            <input
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder={t("workspace.namePlaceholder")}
              className={`mt-4 ${inputCls}`}
              autoFocus
            />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowNewWorkspace(false)} className={outlineBtn}>{t("common.cancel")}</button>
              <button
                onClick={() => void createWorkspace()}
                disabled={creatingWorkspace || !newWorkspaceName.trim()}
                className={primaryBtn}
              >
                {creatingWorkspace ? t("common.saving") : t("common.create")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
