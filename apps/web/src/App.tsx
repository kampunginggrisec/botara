import { useCallback, useEffect, useState } from "react";
import {
  api, ApiError, getToken, getWorkspaceId, onUnauthorized, setToken, setWorkspaceId,
  type AuthUser, type BroadcastEstimate, type ChannelAccount, type Contact, type Conversation,
  type KbDocument, type Message, type ScheduledPost, type Template, type WorkspaceSummary,
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
        <strong>Fase 3-4</strong> — Production hardening: autentikasi email+password dengan
        sesi JWT dan peran workspace, token vault terenkripsi (AES-256-GCM), knowledge base
        + balasan AI (node ai_reply), observability, rate limiting, dan paket Meta App Review.
        Fase 2: semua channel aktif (Instagram dua mode login, Messenger, Threads, email
        Resend, webchat widget). Fase 1: Inbox, Contacts, Broadcast.
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

// ------------------------------------------------------------ auth (Fase 3)

function AuthPage({ onAuthenticated }: { onAuthenticated: () => void }) {
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
      setWorkspaceId(res.workspace.id);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal masuk. Coba lagi.");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-sm p-6">
        <div className="text-2xl font-bold tracking-tight">Botara</div>
        <div className="text-sm text-slate-500 mt-1">
          {mode === "login" ? "Masuk ke workspace Anda." : "Buat akun dan workspace pertama Anda."}
        </div>
        {error && <div className="mt-4"><ErrorBox error={error} /></div>}
        <div className="mt-5 space-y-3">
          {mode === "register" && (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama Anda" className={inputCls} />
              <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Nama workspace / bisnis (opsional)" className={inputCls} />
            </>
          )}
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="email@bisnis.id" className={inputCls} />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Kata sandi (min. 8 karakter)" className={inputCls} />
          <button
            onClick={() => void submit()}
            disabled={busy || !email || password.length < 8}
            className="w-full rounded-md bg-slate-900 text-white text-sm px-4 py-2 disabled:opacity-50"
          >
            {busy ? "Memproses..." : mode === "login" ? "Masuk" : "Daftar"}
          </button>
        </div>
        <div className="mt-4 text-sm text-slate-500 text-center">
          {mode === "login" ? (
            <>Belum punya akun?{" "}
              <button className="text-slate-900 underline" onClick={() => setMode("register")}>Daftar</button></>
          ) : (
            <>Sudah punya akun?{" "}
              <button className="text-slate-900 underline" onClick={() => setMode("login")}>Masuk</button></>
          )}
        </div>
        <div className="mt-6 text-center text-xs text-slate-400 space-x-3">
          <a href="/privacy" className="underline">Kebijakan Privasi</a>
          <a href="/terms" className="underline">Ketentuan Layanan</a>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------- knowledge base UI

function KnowledgePage() {
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
      setError(err instanceof ApiError ? err.message : "Gagal memuat dokumen.");
    }
  }, []);
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
      setError(err instanceof ApiError ? err.message : "Gagal menyimpan dokumen.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteKbDocument(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal menghapus dokumen.");
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold">Knowledge Base</h1>
      <p className="mt-1 text-sm text-slate-500 max-w-xl">
        Dokumen dipecah menjadi chunk dan di-embed oleh worker; dipakai node
        flow <em>ai_reply</em> dan saran balasan AI di Inbox (retrieval top-3 cosine).
      </p>
      {error && <div className="mt-4 max-w-xl"><ErrorBox error={error} /></div>}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm space-y-3">
          <div className="font-medium text-sm">Tambah dokumen</div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Judul (mis. FAQ Pengiriman)" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} placeholder="Isi dokumen..." className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <button onClick={() => void create()} disabled={busy || !title.trim() || !content.trim()} className="rounded-md bg-slate-900 text-white text-sm px-4 py-2 disabled:opacity-50">
            {busy ? "Menyimpan..." : "Simpan & proses"}
          </button>
        </div>
        <div className="space-y-2">
          {documents.length === 0 && !error && <EmptyState>Belum ada dokumen. Tambahkan FAQ atau panduan produk pertama Anda.</EmptyState>}
          {documents.map((d) => (
            <div key={d.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">{d.title}</div>
                <div className="text-xs text-slate-500">
                  Status: {d.status} · {d.chunkCount} chunk{d.error ? ` · ${d.error}` : ""}
                </div>
              </div>
              <button onClick={() => void remove(d.id)} className="text-xs text-red-600 underline">Hapus</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- legal pages
// TEMPLATE legal text - the business owner must have these reviewed by
// their own legal counsel before production use (see docs/app-review).

function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <a href="/" className="text-sm text-slate-500 underline">← Botara</a>
        <h1 className="text-3xl font-bold mt-4">{title}</h1>
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>TEMPLATE.</strong> Teks ini adalah draf awal dan WAJIB ditinjau serta
          disesuaikan oleh pemilik bisnis (dan penasihat hukum bila perlu) sebelum
          dipakai produksi.
        </div>
        <div className="mt-6 space-y-4 text-sm leading-6 text-slate-700">{children}</div>
      </div>
    </div>
  );
}

function PrivacyPage() {
  return (
    <LegalShell title="Kebijakan Privasi">
      <p><strong>Terakhir diperbarui:</strong> [TANGGAL — isi sebelum publikasi]</p>
      <h2 className="text-base font-semibold text-slate-900">1. Data yang kami proses</h2>
      <p>
        Botara adalah platform chatbot omnichannel. Kami memproses: (a) data akun
        pengguna (nama, email, kata sandi ter-hash); (b) kredensial channel yang
        Anda hubungkan (disimpan terenkripsi); (c) pesan dan kontak pelanggan akhir
        yang melewati channel Anda (WhatsApp, Instagram, Messenger, Threads,
        Telegram, email, webchat) semata untuk menyediakan layanan.
      </p>
      <h2 className="text-base font-semibold text-slate-900">2. Dasar dan tujuan</h2>
      <p>
        Data diproses untuk mengoperasikan inbox, otomasi/flow, broadcast, dan
        fitur AI (saran balasan dan knowledge base) atas instruksi Anda sebagai
        pengendali data pelanggan Anda.
      </p>
      <h2 className="text-base font-semibold text-slate-900">3. Berbagi data</h2>
      <p>
        Kami tidak menjual data. Data diteruskan hanya ke penyedia yang diperlukan:
        Meta (WhatsApp/Instagram/Messenger/Threads), Telegram, Resend (email),
        penyedia LLM yang Anda pilih, dan infrastruktur hosting — masing-masing
        sebatas kebutuhan layanan.
      </p>
      <h2 className="text-base font-semibold text-slate-900">4. Retensi dan penghapusan</h2>
      <p>
        Data disimpan selama akun aktif. Permintaan penghapusan dari pengguna
        platform Meta diproses melalui callback penghapusan data kami; statusnya
        dapat diperiksa pada URL status yang diterbitkan saat permintaan diterima.
        Hubungi [EMAIL PRIVASI] untuk permintaan penghapusan lainnya.
      </p>
      <h2 className="text-base font-semibold text-slate-900">5. Keamanan</h2>
      <p>
        Kredensial channel dienkripsi at-rest (AES-256-GCM), kata sandi di-hash
        (argon2id), dan akses dibatasi per workspace dengan peran anggota.
      </p>
      <h2 className="text-base font-semibold text-slate-900">6. Kontak</h2>
      <p>Pertanyaan privasi: [EMAIL PRIVASI] · [NAMA & ALAMAT BISNIS]</p>
    </LegalShell>
  );
}

function TermsPage() {
  return (
    <LegalShell title="Ketentuan Layanan">
      <p><strong>Terakhir diperbarui:</strong> [TANGGAL — isi sebelum publikasi]</p>
      <h2 className="text-base font-semibold text-slate-900">1. Layanan</h2>
      <p>
        Botara menyediakan platform chatbot omnichannel (inbox, otomasi,
        broadcast, penerbitan konten, dan fitur AI) sebagai perangkat lunak.
        Fitur yang bergantung pada platform pihak ketiga (Meta, Telegram,
        Resend) tunduk juga pada ketentuan platform tersebut.
      </p>
      <h2 className="text-base font-semibold text-slate-900">2. Akun dan tanggung jawab</h2>
      <p>
        Anda bertanggung jawab atas keamanan kredensial akun, kepatuhan pesan
        yang Anda kirim (termasuk persetujuan penerima dan jendela pesan Meta),
        serta konten knowledge base yang Anda unggah.
      </p>
      <h2 className="text-base font-semibold text-slate-900">3. Penggunaan yang dilarang</h2>
      <p>
        Spam, penipuan, pelanggaran kebijakan platform channel, dan konten yang
        melanggar hukum dilarang dan dapat berakibat penangguhan akun.
      </p>
      <h2 className="text-base font-semibold text-slate-900">4. Ketersediaan dan tanggung jawab</h2>
      <p>
        Layanan disediakan "sebagaimana adanya" selama masa uji coba. [BATASAN
        TANGGUNG JAWAB — lengkapi setelah tinjauan hukum.]
      </p>
      <h2 className="text-base font-semibold text-slate-900">5. Perubahan</h2>
      <p>
        Ketentuan dapat diperbarui; perubahan material diumumkan melalui email
        atau pemberitahuan dalam aplikasi.
      </p>
    </LegalShell>
  );
}

// ------------------------------------------------------------------ shell

export function App() {
  // Public legal routes are pathname-based (the SPA has no router) and
  // never require auth - Meta App Review links straight to them.
  if (window.location.pathname === "/privacy") return <PrivacyPage />;
  if (window.location.pathname === "/terms") return <TermsPage />;

  return <AuthedApp />;
}

function AuthedApp() {
  const [page, setPage] = useState("Dashboard");
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

  if (!ready) {
    return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">Memuat...</div>;
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
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); setPage("Knowledge"); }}
            className={`block rounded-md px-3 py-2 text-sm ${page === "Knowledge" ? "bg-slate-700 font-medium" : "text-slate-300 hover:bg-slate-800"}`}
          >
            Knowledge Base
          </a>
        </nav>
        <div className="px-5 py-4 border-t border-slate-700 space-y-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Workspace</label>
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
            {user.email}{currentWorkspace ? ` · peran: ${currentWorkspace.role}` : ""}
          </div>
          <button
            onClick={() => void logout()}
            className="w-full rounded-md bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 hover:bg-slate-700"
          >
            Keluar
          </button>
          <div className="text-[11px] text-slate-500 space-x-2">
            <a href="/privacy" className="underline">Privasi</a>
            <a href="/terms" className="underline">Ketentuan</a>
          </div>
        </div>
      </aside>

      <main className="flex-1 p-8">
        {page === "Dashboard" && <DashboardPage />}
        {page === "Inbox" && <InboxPage />}
        {page === "Contacts" && <ContactsPage />}
        {page === "Broadcast" && <BroadcastPage />}
        {page === "Publish" && <PublishPage />}
        {page === "Knowledge" && <KnowledgePage />}
        {!["Dashboard", "Inbox", "Contacts", "Broadcast", "Publish", "Knowledge"].includes(page) && <PlaceholderPage name={page} />}
      </main>
    </div>
  );
}
