import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ChannelAccount, type IceBreaker, type PersistentMenuItem, type WelcomeMessageFlow,
} from "./api";
import { useI18n } from "./i18n";
import { pushToast } from "./toast";

/**
 * Instagram automation panel (IG-1 + IG-2) on the Channels page.
 *
 * Two provider-side surfaces that are NOT Botara flows:
 *
 * - **Welcome message flows** run on Meta BEFORE a conversation exists, so
 *   they cannot be built with the flow engine (there is no contact, no
 *   conversation id, nothing to trigger on). They are a provider resource:
 *   named, versioned, deletable.
 * - **Messaging profile** is the persistent menu + ice breakers a customer
 *   sees in the DM composer. Same endpoint family as Messenger's, addressed
 *   by the Instagram account and tagged `platform: instagram` by the adapter.
 *
 * The editor intentionally covers the common shape (one message with up to
 * a few quick replies, a flat menu, up to four ice breakers) and preserves
 * whatever else a flow already contains rather than dropping it.
 */

const cardCls = "rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900";
const inputCls = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500";
const labelCls = "block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1";
const primaryBtn = "rounded-md bg-slate-900 text-white text-sm px-4 py-2 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900";
const subtleBtn = "rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200";
const linkBtn = "text-xs text-slate-600 underline dark:text-slate-300";
const dangerBtn = "text-xs text-red-600 underline disabled:opacity-50 dark:text-red-400";

/** Pull the first message + quick replies out of a provider flow body. */
function readFirstMessage(flow: unknown[]): { text: string; quickReplies: Array<{ title: string; payload: string }> } {
  const first = flow[0] as { message?: { text?: unknown; quick_replies?: unknown } } | undefined;
  const text = typeof first?.message?.text === "string" ? first.message.text : "";
  const replies = Array.isArray(first?.message?.quick_replies)
    ? (first.message.quick_replies as Array<Record<string, unknown>>).map((r) => ({
      title: typeof r.title === "string" ? r.title : "",
      payload: typeof r.payload === "string" ? r.payload : "",
    }))
    : [];
  return { text, quickReplies: replies };
}

/** Shape the editor fields back into the provider body. */
function buildFlowBody(
  text: string,
  quickReplies: Array<{ title: string; payload: string }>,
  preserved: unknown[],
): unknown[] {
  const replies = quickReplies
    .filter((r) => r.title.trim().length > 0 && r.payload.trim().length > 0)
    .map((r) => ({ content_type: "text", title: r.title.trim(), payload: r.payload.trim() }));
  const first = {
    message: {
      text: text.trim(),
      ...(replies.length > 0 ? { quick_replies: replies } : {}),
    },
  };
  return [first, ...preserved];
}

