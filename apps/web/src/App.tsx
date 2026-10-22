import { useCallback, useEffect, useState } from "react";
import {
  api, ApiError, getWorkspaceId, setWorkspaceId,
  type BroadcastEstimate, type ChannelAccount, type Contact, type Conversation,
  type Message, type ScheduledPost, type Template,
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

// ----------------------------------------------------------------- Publish

function PublishPage() {
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
      setError(err instanceof ApiError ? err.message : "Gagal memuat data publishing.");
    }
  }, []);

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
      setScheduledAt("");
      setNotice(scheduledAt ? "Post terjadwal dibuat. Worker akan mempublikasikannya saat waktunya tiba." : "Post dibuat sebagai draft. Gunakan tombol Terbitkan untuk mengirim sekarang.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal membuat post.");
    } finally {
      setBusy(false);
    }
  };

  const publishNow = async (post: ScheduledPost) => {
    setBusy(true);
    setError(null);
    try {
      await api.publishPostNow(post.id);
      setNotice("Job publish masuk antrean worker. Status per-target akan muncul setelah worker selesai.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal menerbitkan post.");
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
      setError(err instanceof ApiError ? err.message : "Gagal menghapus post.");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";
  const labelCls = "block text-xs font-medium text-slate-500 mb-1";

  return (
    <div>
      <h1 className="text-2xl font-semibold">Publish</h1>
      <p className="mt-1 text-sm text-slate-500">
        Satu konten, banyak channel. Instagram &amp; Threads mempublikasikan dari URL media publik (R2);
        kegagalan satu target tidak menggagalkan target lain (status parsial).
      </p>
      {error && <div className="mt-4 max-w-3xl"><ErrorBox error={error} /></div>}
      {notice && (
        <div className="mt-4 max-w-3xl rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</div>
      )}

      <div className="mt-6 max-w-3xl rounded-lg border border-slate-200 bg-white shadow-sm p-4 space-y-4">
        <div>
          <label className={labelCls}>Konten</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Tulis caption / isi post..."
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>URL media publik (opsional, untuk Instagram/Threads wajib)</label>
          <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://media.example.com/foto.jpg" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Channel tujuan</label>
          {publishable.length === 0 ? (
            <div className="text-sm text-slate-400">Belum ada akun channel yang bisa publish (Instagram/Threads/Messenger/Telegram). Hubungkan akun dulu di menu Channels.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {publishable.map((acc) => (
                <label key={acc.id} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm cursor-pointer ${selected.has(acc.id) ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white"}`}>
                  <input type="checkbox" checked={selected.has(acc.id)} onChange={() => toggle(acc.id)} className="hidden" />
                  {acc.channel} · {acc.displayName ?? acc.externalId}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="max-w-xs">
          <label className={labelCls}>Jadwal terbit (kosongkan = draft)</label>
          <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className={inputCls} />
        </div>
        <button
          onClick={() => void create()}
          disabled={busy || selected.size === 0 || (!text.trim() && !mediaUrl.trim())}
          className="rounded-md bg-slate-900 text-white text-sm px-4 py-2 disabled:opacity-50"
        >
          {scheduledAt ? "Jadwalkan Post" : "Simpan Draft"}
        </button>
      </div>

      <div className="mt-6 max-w-3xl space-y-3">
        <div className="font-medium text-sm">Post terjadwal &amp; terbit</div>
        {posts.length === 0 && !error && <EmptyState>Belum ada post. Buat dari composer di atas.</EmptyState>}
        {posts.map((post) => (
          <div key={post.id} className="rounded-lg border border-slate-200 bg-white shadow-sm p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm whitespace-pre-wrap">{post.text ?? <em className="text-slate-400">(tanpa teks)</em>}</div>
              <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{post.status}</span>
            </div>
            {post.mediaUrls.length > 0 && (
              <div className="mt-2 text-xs text-slate-500 break-all">{post.mediaUrls.join(", ")}</div>
            )}
            <div className="mt-1 text-xs text-slate-500">
              {post.scheduledAt ? `Terjadwal: ${new Date(post.scheduledAt).toLocaleString()}` : "Draft / terbit manual"}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {post.targets.map((t) => {
                const result = post.results[t.channelAccountId];
                return (
                  <span key={t.channelAccountId} className={`text-xs px-2 py-1 rounded-md border ${result?.status === "sent" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : result?.status === "failed" ? "border-red-300 bg-red-50 text-red-800" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
                    {accountLabel(t.channelAccountId)}
                    {result?.status === "sent" && ` ✓ ${result.externalPostId ?? ""}`}
                    {result?.status === "failed" && ` ✗ ${result.error ?? "gagal"}`}
                    {!result && " · menunggu"}
                  </span>
                );
              })}
            </div>
            <div className="mt-3 flex gap-2">
              {post.status !== "published" && post.status !== "cancelled" && (
                <button onClick={() => void publishNow(post)} disabled={busy} className="rounded-md bg-slate-900 text-white text-xs px-3 py-1.5 disabled:opacity-50">
                  Terbitkan sekarang
                </button>
              )}
              <button onClick={() => void remove(post)} disabled={busy} className="rounded-md border border-slate-300 text-slate-600 text-xs px-3 py-1.5 disabled:opacity-50">
                Hapus
              </button>
            </div>
          </div>
        ))}
      </div>
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
        <strong>Fase 2</strong> — Semua channel aktif: Instagram (dua mode login), Messenger,
        Threads (publish + moderasi), email via Resend, dan webchat widget milik Botara.
        Layar Publish menjadwalkan satu konten ke banyak channel dengan status per-target.
        Fase 1: Inbox, Contacts, Broadcast (WhatsApp routing kategori + Telegram).
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
        {page === "Publish" && <PublishPage />}
        {!["Dashboard", "Inbox", "Contacts", "Broadcast", "Publish"].includes(page) && <PlaceholderPage name={page} />}
      </main>
    </div>
  );
}
