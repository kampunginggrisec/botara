import { useCallback, useEffect, useState } from "react";
import {
  api, ApiError, getWorkspaceId, setWorkspaceId,
  type BroadcastEstimate, type Contact, type Conversation, type Message, type Template,
} from "./api";

const NAV = ["Dashboard", "Inbox", "Contacts", "Flows", "Broadcast", "Sequences", "Publish", "Channels", "Settings"];

function ErrorBox({ error }: { error: string }) {
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
      {error}
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
      {children}
    </div>
  );
}

// ------------------------------------------------------------------- Inbox

function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyText, setReplyText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [windowClosed, setWindowClosed] = useState(false);
  const [sending, setSending] = useState(false);

  const loadConversations = useCallback(async () => {
    try {
      const data = await api.listConversations();
      setConversations(data.conversations);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal memuat percakapan.");
    }
  }, []);

  useEffect(() => { void loadConversations(); }, [loadConversations]);

  const openConversation = async (conv: Conversation) => {
    setSelected(conv);
    setWindowClosed(false);
    try {
      const data = await api.listMessages(conv.id);
      setMessages(data.messages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal memuat pesan.");
    }
  };

  const sendReply = async () => {
    if (!selected || !replyText.trim()) return;
    setSending(true);
    try {
      await api.reply(selected.id, { kind: "free_form", text: replyText.trim() });
      setReplyText("");
      setWindowClosed(false);
      await openConversation(selected);
    } catch (err) {
      if (err instanceof ApiError && err.code === "MESSAGING_WINDOW_CLOSED") {
        setWindowClosed(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Gagal mengirim balasan.");
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold">Inbox</h1>
      <p className="mt-1 text-sm text-slate-500">Percakapan omnichannel. Balasan free-form mengikuti jendela 24 jam (fail closed).</p>
      {error && <div className="mt-4"><ErrorBox error={error} /></div>}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-2">
          {conversations.length === 0 && !error && (
            <EmptyState>Belum ada percakapan. Percakapan muncul setelah webhook pesan masuk diproses.</EmptyState>
          )}
          {conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => void openConversation(conv)}
              className={`w-full text-left rounded-lg border p-3 shadow-sm ${selected?.id === conv.id ? "border-slate-500 bg-white" : "border-slate-200 bg-white hover:bg-slate-50"}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{conv.contactDisplayName ?? conv.contactExternalId}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{conv.channel}</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Status: {conv.status} · Jendela balasan: {conv.windowOpen
                  ? <span className="text-emerald-600 font-medium">terbuka</span>
                  : <span className="text-red-600 font-medium">tertutup</span>}
              </div>
            </button>
          ))}
        </div>
        <div className="lg:col-span-2 rounded-lg border border-slate-200 bg-white shadow-sm flex flex-col min-h-96">
          {!selected ? (
            <div className="p-6 text-sm text-slate-500">Pilih percakapan untuk melihat thread dan membalas.</div>
          ) : (
            <>
              <div className="border-b border-slate-100 px-4 py-3 font-medium text-sm">
                {selected.contactDisplayName ?? selected.contactExternalId} · {selected.channel}
              </div>
              <div className="flex-1 p-4 space-y-2 overflow-y-auto">
                {messages.length === 0 && <div className="text-sm text-slate-400">Belum ada pesan di thread ini.</div>}
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-md rounded-lg px-3 py-2 text-sm ${m.direction === "out" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-800"}`}>
                      <div>{m.body ?? <em>({m.type})</em>}</div>
                      <div className={`mt-1 text-[11px] ${m.direction === "out" ? "text-slate-300" : "text-slate-400"}`}>{m.status}</div>
                    </div>
                  </div>
                ))}
              </div>
              {windowClosed && (
                <div className="mx-4 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <strong>Jendela pesan tertutup.</strong> Balasan free-form ditolak (MESSAGING_WINDOW_CLOSED).
                  Di luar jendela 24 jam, kirim pesan template yang sudah disetujui.
                </div>
              )}
              <div className="border-t border-slate-100 p-3 flex gap-2">
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  rows={2}
                  placeholder="Tulis balasan free-form..."
                  className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
                <button
                  onClick={() => void sendReply()}
                  disabled={sending || !replyText.trim()}
                  className="self-end rounded-md bg-slate-900 text-white text-sm px-4 py-2 disabled:opacity-50"
                >
                  {sending ? "Mengirim..." : "Kirim"}
                </button>
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
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (filterTag: string) => {
    try {
      const data = await api.listContacts(filterTag || undefined);
      setContacts(data.contacts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal memuat kontak.");
    }
  }, []);

  useEffect(() => { void load(""); }, [load]);

  return (
    <div>
      <h1 className="text-2xl font-semibold">Contacts</h1>
      <p className="mt-1 text-sm text-slate-500">CRM kontak per channel, dengan tag dan custom fields.</p>
      <div className="mt-4 flex gap-2 max-w-md">
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="Filter berdasarkan tag, mis. vip"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <button onClick={() => void load(tag)} className="rounded-md bg-slate-900 text-white text-sm px-4 py-2">Filter</button>
      </div>
      {error && <div className="mt-4"><ErrorBox error={error} /></div>}
      <div className="mt-4 rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
        {contacts.length === 0 && !error ? (
          <div className="px-4 py-6 text-sm text-slate-500">Belum ada kontak{tag ? ` dengan tag "${tag}"` : ""}.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Nama</th>
                <th className="px-4 py-2 font-medium">Channel</th>
                <th className="px-4 py-2 font-medium">ID Eksternal</th>
                <th className="px-4 py-2 font-medium">Tag</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((ct) => (
                <tr key={ct.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">{ct.displayName ?? "-"}</td>
                  <td className="px-4 py-2">{ct.channel}</td>
                  <td className="px-4 py-2">{ct.externalId}</td>
                  <td className="px-4 py-2">
                    <span className="flex gap-1 flex-wrap">
                      {(ct.tags ?? []).map((t) => (
                        <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{t}</span>
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

  const selectedTemplate = templates.find((t) => t.id === templateId);
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
      setError(err instanceof ApiError ? err.message : "Gagal menghitung estimasi.");
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
      setCreated(`Broadcast dibuat (id ${data.broadcast.id}, status ${data.broadcast.status}) dan masuk antrean worker.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal membuat broadcast.");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";
  const labelCls = "block text-xs font-medium text-slate-500 mb-1";

  return (
    <div>
      <h1 className="text-2xl font-semibold">Broadcast</h1>
      <p className="mt-1 text-sm text-slate-500">
        Kirim template ke banyak kontak. Routing mengikuti kategori TERBARU template
        (marketing → Marketing Messages API). Estimasi memakai rate card versi {estimate?.ratesVersion ?? "sample-2026-q4"}.
      </p>
      {error && <div className="mt-4 max-w-xl"><ErrorBox error={error} /></div>}
      {created && (
        <div className="mt-4 max-w-xl rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{created}</div>
      )}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
        <div>
          <label className={labelCls}>Template</label>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={inputCls}>
            <option value="">— pilih template (opsional untuk estimasi) —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.language}) · {t.latestCategory ?? t.category ?? "-"}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Channel Account ID</label>
          <input value={channelAccountId} onChange={(e) => setChannelAccountId(e.target.value)} placeholder="UUID akun channel" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Jumlah penerima</label>
          <input type="number" min={1} value={recipients} onChange={(e) => setRecipients(Number(e.target.value))} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Negara penerima (kode ISO)</label>
          <input value={country} onChange={(e) => setCountry(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button onClick={() => void doEstimate()} disabled={busy} className="rounded-md bg-slate-900 text-white text-sm px-4 py-2 disabled:opacity-50">
          Hitung Estimasi
        </button>
        <button
          onClick={() => void doCreate()}
          disabled={busy || !channelAccountId}
          className="rounded-md border border-slate-900 text-slate-900 text-sm px-4 py-2 disabled:opacity-50"
        >
          Buat Broadcast
        </button>
      </div>
      {estimate && (
        <div className="mt-6 max-w-3xl rounded-lg border border-slate-200 bg-white shadow-sm p-4">
          <div className="font-medium text-sm">Estimasi biaya</div>
          <div className="text-xs text-slate-500 mt-1">
            Rate card {estimate.ratesVersion} (efektif {estimate.ratesEffectiveDate}) · total penerima {estimate.totalRecipients}
          </div>
          <table className="w-full text-sm mt-3">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1 font-medium">Negara</th>
                <th className="py-1 font-medium">Kategori</th>
                <th className="py-1 font-medium">Ditagih</th>
                <th className="py-1 font-medium">Tarif</th>
                <th className="py-1 font-medium">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {estimate.lines.map((line, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1">{line.country}</td>
                  <td className="py-1">{line.category}</td>
                  <td className="py-1">{line.billable}</td>
                  <td className="py-1">${line.rateUsd.toFixed(4)}</td>
                  <td className="py-1">${line.subtotalUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 text-sm font-semibold">Total: ${estimate.totalUsd.toFixed(4)}</div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- App

function PlaceholderPage({ name }: { name: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold">{name}</h1>
      <p className="mt-2 text-slate-600 max-w-xl">Halaman ini masih placeholder dari Fase 0 dan dibangun di fase berikutnya.</p>
    </div>
  );
}

function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Selamat datang di Botara</h1>
      <p className="mt-2 text-slate-600 max-w-xl">
        Platform chatbot omnichannel yang dibangun dari nol (clean-room) dengan
        Bun + Hono di backend dan React + Vite di frontend.
      </p>
      <div className="mt-6 rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900 max-w-xl">
        <strong>Fase 1</strong> — Inbox, Contacts, dan Broadcast sudah terhubung ke API:
        adapter WhatsApp (routing kategori template) dan Telegram asli, jendela balasan 24 jam,
        estimasi biaya broadcast per rate card berversi.
      </div>
      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl">
        {[
          ["Channels", "WhatsApp, Instagram, Messenger, Threads, Telegram, Email"],
          ["Flow Engine", "Visual flow builder + interpreter deterministik"],
          ["AI Agents", "Provider LLM pluggable di belakang satu interface"],
        ].map(([title, desc]) => (
          <div key={title} className="rounded-lg bg-white border border-slate-200 p-4 shadow-sm">
            <div className="font-medium">{title}</div>
            <div className="text-sm text-slate-500 mt-1">{desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const [page, setPage] = useState("Dashboard");
  const [workspaceId, setWorkspaceIdState] = useState(getWorkspaceId());

  const changeWorkspace = (id: string) => {
    setWorkspaceIdState(id);
    setWorkspaceId(id);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      <aside className="w-60 shrink-0 bg-slate-900 text-slate-100 flex flex-col">
        <div className="px-5 py-5 border-b border-slate-700">
          <div className="text-xl font-bold tracking-tight">Botara</div>
          <div className="text-xs text-slate-400 mt-1">Omnichannel Chatbot Platform</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((item) => (
            <a
              key={item}
              href="#"
              onClick={(e) => { e.preventDefault(); setPage(item); }}
              className={`block rounded-md px-3 py-2 text-sm ${page === item ? "bg-slate-700 font-medium" : "text-slate-300 hover:bg-slate-800"}`}
            >
              {item}
            </a>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-slate-700">
          <label className="block text-xs text-slate-400 mb-1">Workspace ID (Fase 1)</label>
          <input
            value={workspaceId}
            onChange={(e) => changeWorkspace(e.target.value)}
            placeholder="UUID workspace"
            className="w-full rounded-md bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          <div className="text-[11px] text-slate-500 mt-2">Fase 1 · dikirim sebagai header X-Workspace-Id</div>
        </div>
      </aside>

      <main className="flex-1 p-8">
        {page === "Dashboard" && <DashboardPage />}
        {page === "Inbox" && <InboxPage />}
        {page === "Contacts" && <ContactsPage />}
        {page === "Broadcast" && <BroadcastPage />}
        {!["Dashboard", "Inbox", "Contacts", "Broadcast"].includes(page) && <PlaceholderPage name={page} />}
      </main>
    </div>
  );
}