export function InstagramAutomation({ accounts }: { accounts: ChannelAccount[] }) {
  const { t } = useI18n();
  const automationAccounts = accounts.filter((a) => a.channel === "instagram" || a.channel === "messenger");
  const [accountId, setAccountId] = useState("");
  const selected = automationAccounts.find((a) => a.id === accountId);
  const isInstagram = selected?.channel === "instagram";

  // --- welcome flows --------------------------------------------------------
  const [flows, setFlows] = useState<WelcomeMessageFlow[]>([]);
  const [flowsError, setFlowsError] = useState<string | null>(null);
  const [flowsBusy, setFlowsBusy] = useState(false);
  /** null = closed, "new" = blank editor, otherwise the flow id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [flowName, setFlowName] = useState("");
  const [flowText, setFlowText] = useState("");
  const [flowReplies, setFlowReplies] = useState<Array<{ title: string; payload: string }>>([]);
  /** Messages after the first, kept verbatim so an edit does not drop them. */
  const [preserved, setPreserved] = useState<unknown[]>([]);
  const [saving, setSaving] = useState(false);

  // --- messaging profile ----------------------------------------------------
  const [menuItems, setMenuItems] = useState<PersistentMenuItem[]>([]);
  const [iceBreakers, setIceBreakers] = useState<IceBreaker[]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);

  const loadFlows = useCallback(async (id: string) => {
    if (!id) return;
    setFlowsBusy(true);
    try {
      const res = await api.listWelcomeFlows(id);
      setFlows(res.flows);
      setFlowsError(null);
    } catch (err) {
      setFlowsError(err instanceof Error ? err.message : t("igAutomation.flowsLoadFailed"));
    } finally {
      setFlowsBusy(false);
    }
  }, [t]);

  const loadProfile = useCallback(async (id: string) => {
    if (!id) return;
    setProfileBusy(true);
    try {
      const res = await api.getMessengerProfile(id, ["persistent_menu", "ice_breakers"]);
      // The provider wraps profile fields in a `data` array; tolerate both.
      const data = (res.profile as { data?: unknown }).data;
      const entry = (Array.isArray(data) ? data[0] : res.profile) as Record<string, unknown> | undefined;
      const menu = entry?.persistent_menu;
      const firstMenu = Array.isArray(menu) ? menu[0] as { call_to_actions?: unknown } : undefined;
      const actions = Array.isArray(firstMenu?.call_to_actions)
        ? (firstMenu.call_to_actions as Array<Record<string, unknown>>).map((item) => ({
          type: String(item.type ?? "postback") === "web_url" ? "web_url" as const : "postback" as const,
          title: typeof item.title === "string" ? item.title : "",
          ...(typeof item.payload === "string" ? { payload: item.payload } : {}),
          ...(typeof item.url === "string" ? { url: item.url } : {}),
        }))
        : [];
      const breaks = Array.isArray(entry?.ice_breakers)
        ? (entry.ice_breakers as Array<Record<string, unknown>>).map((b) => ({
          question: typeof b.question === "string" ? b.question : "",
          payload: typeof b.payload === "string" ? b.payload : "",
        }))
        : [];
      setMenuItems(actions);
      setIceBreakers(breaks);
      setProfileError(null);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : t("igAutomation.profileLoadFailed"));
    } finally {
      setProfileBusy(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId) {
      setFlows([]);
      setMenuItems([]);
      setIceBreakers([]);
      return;
    }
    setEditing(null);
    void loadFlows(accountId);
    void loadProfile(accountId);
  }, [accountId, loadFlows, loadProfile]);

  const openNewFlow = () => {
    setEditing("new");
    setFlowName("");
    setFlowText("");
    setFlowReplies([]);
    setPreserved([]);
  };

  const openEditFlow = async (flow: WelcomeMessageFlow) => {
    if (!accountId) return;
    setEditing(flow.id);
    // Re-read the flow before editing: the list may be minutes old and an
    // edit replaces the WHOLE body on the provider.
    let current = flow;
    try {
      const fresh = await api.getWelcomeFlow(accountId, flow.id);
      current = fresh.flow;
    } catch { /* fall back to the listed copy */ }
    const parsed = readFirstMessage(current.flow);
    setFlowName(current.name);
    setFlowText(parsed.text);
    setFlowReplies(parsed.quickReplies);
    setPreserved(current.flow.slice(1));
  };

  const saveFlow = async () => {
    if (!accountId || !editing) return;
    setSaving(true);
    try {
      const body = { name: flowName.trim(), flow: buildFlowBody(flowText, flowReplies, preserved) };
      if (editing === "new") await api.createWelcomeFlow(accountId, body);
      else await api.updateWelcomeFlow(accountId, editing, body);
      pushToast("ok", t("igAutomation.flowSaved"));
      setEditing(null);
      await loadFlows(accountId);
    } catch (err) {
      pushToast("err", err instanceof Error ? err.message : t("igAutomation.flowSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const deleteFlow = async (flow: WelcomeMessageFlow) => {
    if (!accountId) return;
    if (!window.confirm(t("igAutomation.flowDeleteConfirm", { name: flow.name }))) return;
    try {
      await api.deleteWelcomeFlow(accountId, flow.id);
      pushToast("ok", t("igAutomation.flowDeleted"));
      if (editing === flow.id) setEditing(null);
      await loadFlows(accountId);
    } catch (err) {
      pushToast("err", err instanceof Error ? err.message : t("igAutomation.flowDeleteFailed"));
    }
  };

  const saveMenu = async () => {
    if (!accountId) return;
    try {
      await api.setMessengerProfile(accountId, {
        persistentMenu: {
          items: menuItems
            .filter((item) => item.title.trim().length > 0)
            .map((item) => (item.type === "web_url"
              ? { type: "web_url", title: item.title.trim(), url: (item.url ?? "").trim() }
              : { type: "postback", title: item.title.trim(), payload: (item.payload ?? "").trim() })),
        },
      });
      pushToast("ok", t("igAutomation.menuSaved"));
      await loadProfile(accountId);
    } catch (err) {
      pushToast("err", err instanceof Error ? err.message : t("igAutomation.profileSaveFailed"));
    }
  };

  const saveIceBreakers = async () => {
    if (!accountId) return;
    try {
      await api.setMessengerProfile(accountId, {
        iceBreakers: iceBreakers
          .filter((b) => b.question.trim().length > 0 && b.payload.trim().length > 0)
          .map((b) => ({ question: b.question.trim(), payload: b.payload.trim() })),
      });
      pushToast("ok", t("igAutomation.iceBreakersSaved"));
      await loadProfile(accountId);
    } catch (err) {
      pushToast("err", err instanceof Error ? err.message : t("igAutomation.profileSaveFailed"));
    }
  };

  const clearProfileFields = async (fields: string[]) => {
    if (!accountId) return;
    if (!window.confirm(t("igAutomation.profileDeleteConfirm"))) return;
    try {
      await api.deleteMessengerProfileFields(accountId, fields);
      pushToast("ok", t("igAutomation.profileDeleted"));
      await loadProfile(accountId);
    } catch (err) {
      pushToast("err", err instanceof Error ? err.message : t("igAutomation.profileDeleteFailed"));
    }
  };

  if (automationAccounts.length === 0) return null;

  return (
    <div className={`mt-6 ${cardCls}`}>
      <div className="font-medium text-sm">{t("igAutomation.title")}</div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("igAutomation.hint")}</p>

      <div className="mt-3 max-w-sm">
        <label className={labelCls}>{t("igAutomation.account")}</label>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls}>
          <option value="">-</option>
          {automationAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {(a.displayName ?? a.externalId) + ` · ${a.channel}`}
            </option>
          ))}
        </select>
      </div>

      {!accountId && (
        <div className="mt-3 text-sm text-slate-500 dark:text-slate-400">{t("igAutomation.pickAccount")}</div>
      )}

      {accountId && (
        <>
          {/* ------------------------------------------------ welcome flows */}
          <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-700">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium">{t("igAutomation.flowsTitle")}</div>
              {isInstagram && (
                <button onClick={openNewFlow} className={`ml-auto ${subtleBtn}`}>
                  {t("igAutomation.flowNew")}
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("igAutomation.flowsHint")}</p>

            {!isInstagram ? (
              <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t("igAutomation.flowsInstagramOnly")}</div>
            ) : flowsBusy ? (
              <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t("common.loading")}</div>
            ) : flowsError ? (
              <div className="mt-2 text-sm text-red-600 dark:text-red-400">{flowsError}</div>
            ) : flows.length === 0 ? (
              <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t("igAutomation.flowsEmpty")}</div>
            ) : (
              <div className="mt-3 space-y-2">
                {flows.map((flow) => {
                  const preview = readFirstMessage(flow.flow).text;
                  return (
                    <div key={flow.id} className="rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{flow.name}</span>
                        {flow.isUsedInAd && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                            {t("igAutomation.flowInAd")}
                          </span>
                        )}
                        <span className="ml-auto flex items-center gap-2">
                          <button onClick={() => void openEditFlow(flow)} className={linkBtn}>{t("common.edit")}</button>
                          <button onClick={() => void deleteFlow(flow)} className={dangerBtn}>{t("igAutomation.flowDelete")}</button>
                        </span>
                      </div>
                      {preview && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{preview}</p>}
                    </div>
                  );
                })}
              </div>
            )}

            {editing && isInstagram && (
              <div className="mt-4 rounded-md border border-slate-200 p-3 dark:border-slate-700">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {editing === "new" ? t("igAutomation.flowNewTitle") : t("igAutomation.flowEditTitle")}
                </div>
                <div className="mt-2 space-y-2">
                  <div>
                    <label className={labelCls}>{t("igAutomation.flowName")}</label>
                    <input value={flowName} onChange={(e) => setFlowName(e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>{t("igAutomation.flowText")}</label>
                    <textarea
                      value={flowText}
                      onChange={(e) => setFlowText(e.target.value)}
                      rows={3}
                      maxLength={640}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>{t("igAutomation.flowQuickReplies")}</label>
                    {flowReplies.map((reply, index) => (
                      <div key={index} className="mb-2 flex flex-wrap items-center gap-2">
                        <input
                          value={reply.title}
                          onChange={(e) => setFlowReplies((prev) => prev.map((r, i) => (i === index ? { ...r, title: e.target.value } : r)))}
                          maxLength={20}
                          placeholder={t("igAutomation.flowReplyTitle")}
                          className={`${inputCls} max-w-[12rem]`}
                        />
                        <input
                          value={reply.payload}
                          onChange={(e) => setFlowReplies((prev) => prev.map((r, i) => (i === index ? { ...r, payload: e.target.value } : r)))}
                          placeholder={t("igAutomation.flowReplyPayload")}
                          className={`${inputCls} max-w-[14rem]`}
                        />
                        <button
                          onClick={() => setFlowReplies((prev) => prev.filter((_, i) => i !== index))}
                          className={dangerBtn}
                        >
                          {t("templateParams.remove")}
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => setFlowReplies((prev) => [...prev, { title: "", payload: "" }])}
                      className={linkBtn}
                    >
                      {t("igAutomation.flowAddReply")}
                    </button>
                  </div>
                  {preserved.length > 0 && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {t("igAutomation.flowPreserved", { count: String(preserved.length) })}
                    </p>
                  )}
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => void saveFlow()}
                    disabled={saving || !flowName.trim() || !flowText.trim()}
                    className={primaryBtn}
                  >
                    {saving ? t("common.saving") : t("common.save")}
                  </button>
                  <button onClick={() => setEditing(null)} className={subtleBtn}>{t("common.cancel")}</button>
                </div>
              </div>
            )}
          </div>

          {/* -------------------------------------------- messaging profile */}
          <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-700">
            <div className="text-sm font-medium">{t("igAutomation.profileTitle")}</div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("igAutomation.profileHint")}</p>
            {profileBusy ? (
              <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t("common.loading")}</div>
            ) : profileError ? (
              <div className="mt-2 text-sm text-red-600 dark:text-red-400">{profileError}</div>
            ) : (
              <>
                <div className="mt-3">
                  <label className={labelCls}>{t("igAutomation.menuTitle")}</label>
                  {menuItems.map((item, index) => (
                    <div key={index} className="mb-2 flex flex-wrap items-center gap-2">
                      <select
                        value={item.type}
                        onChange={(e) => setMenuItems((prev) => prev.map((m, i) => (i === index ? { ...m, type: e.target.value as PersistentMenuItem["type"] } : m)))}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      >
                        <option value="postback">postback</option>
                        <option value="web_url">web_url</option>
                      </select>
                      <input
                        value={item.title}
                        onChange={(e) => setMenuItems((prev) => prev.map((m, i) => (i === index ? { ...m, title: e.target.value } : m)))}
                        maxLength={30}
                        placeholder={t("igAutomation.menuItemTitle")}
                        className={`${inputCls} max-w-[12rem]`}
                      />
                      {item.type === "web_url" ? (
                        <input
                          value={item.url ?? ""}
                          onChange={(e) => setMenuItems((prev) => prev.map((m, i) => (i === index ? { ...m, url: e.target.value } : m)))}
                          placeholder="https://example.com"
                          className={`${inputCls} max-w-[16rem]`}
                        />
                      ) : (
                        <input
                          value={item.payload ?? ""}
                          onChange={(e) => setMenuItems((prev) => prev.map((m, i) => (i === index ? { ...m, payload: e.target.value } : m)))}
                          placeholder={t("igAutomation.menuItemPayload")}
                          className={`${inputCls} max-w-[14rem]`}
                        />
                      )}
                      <button onClick={() => setMenuItems((prev) => prev.filter((_, i) => i !== index))} className={dangerBtn}>
                        {t("templateParams.remove")}
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setMenuItems((prev) => [...prev, { type: "postback", title: "", payload: "" }])}
                    disabled={menuItems.length >= 3}
                    className={linkBtn}
                  >
                    {t("igAutomation.menuAddItem")}
                  </button>
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => void saveMenu()} disabled={menuItems.length === 0} className={primaryBtn}>
                      {t("igAutomation.menuSave")}
                    </button>
                    <button onClick={() => void clearProfileFields(["persistent_menu"])} className={subtleBtn}>
                      {t("igAutomation.menuDelete")}
                    </button>
                  </div>
                </div>

                <div className="mt-4">
                  <label className={labelCls}>{t("igAutomation.iceTitle")}</label>
                  {iceBreakers.map((breaker, index) => (
                    <div key={index} className="mb-2 flex flex-wrap items-center gap-2">
                      <input
                        value={breaker.question}
                        onChange={(e) => setIceBreakers((prev) => prev.map((b, i) => (i === index ? { ...b, question: e.target.value } : b)))}
                        maxLength={80}
                        placeholder={t("igAutomation.iceQuestion")}
                        className={`${inputCls} max-w-[18rem]`}
                      />
                      <input
                        value={breaker.payload}
                        onChange={(e) => setIceBreakers((prev) => prev.map((b, i) => (i === index ? { ...b, payload: e.target.value } : b)))}
                        placeholder={t("igAutomation.icePayload")}
                        className={`${inputCls} max-w-[14rem]`}
                      />
                      <button onClick={() => setIceBreakers((prev) => prev.filter((_, i) => i !== index))} className={dangerBtn}>
                        {t("templateParams.remove")}
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setIceBreakers((prev) => [...prev, { question: "", payload: "" }])}
                    disabled={iceBreakers.length >= 4}
                    className={linkBtn}
                  >
                    {t("igAutomation.iceAdd")}
                  </button>
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => void saveIceBreakers()} disabled={iceBreakers.length === 0} className={primaryBtn}>
                      {t("igAutomation.iceSave")}
                    </button>
                    <button onClick={() => void clearProfileFields(["ice_breakers"])} className={subtleBtn}>
                      {t("igAutomation.iceDelete")}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
