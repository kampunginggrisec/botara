import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, ApiError, BASE_URL, downloadTextFile, getToken, getWorkspaceId, onUnauthorized, setToken, setWorkspaceId,
  type ApiTokenInfo, type AuthUser, type BroadcastEstimate, type ChannelAccount, type Contact,
  type ContactImportResult, type Conversation, type Flow, type GrowthLink, type KbDocument,
  type Member, type Message, type PublicConfig, type RichBlock, type ScheduledPost, type Sequence,
  type SequenceStep, type StatsOverview, type Template, type WorkspaceSummary,
} from "./api";
import { LanguageProvider, LanguageSwitcher, useI18n } from "./i18n";
import {
  connectRealtime, decideInboxRefresh, isRealtimeDegraded,
  type InboxMessageEvent, type RealtimeHandle,
} from "./realtime";
import { ThemeProvider, ThemeToggle } from "./theme";
import { FlowBuilder, starterGraph } from "./flows/FlowBuilder";

type PageId = "dashboard" | "inbox" | "contacts" | "flows" | "broadcast" | "sequences" | "publish" | "channels" | "knowledge" | "growth" | "settings";

const NAV: Array<{ id: PageId; labelKey: Parameters<ReturnType<typeof useI18n>["t"]>[0] }> = [
  { id: "dashboard", labelKey: "nav.dashboard" },
  { id: "inbox", labelKey: "nav.inbox" },
  { id: "contacts", labelKey: "nav.contacts" },
  { id: "flows", labelKey: "nav.flows" },
  { id: "broadcast", labelKey: "nav.broadcast" },
  { id: "sequences", labelKey: "nav.sequences" },
  { id: "publish", labelKey: "nav.publish" },
  { id: "channels", labelKey: "nav.channels" },
  { id: "knowledge", labelKey: "nav.knowledge" },
  { id: "growth", labelKey: "nav.growth" },
  { id: "settings", labelKey: "nav.settings" },
];

// Shared dark-aware primitives (Fase 4 theme pass).
const cardCls = "rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const inputCls = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500";
const labelCls = "block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1";
const primaryBtn = "rounded-md bg-slate-900 text-white text-sm px-4 py-2 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900";
const outlineBtn = "rounded-md border border-slate-900 text-slate-900 text-sm px-4 py-2 disabled:opacity-50 dark:border-slate-100 dark:text-slate-100";
const chipCls = "text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
const mutedCls = "text-sm text-slate-500 dark:text-slate-400";

