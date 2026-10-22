import { describe, expect, test } from "bun:test";
import { en } from "./en";
import { id } from "./id";

/**
 * Dictionary parity guard: EN and ID must expose exactly the same key set,
 * and no value may be empty. (The Dictionary type already enforces parity
 * at compile time; this test catches runtime drift too.)
 */
describe("i18n dictionaries", () => {
  test("en and id have identical key sets", () => {
    const enKeys = Object.keys(en).sort();
    const idKeys = Object.keys(id).sort();
    expect(idKeys).toEqual(enKeys);
  });

  test("no empty translations", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en:${key}`).toBeTruthy();
    }
    for (const [key, value] of Object.entries(id)) {
      expect(value, `id:${key}`).toBeTruthy();
    }
  });
});
