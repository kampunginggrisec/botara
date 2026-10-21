const NAV = ["Dashboard", "Inbox", "Contacts", "Flows", "Broadcast", "Sequences", "Publish", "Channels", "Settings"];

export function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Sidebar - placeholder dashboard shell */}
      <aside className="w-60 shrink-0 bg-slate-900 text-slate-100 flex flex-col">
        <div className="px-5 py-5 border-b border-slate-700">
          <div className="text-xl font-bold tracking-tight">Botara</div>
          <div className="text-xs text-slate-400 mt-1">Omnichannel Chatbot Platform</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((item, i) => (
            <a
              key={item}
              href="#"
              onClick={(e) => e.preventDefault()}
              className={`block rounded-md px-3 py-2 text-sm ${i === 0 ? "bg-slate-700 font-medium" : "text-slate-300 hover:bg-slate-800"}`}
            >
              {item}
            </a>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-slate-700 text-xs text-slate-400">Fase 0 scaffold</div>
      </aside>

      {/* Main */}
      <main className="flex-1 p-8">
        <h1 className="text-2xl font-semibold">Selamat datang di Botara</h1>
        <p className="mt-2 text-slate-600 max-w-xl">
          Ini adalah kerangka dashboard Botara. Platform chatbot omnichannel ini
          dibangun dari nol (clean-room) dengan Bun + Hono di backend dan
          React + Vite di frontend.
        </p>
        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 max-w-xl">
          <strong>Fase 0 scaffold</strong> — struktur monorepo, kontrak channel
          adapter, dan layanan dasar (API, worker, realtime) sudah berjalan.
          Fitur produk (inbox, flow builder, broadcast) dibangun di fase berikutnya.
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
      </main>
    </div>
  );
}