function ErrorBox({ error }: { error: string }) {
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {error}
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

// ------------------------------------------------------------------- Inbox

function InboxPage({ liveEvent }: { liveEvent: InboxMessageEvent | null }) {
  const { t } = useI18n();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyText, setReplyText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [windowClosed, setWindowClosed] = useState(false);
  const [sending, setSending] = useState(false);
  // Rich buttons builder (adopted features): reply/url buttons attached
  // to the reply as a rich block; channels render or degrade them.
  const [showButtons, setShowButtons] = useState(false);
  const [richButtons, setRichButtons] = useState<Array<{ type: "reply" | "url"; title: string; payload: string; url: string }>>([]);
  const [richWarning, setRichWarning] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const data = await api.listConversations();
      setConversations(data.conversations);
      setError(null);
    } catch (err) {
      setError(errText(err, t("inbox.loadFailed")));
    }
  }, [t]);

  useEffect(() => { void loadConversations(); }, [loadConversations]);

  // Live updates (realtime socket owned by AuthedApp): an event for the
  // current workspace refreshes the list; an event for the OPEN
  // conversation refetches its messages too - no manual refresh.
  const selectedRef = useRef<Conversation | null>(null);
  selectedRef.current = selected;
  useEffect(() => {
    if (!liveEvent) return;
    const decision = decideInboxRefresh(liveEvent, {
      workspaceId: getWorkspaceId(),
      openConversationId: selectedRef.current?.id ?? null,
    });
    if (decision.refreshList) void loadConversations();
    if (decision.refreshMessages && selectedRef.current) void openConversation(selectedRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEvent]);

  // Degraded fallback: while the realtime socket cannot connect, poll
  // every 30s so the inbox still self-refreshes (checked per tick - as
  // soon as the socket recovers, polling goes quiet again).
  useEffect(() => {
    const timer = setInterval(() => {
      if (!isRealtimeDegraded()) return;
      void loadConversations();
      if (selectedRef.current) void openConversation(selectedRef.current);
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
      const rich: RichBlock | undefined = showButtons && validButtons.length > 0
        ? {
            kind: "buttons",
            text: replyText.trim(),
            buttons: validButtons.map((b) => (b.type === "url"
              ? { type: "url" as const, title: b.title.trim(), url: b.url.trim() }
              : { type: "reply" as const, title: b.title.trim(), payload: b.payload.trim() || b.title.trim() })),
          }
        : undefined;
      const res = await api.reply(selected.id, { kind: "free_form", text: replyText.trim(), ...(rich ? { rich } : {}) });
      if (res.warnings && res.warnings.length > 0) {
        setRichWarning(t("inbox.richDegraded", { warnings: res.warnings.join(", ") }));
      }
      setReplyText("");
      setRichButtons([]);
      setShowButtons(false);
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

  return (
    <div>
      <PageTitle title={t("inbox.title")} subtitle={t("inbox.subtitle")} />
      {error && <div className="mt-4"><ErrorBox error={error} /></div>}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-2">
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
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {t("inbox.statusLabel")}: {conv.status} · {t("inbox.windowLabel")}: {conv.windowOpen
                  ? <span className="text-emerald-600 dark:text-emerald-400 font-medium">{t("inbox.windowOpen")}</span>
                  : <span className="text-red-600 dark:text-red-400 font-medium">{t("inbox.windowClosed")}</span>}
              </div>
            </button>
          ))}
        </div>
        <div className={`lg:col-span-2 ${cardCls} flex flex-col min-h-96`}>
          {!selected ? (
            <div className="p-6 text-sm text-slate-500 dark:text-slate-400">{t("inbox.selectPrompt")}</div>
          ) : (
            <>
              <div className="border-b border-slate-100 dark:border-slate-800 px-4 py-3 font-medium text-sm">
                {selected.contactDisplayName ?? selected.contactExternalId} · {selected.channel}
              </div>
              <div className="flex-1 p-4 space-y-2 overflow-y-auto">
                {messages.length === 0 && <div className="text-sm text-slate-400 dark:text-slate-500">{t("inbox.noMessages")}</div>}
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-md rounded-lg px-3 py-2 text-sm ${m.direction === "out"
                      ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                      : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"}`}>
                      <div>{m.body ?? <em>({m.type})</em>}</div>
                      <div className={`mt-1 text-[11px] ${m.direction === "out" ? "text-slate-300 dark:text-slate-500" : "text-slate-400"}`}>{m.status}</div>
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
              <div className="border-t border-slate-100 dark:border-slate-800 p-3">
                <div className="flex gap-2">
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    rows={2}
                    placeholder={t("inbox.replyPlaceholder")}
                    className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <button onClick={() => void sendReply()} disabled={sending || !replyText.trim()} className={`self-end ${primaryBtn}`}>
                    {sending ? t("common.sending") : t("common.send")}
                  </button>
                </div>
                <button
                  onClick={() => setShowButtons((v) => !v)}
                  className="mt-2 text-xs text-slate-600 underline dark:text-slate-300"
                >
                  {showButtons ? t("inbox.hideButtons") : t("inbox.addButtons")}
                </button>
                {showButtons && (
                  <div className="mt-2 space-y-2 rounded-md border border-slate-200 p-2 dark:border-slate-700">
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t("inbox.buttonsHint")}</p>
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
                          placeholder={t("inbox.buttonTitle")}
                          className="w-36 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        />
                        {b.type === "url" ? (
                          <input
                            value={b.url}
                            onChange={(e) => setRichButtons((prev) => prev.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                            placeholder="https://..."
                            className="w-52 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          />
                        ) : (
                          <input
                            value={b.payload}
                            onChange={(e) => setRichButtons((prev) => prev.map((x, j) => (j === i ? { ...x, payload: e.target.value } : x)))}
                            placeholder={t("inbox.buttonPayload")}
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
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Contacts

function ContactsPage() {
  const { t } = useI18n();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => { void load(""); }, [load]);

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
      </div>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Broadcast

function BroadcastPage() {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [channelAccountId, setChannelAccountId] = useState("");
  const [recipients, setRecipients] = useState(100);
  const [country, setCountry] = useState("ID");
  const [estimate, setEstimate] = useState<BroadcastEstimate | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listTemplates()
      .then((data) => setTemplates(data.templates))
      .catch(() => { /* template list is optional for the estimate flow */ });
  }, []);

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
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const data = await api.createBroadcast({
        channelAccountId,
        templateId: templateId || undefined,
        country: country.toUpperCase(),
        recipientCount: recipients,
      });
      setCreated(t("broadcast.created", { id: data.broadcast.id, status: data.broadcast.status }));
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
          <input value={channelAccountId} onChange={(e) => setChannelAccountId(e.target.value)} placeholder={t("broadcast.accountIdPlaceholder")} className={inputCls} />
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
    </div>
  );
}

// ----------------------------------------------------------------- Publish

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

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createPost({
        text: text.trim() || undefined,
        mediaUrls: mediaUrl.trim() ? [mediaUrl.trim()] : undefined,
        targets: [...selected].map((channelAccountId) => ({ channelAccountId })),
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      });
      setText("");
      setMediaUrl("");
      setNotice(scheduledAt ? t("publish.scheduledNotice") : t("publish.draftNotice"));
      setScheduledAt("");
      await load();
    } catch (err) {
      setError(errText(err, t("publish.createFailed")));
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
        <div className="max-w-xs">
          <label className={labelCls}>{t("publish.schedule")}</label>
          <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className={inputCls} />
        </div>
        <button onClick={() => void create()} disabled={busy || selected.size === 0 || (!text.trim() && !mediaUrl.trim())} className={primaryBtn}>
          {scheduledAt ? t("publish.scheduleButton") : t("publish.draftButton")}
        </button>
      </div>

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

  return (
    <div>
      <PageTitle title={t("knowledge.title")} subtitle={t("knowledge.subtitle")} />
      {error && <div className="mt-4 max-w-xl"><ErrorBox error={error} /></div>}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
        <div className={`${cardCls} p-4 space-y-3`}>
          <div className="font-medium text-sm">{t("knowledge.addTitle")}</div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("knowledge.titlePlaceholder")} className={inputCls} />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} placeholder={t("knowledge.contentPlaceholder")} className={inputCls} />
          <button onClick={() => void create()} disabled={busy || !title.trim() || !content.trim()} className={primaryBtn}>
            {busy ? t("common.saving") : t("knowledge.saveButton")}
          </button>
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
  const [busy, setBusy] = useState(false);

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
      </div>
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
}

const emptyStep = (): StepDraft => ({
  delayHours: 24, kind: "text", body: "", templateName: "", templateLanguage: "id", templateCategory: "utility",
});

function stepToDraft(step: SequenceStep): StepDraft {
  return {
    delayHours: Math.round(step.delaySeconds / 3600),
    kind: step.template ? "template" : "text",
    body: step.text ?? "",
    templateName: step.template?.name ?? "",
    templateLanguage: step.template?.language ?? "id",
    templateCategory: step.template?.latestCategory ?? "utility",
  };
}

function draftToStep(draft: StepDraft): SequenceStep {
  return draft.kind === "template"
    ? {
        delaySeconds: Math.max(0, Math.round(draft.delayHours * 3600)),
        template: { name: draft.templateName, language: draft.templateLanguage, latestCategory: draft.templateCategory },
      }
    : { delaySeconds: Math.max(0, Math.round(draft.delayHours * 3600)), text: draft.body };
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
    setAccountId(accounts[0]?.id ?? "");
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
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.channel} · {a.displayName ?? a.externalId}</option>
                ))}
              </select>
              {accounts.length === 0 && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("sequences.noAccounts")}</p>}
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
                      <textarea value={step.body} onChange={(e) => patchStep(i, { body: e.target.value })} rows={2} className={inputCls} />
                    </div>
                  ) : (
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

  // OAuth round-trip signals arrive in the hash: #/channels?connected=...
  useEffect(() => {
    const hash = window.location.hash;
    const qIndex = hash.indexOf("?");
    if (qIndex < 0) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const connected = params.get("connected");
    const errorCode = params.get("error");
    if (connected) {
      setBanner({ kind: "ok", text: t("channels.connectedBanner", { channel: connected }) });
      void load();
    } else if (errorCode) {
      const reasonKey = `channels.error.${errorCode}` as never;
      setBanner({ kind: "err", text: t("channels.errorBanner", { reason: t(reasonKey) }) });
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
      setNotice(t("channels.telegram.connected", { name: res.account.displayName }));
      setTgToken("");
      setTgLabel("");
      await load();
    } catch (err) {
      setError(errText(err, t("channels.telegram.connectFailed")));
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
        setError(t("channels.whatsapp.noCode"));
        return;
      }
      const session = await Promise.race([
        sessionPromise,
        new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 1500)),
      ]);
      await api.exchangeWhatsAppSignup({ code, sessionInfo: session });
      setNotice(t("channels.whatsapp.exchanged"));
      await load();
    } catch (err) {
      setError(errText(err, t("channels.whatsapp.exchangeFailed")));
    }
  };

  const selectPage = async (pageId: string) => {
    setBusy(true);
    try {
      await api.selectMessengerPage(pageId);
      setPendingPages(null);
      setBanner({ kind: "ok", text: t("channels.connectedBanner", { channel: "messenger" }) });
      await load();
    } catch (err) {
      setError(errText(err, t("channels.messenger.selectFailed")));
    } finally {
      setBusy(false);
    }
  };

  const oauthHref = (channel: string, extra = "") => `${BASE_URL}/channels/${channel}/oauth/start${extra}`;
  const workspaceId = getWorkspaceId();
  const widgetSnippet = `<script src="${window.location.origin}/widget.js" data-workspace-id="${workspaceId}" data-api-url="${window.location.origin}/api" data-lang="en" data-theme="auto" async></script>`;

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(widgetSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable in this browser context */ }
  };

  const connectCard = "rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900";

  return (
    <div>
      <PageTitle title={t("channels.title")} subtitle={t("channels.subtitle")} />
      {banner && (
        <div className="mt-4 max-w-3xl">
          {banner.kind === "ok" ? <NoticeBox>{banner.text}</NoticeBox> : <ErrorBox error={banner.text} />}
        </div>
      )}
      {error && <div className="mt-4 max-w-3xl"><ErrorBox error={error} /></div>}
      {notice && <div className="mt-4 max-w-3xl"><NoticeBox>{notice}</NoticeBox></div>}

      <h2 className="mt-6 text-base font-semibold">{t("channels.connectedTitle")}</h2>
      <div className="mt-3 space-y-2 max-w-3xl">
        {accounts.length === 0 && !error && <EmptyState>{t("channels.connectedEmpty")}</EmptyState>}
        {accounts.map((a) => (
          <div key={a.id} className={`${cardCls} p-3 flex flex-wrap items-center gap-2`}>
            <span className={chipCls}>{a.channel}</span>
            <span className="font-medium text-sm">{a.displayName ?? a.externalId}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">{a.status}</span>
            {a.channel === "whatsapp" && (a as ChannelAccount & { isCoexistence?: boolean }).isCoexistence && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300">{t("channels.coexistence")}</span>
            )}
            <span className="text-xs text-slate-400 dark:text-slate-500">
              {a.hasCredential ? t("channels.hasCredential") : t("channels.noCredential")}
              {a.tokenExpiresAt ? ` · ${t("channels.expires", { date: new Date(a.tokenExpiresAt).toLocaleDateString() })}` : ""}
            </span>
          </div>
        ))}
      </div>

      {pendingPages !== null && (
        <div className="mt-6 max-w-3xl rounded-lg border border-sky-300 bg-sky-50 p-4 dark:border-sky-900 dark:bg-sky-950">
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

      <h2 className="mt-8 text-base font-semibold">{t("channels.connectTitle")}</h2>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
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
          <div className="font-medium text-sm">{t("channels.webchat.title")}</div>
          <p className={`mt-1 ${mutedCls}`}>{t("channels.webchat.body")}</p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-50 p-3 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">{widgetSnippet}</pre>
          <button onClick={() => void copySnippet()} className={`mt-3 ${outlineBtn}`}>
            {copied ? t("channels.webchat.copied") : t("channels.webchat.copy")}
          </button>
        </div>
      </div>
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
              {accounts.map((a) => (
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

function SettingsPage({ user, workspace, refreshSession }: {
  user: AuthUser;
  workspace: WorkspaceSummary | undefined;
  refreshSession: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(user.name ?? "");
  const [wsName, setWsName] = useState(workspace?.name ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // API tokens (adopted features): raw token shown ONCE after creation.
  const [apiTokens, setApiTokens] = useState<ApiTokenInfo[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [newRawToken, setNewRawToken] = useState<string | null>(null);

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

  const createToken = async () => {
    if (!tokenName.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await api.createApiToken(tokenName.trim());
      setNewRawToken(res.token);
      setTokenName("");
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
      await api.renameWorkspace(workspace.id, { name: wsName.trim() });
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
          {!canRename && <p className="text-xs text-amber-600 dark:text-amber-400">{t("settings.renameForbidden")}</p>}
          <button onClick={() => void saveWorkspace()} disabled={busy || !canRename || !wsName.trim()} className={primaryBtn}>{t("common.save")}</button>
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
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder={t("settings.tokenNamePlaceholder")}
            className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <button onClick={() => void createToken()} disabled={busy || !tokenName.trim()} className={primaryBtn}>
            {t("settings.tokenCreate")}
          </button>
        </div>
        {apiTokens.length === 0 ? (
          <p className={`mt-3 ${mutedCls}`}>{t("settings.tokensEmpty")}</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">{t("common.name")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.tokenPrefix")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.tokenCreated")}</th>
                <th className="px-3 py-2 font-medium">{t("settings.tokenLastUsed")}</th>
                <th className="px-3 py-2 font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {apiTokens.map((token) => (
                <tr key={token.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-3 py-2">{token.name}</td>
                  <td className="px-3 py-2"><code className="text-xs">{token.prefix}...</code></td>
                  <td className="px-3 py-2">{new Date(token.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "-"}</td>
                  <td className="px-3 py-2">
                    <button onClick={() => void revokeToken(token)} className="text-xs text-red-600 dark:text-red-400 underline">
                      {t("settings.tokenRevoke")}
                    </button>
                  </td>
                </tr>
              ))}
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
  const [page, setPage] = useState<PageId>("dashboard");
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceIdState] = useState(getWorkspaceId());

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
  const [liveEvent, setLiveEvent] = useState<InboxMessageEvent | null>(null);
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

  const logout = async () => {
    await api.logout();
    setUser(null);
    setWorkspaces([]);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex">
      <aside className="w-60 shrink-0 bg-slate-900 text-slate-100 flex flex-col dark:border-r dark:border-slate-800">
        <div className="px-5 py-5 border-b border-slate-700">
          <div className="text-xl font-bold tracking-tight">Botara</div>
          <div className="text-xs text-slate-400 mt-1">{t("app.tagline")}</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((item) => (
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
              onChange={(e) => changeWorkspace(e.target.value)}
              className="w-full rounded-md bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 focus:outline-none"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name} ({w.role})</option>
              ))}
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
      </main>
    </div>
  );
}
