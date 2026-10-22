/**
 * Botara webchat widget (Fase 2) - the embeddable website chat.
 *
 * Plain TypeScript, no framework: it is built into a standalone IIFE bundle
 * (dist/widget.js) that a site owner pastes into any page:
 *
 *   <script src="https://DOMAIN/widget.js"
 *           data-workspace-id="YOUR_WORKSPACE_ID"
 *           data-api-url="https://DOMAIN/api" async></script>
 *
 * Flow: renders a chat bubble; on first open it creates a visitor session
 * (POST /public/webchat/:workspaceId/session), stores the session token in
 * localStorage, sends visitor messages, and polls for agent replies every
 * few seconds. The agent side is the normal Botara inbox (channel: webchat).
 *
 * This widget exists because Meta's Customer Chat Plugin retired
 * 2024-05-09 with no replacement - Botara ships its own.
 */

interface WidgetMessage {
  id: string;
  direction: "in" | "out";
  body: string | null;
  createdAt: string;
}

const scriptEl = (document.currentScript as HTMLScriptElement | null)
  ?? document.querySelector<HTMLScriptElement>("script[data-workspace-id][src*='widget']");

const workspaceId = scriptEl?.dataset.workspaceId ?? "";
const apiUrl = (scriptEl?.dataset.apiUrl ?? "").replace(/\/$/, "");
const widgetTitle = scriptEl?.dataset.title ?? "Chat dengan kami";

const TOKEN_KEY = `botara.webchat.${workspaceId}`;
const POLL_MS = 3000;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  styles: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, styles);
  if (text !== undefined) node.textContent = text;
  return node;
}

function init(): void {
  if (!workspaceId || !apiUrl) {
    console.warn("[botara-webchat] data-workspace-id and data-api-url are required on the widget script tag.");
    return;
  }

  const bubble = el("button", {
    position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483000",
    width: "56px", height: "56px", borderRadius: "9999px", border: "none",
    background: "#0f172a", color: "#fff", fontSize: "24px", cursor: "pointer",
    boxShadow: "0 8px 24px rgba(0,0,0,.25)",
  }, "💬");
  bubble.setAttribute("aria-label", widgetTitle);

  const panel = el("div", {
    position: "fixed", right: "20px", bottom: "88px", zIndex: "2147483000",
    width: "340px", maxWidth: "calc(100vw - 32px)", height: "460px", maxHeight: "calc(100vh - 120px)",
    background: "#fff", borderRadius: "14px", overflow: "hidden", display: "none",
    flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,.28)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  });

  const header = el("div", {
    background: "#0f172a", color: "#fff", padding: "12px 16px",
    fontSize: "14px", fontWeight: "600",
  }, widgetTitle);

  const messagesBox = el("div", {
    flex: "1", overflowY: "auto", padding: "12px", display: "flex",
    flexDirection: "column", gap: "8px", background: "#f8fafc",
  });

  const inputRow = el("div", {
    display: "flex", gap: "8px", padding: "10px", borderTop: "1px solid #e2e8f0", background: "#fff",
  });
  const input = el("input", {
    flex: "1", border: "1px solid #cbd5e1", borderRadius: "8px",
    padding: "8px 10px", fontSize: "14px", outline: "none",
  });
  input.type = "text";
  input.placeholder = "Tulis pesan...";
  input.maxLength = 2000;
  const sendBtn = el("button", {
    background: "#0f172a", color: "#fff", border: "none", borderRadius: "8px",
    padding: "8px 14px", fontSize: "14px", cursor: "pointer",
  }, "Kirim");
  inputRow.append(input, sendBtn);
  panel.append(header, messagesBox, inputRow);
  document.body.append(bubble, panel);

  let sessionToken = localStorage.getItem(TOKEN_KEY) ?? "";
  let open = false;
  let polling = false;
  const rendered = new Set<string>();

  function renderMessage(m: WidgetMessage): void {
    if (rendered.has(m.id) || !m.body) return;
    rendered.add(m.id);
    const mine = m.direction === "in"; // "in" = written by the visitor
    const row = el("div", { display: "flex", justifyContent: mine ? "flex-end" : "flex-start" });
    const chip = el("div", {
      maxWidth: "80%", borderRadius: "10px", padding: "8px 10px", fontSize: "14px",
      background: mine ? "#0f172a" : "#e2e8f0", color: mine ? "#fff" : "#0f172a",
      whiteSpace: "pre-wrap", wordBreak: "break-word",
    }, m.body);
    row.append(chip);
    messagesBox.append(row);
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }

  async function api(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(sessionToken ? { "x-webchat-session": sessionToken } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`webchat API ${res.status}`);
    return res.json();
  }

  async function ensureSession(): Promise<void> {
    if (sessionToken) return;
    const data = await api(`/public/webchat/${encodeURIComponent(workspaceId)}/session`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    sessionToken = data.sessionToken as string;
    localStorage.setItem(TOKEN_KEY, sessionToken);
  }

  async function loadMessages(): Promise<void> {
    const data = await api(`/public/webchat/${encodeURIComponent(workspaceId)}/messages`);
    for (const m of data.messages as WidgetMessage[]) renderMessage(m);
  }

  async function poll(): Promise<void> {
    if (!open) { polling = false; return; }
    try {
      await loadMessages();
    } catch {
      // A stale token (session expired server-side) resets the widget.
      sessionToken = "";
      localStorage.removeItem(TOKEN_KEY);
      rendered.clear();
      messagesBox.replaceChildren();
    }
    if (open) window.setTimeout(() => void poll(), POLL_MS);
    else polling = false;
  }

  async function send(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      await ensureSession();
      const data = await api(`/public/webchat/${encodeURIComponent(workspaceId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      renderMessage(data.message as WidgetMessage);
    } catch {
      input.value = text; // keep the draft so the visitor can retry
    }
  }

  bubble.addEventListener("click", () => {
    open = !open;
    panel.style.display = open ? "flex" : "none";
    if (open) {
      void (async () => {
        try {
          await ensureSession();
          await loadMessages();
          if (!polling) { polling = true; window.setTimeout(() => void poll(), POLL_MS); }
          input.focus();
        } catch {
          // API unreachable - the panel stays open; sending retries lazily.
        }
      })();
    }
  });
  sendBtn.addEventListener("click", () => void send());
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void send();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
