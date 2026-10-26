import { useCallback, useEffect, useState } from "react";
import { api, type SavedReply } from "./api";
import { useI18n } from "./i18n";
import { filterSavedReplies } from "./saved-replies";
import { pushToast } from "./toast";
import { insertTextIntoElement } from "./variables";

/**
 * Saved-replies picker (package #2): a "Saved replies" button in the
 * inbox composer opening a searchable popover of the workspace library.
 * Clicking an entry inserts its body at the composer caret (the body is
 * a draft - {{variables}} inside it render through the normal reply
 * path when the agent sends). Management lives in the same popover:
 * New / Edit / Delete with a small inline form, so the library is
 * maintained where it is used and no separate page exists.
 */
export function SavedRepliesPicker({
  target,
}: {
  /** Resolves the composer field to insert into. */
  target: () => HTMLTextAreaElement | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<SavedReply[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  // null = list view; "new" or a reply id = the form is showing.
  const [editing, setEditing] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formShortcut, setFormShortcut] = useState("");
  const [formBody, setFormBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.listSavedReplies();
      setReplies(data.savedReplies);
      setError(null);
    } catch {
      setError(t("savedReplies.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const pick = (reply: SavedReply) => {
    const el = target();
    if (el) insertTextIntoElement(el, reply.body);
    setOpen(false);
  };

  const startNew = () => {
    setEditing("new");
    setFormTitle("");
    setFormShortcut("");
    setFormBody("");
  };

  const startEdit = (reply: SavedReply) => {
    setEditing(reply.id);
    setFormTitle(reply.title);
    setFormShortcut(reply.shortcut ?? "");
    setFormBody(reply.body);
  };

  const save = async () => {
    if (!formTitle.trim() || !formBody.trim()) return;
    setSaving(true);
    try {
      const payload = {
        title: formTitle.trim(),
        body: formBody.trim(),
        shortcut: formShortcut.trim() ? formShortcut.trim() : null,
      };
      if (editing === "new") await api.createSavedReply(payload);
      else if (editing) await api.updateSavedReply(editing, payload);
      setEditing(null);
      await load();
    } catch (err) {
      pushToast("err", err instanceof Error ? err.message : t("savedReplies.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (reply: SavedReply) => {
    if (!window.confirm(t("savedReplies.deleteConfirm", { title: reply.title }))) return;
    try {
      await api.deleteSavedReply(reply.id);
      await load();
    } catch (err) {
      pushToast("err", err instanceof Error ? err.message : t("savedReplies.deleteFailed"));
    }
  };

  const filtered = filterSavedReplies(replies, query);
  const inputCls = "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";
  const smallBtn = "rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200";

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setEditing(null); }}
        className={smallBtn}
      >
        {t("savedReplies.button")}
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-96 max-w-[90vw] rounded-md border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {editing === null ? (
            <>
              <div className="flex gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("savedReplies.searchPlaceholder")}
                  className={inputCls}
                />
                <button type="button" onClick={startNew} className={`${smallBtn} whitespace-nowrap`}>
                  {t("savedReplies.new")}
                </button>
              </div>
              {error && <p className="px-1 pt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
              <div className="mt-1 max-h-64 overflow-auto">
                {filtered.length === 0 && !error && (
                  <p className="px-1 py-2 text-xs text-slate-400">{t("savedReplies.empty")}</p>
                )}
                {filtered.map((reply) => (
                  <div
                    key={reply.id}
                    className="group flex items-start gap-2 rounded px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <button
                      type="button"
                      onClick={() => pick(reply)}
                      className="min-w-0 flex-1 text-left"
                      title={t("savedReplies.insertHint")}
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium text-slate-800 dark:text-slate-100">{reply.title}</span>
                        {reply.shortcut && (
                          <code className="rounded bg-slate-100 px-1 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            {reply.shortcut}
                          </code>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-slate-400">{reply.body}</span>
                    </button>
                    <span className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(reply)}
                        className="text-[11px] text-slate-500 underline dark:text-slate-400"
                      >
                        {t("common.edit")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(reply)}
                        className="text-[11px] text-red-600 underline dark:text-red-400"
                      >
                        {t("common.remove")}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              <p className="border-t border-slate-100 px-1 pt-1.5 text-[10px] text-slate-400 dark:border-slate-800">
                {t("savedReplies.hint")}
              </p>
            </>
          ) : (
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-200">
                {editing === "new" ? t("savedReplies.new") : t("savedReplies.edit")}
              </div>
              <input
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder={t("savedReplies.titlePlaceholder")}
                className={inputCls}
              />
              <input
                value={formShortcut}
                onChange={(e) => setFormShortcut(e.target.value)}
                placeholder={t("savedReplies.shortcutPlaceholder")}
                className={inputCls}
              />
              <textarea
                value={formBody}
                onChange={(e) => setFormBody(e.target.value)}
                placeholder={t("savedReplies.bodyPlaceholder")}
                rows={4}
                className={inputCls}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || !formTitle.trim() || !formBody.trim()}
                  className={`${smallBtn} disabled:opacity-50`}
                >
                  {saving ? t("common.saving") : t("common.save")}
                </button>
                <button type="button" onClick={() => setEditing(null)} className={smallBtn}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
