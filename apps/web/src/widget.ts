/**
 * Botara webchat widget (Fase 2; i18n + theming Fase 4) - the embeddable
 * website chat.
 *
 * Plain TypeScript, no framework: it is built into a standalone IIFE bundle
 * (dist/widget.js) that a site owner pastes into any page:
 *
 *   <script src="https://DOMAIN/widget.js"
 *           data-workspace-id="YOUR_WORKSPACE_ID"
 *           data-api-url="https://DOMAIN/api"
 *           data-title="Chat with us"        (optional)
 *           data-lang="en"                   (optional: en | id, default en)
 *           data-theme="auto"                (optional: light | dark | auto)
 *           async></script>
 *
 * Flow: renders a chat bubble; on first open it creates a visitor session
 * (POST /public/webchat/:workspaceId/session), stores the session token in
 * localStorage, sends visitor messages, and polls for agent replies every
 * few seconds. The agent side is the normal Botara inbox (channel: webchat).
 *
 * `data-theme="auto"` (the default) follows the HOST page visitor's
 * prefers-color-scheme; "light" / "dark" pin the palette.
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

type WidgetLang = "en" | "id";

const WIDGET_STRINGS: Record<WidgetLang, { title: string; placeholder: string; send: string }> = {
  en: { title: "Chat with us", placeholder: "Type a message...", send: "Send" },
  id: { title: "Chat dengan kami", placeholder: "Tulis pesan...", send: "Kirim" },
};

const scriptEl = (document.currentScript as HTMLScriptElement | null)
  ?? document.querySelector<HTMLScriptElement>("script[data-workspace-id][src*='widget']");

const workspaceId = scriptEl?.dataset.workspaceId ?? "";
const apiUrl = (scriptEl?.dataset.apiUrl ?? "").replace(/\/$/, "");
const widgetLang: WidgetLang = scriptEl?.dataset.lang === "id" ? "id" : "en";
const strings = WIDGET_STRINGS[widgetLang];
const widgetTitle = scriptEl?.dataset.title ?? strings.title;

const themeAttr = scriptEl?.dataset.theme;
const darkMode = themeAttr === "dark"
  || (themeAttr !== "light"
    && typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches);

const palette = darkMode ? {
  panelBg: "#0f172a", headerBg: "#1e293b", headerText: "#f1f5f9",
  messagesBg: "#020617", mineBg: "#f1f5f9", mineText: "#0f172a",
  theirsBg: "#1e293b", theirsText: "#e2e8f0",
  inputRowBg: "#0f172a", inputRowBorder: "#1e293b", inputBorder: "#334155",
  inputBg: "#020617", inputText: "#f1f5f9",
  bubbleBg: "#f1f5f9", bubbleText: "#0f172a", sendBg: "#f1f5f9", sendText: "#0f172a",
} : {
  panelBg: "#ffffff", headerBg: "#0f172a", headerText: "#ffffff",
  messagesBg: "#f8fafc", mineBg: "#0f172a", mineText: "#ffffff",
  theirsBg: "#e2e8f0", theirsText: "#0f172a",
  inputRowBg: "#ffffff", inputRowBorder: "#e2e8f0", inputBorder: "#cbd5e1",
  inputBg: "#ffffff", inputText: "#0f172a",
  bubbleBg: "#0f172a", bubbleText: "#ffffff", sendBg: "#0f172a", sendText: "#ffffff",
};

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
    background: palette.bubbleBg, color: palette.bubbleText, fontSize: "24px", cursor: "pointer",
    boxShadow: "0 8px 24px rgba(0,0,0,.25)",
  }, "💬");
  bubble.setAttribute("aria-label", widgetTitle);

  const panel = el("div", {
    position: "fixed", right: "20px", bottom: "88px", zIndex: "2147483000",
    width: "340px", maxWidth: "calc(100vw - 32px)", height: "460px", maxHeight: "calc(100vh - 120px)",
    background: palette.panelBg, borderRadius: "14px", overflow: "hidden", display: "none",
    flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,.28)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  });

  const header = el("div", {
    background: palette.headerBg, color: palette.headerText, padding: "12px 16px",
    fontSize: "14px", fontWeight: "600",
  }, widgetTitle);

  const messagesBox = el("div", {
    flex: "1", overflowY: "auto", padding: "12px", display: "flex",
    flexDirection: "column", gap: "8px", background: palette.messagesBg,
  });

  const inputRow = el("div", {
    display: "flex", gap: "8px", padding: "10px",
    borderTop: `1px solid ${palette.inputRowBorder}`, background: palette.inputRowBg,
  });
  const input = el("input", {
    flex: "1", border: `1px solid ${palette.inputBorder}`, borderRadius: "8px",
    padding: "8px 10px", fontSize: "14px", outline: "none",
    background: palette.inputBg, color: palette.inputText,
  });
  input.type = "text";
  input.placeholder = strings.placeholder;
  input.maxLength = 2000;
  const sendBtn = el("button", {
    background: palette.sendBg, color: palette.sendText, border: "none", borderRadius: "8px",
    padding: "8px 14px", fontSize: "14px", cursor: "pointer",
  }, strings.send);
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
      background: mine ? palette.mineBg : palette.theirsBg,
      color: mine ? palette.mineText : palette.theirsText,
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
