import { describe, expect, test } from "bun:test";
import type { SavedReply } from "./api";
import { filterSavedReplies } from "./saved-replies";
import { insertPlainText } from "./variables";

/**
 * Saved-replies picker model (package #2): "/"-prefixed queries hit
 * shortcuts by prefix first; other queries substring-match title, body,
 * and shortcut in title order. Insertion reuses the composer's plain
 * caret math (insertPlainText) - pinned here because the picker inserts
 * raw bodies, not {{tokens}}.
 */

const reply = (partial: Partial<SavedReply>): SavedReply => ({
  id: partial.id ?? crypto.randomUUID(),
  title: partial.title ?? "Tanpa judul",
  body: partial.body ?? "",
  shortcut: partial.shortcut ?? null,
  createdBy: "user-1",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
});

const library: SavedReply[] = [
  reply({ title: "Info harga", body: "Daftar harga ada di katalog, Kak.", shortcut: "/harga" }),
  reply({ title: "Salam pembuka", body: "Halo {{contact.name}}!", shortcut: "/halo" }),
  reply({ title: "Tutup toko", body: "Toko tutup pukul 21.00.", shortcut: null }),
];

describe("filterSavedReplies", () => {
  test("empty query returns the library untouched", () => {
    expect(filterSavedReplies(library, "  ")).toEqual(library);
  });

  test("a /-query matches shortcuts by prefix, ahead of text matches", () => {
    const out = filterSavedReplies(library, "/ha");
    expect(out.map((r) => r.title)).toEqual(["Info harga", "Salam pembuka"]);
    // Both start with /ha; title order (API order) is preserved.
    expect(out[0]!.shortcut).toBe("/harga");
  });

  test("a /-query with no shortcut prefix hit falls back to substring matches", () => {
    const out = filterSavedReplies(library, "/tutup");
    expect(out.map((r) => r.title)).toEqual(["Tutup toko"]);
  });

  test("plain queries substring-match title, body, and shortcut case-insensitively", () => {
    expect(filterSavedReplies(library, "KATALOG").map((r) => r.title)).toEqual(["Info harga"]);
    expect(filterSavedReplies(library, "salam").map((r) => r.title)).toEqual(["Salam pembuka"]);
    expect(filterSavedReplies(library, "halo").map((r) => r.title)).toEqual(["Salam pembuka"]);
    expect(filterSavedReplies(library, "tidak-ada")).toEqual([]);
  });
});

describe("insertPlainText (saved-reply insertion math)", () => {
  test("inserts the body at the caret without wrapping it in braces", () => {
    const r = insertPlainText("Halo, ", "Halo {{contact.name}}!", 6, 6);
    expect(r.text).toBe("Halo, Halo {{contact.name}}!");
    expect(r.caret).toBe(6 + "Halo {{contact.name}}!".length);
  });

  test("replaces the selection and appends when the selection is null", () => {
    expect(insertPlainText("teks lama", "baru", 5, 9).text).toBe("teks baru");
    expect(insertPlainText("awal ", "akhir", null, null).text).toBe("awal akhir");
  });
});
