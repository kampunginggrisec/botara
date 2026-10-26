import { describe, expect, test } from "bun:test";
import { dismissToast, getToasts, pushToast, subscribeToasts } from "./toast";

describe("toast store", () => {
  test("push adds a toast, notifies subscribers, dismiss removes it", () => {
    let notifications = 0;
    const unsubscribe = subscribeToasts(() => {
      notifications++;
    });
    const id = pushToast("ok", "threads connected successfully.");
    expect(getToasts().some((item) => item.id === id && item.kind === "ok" && item.text.includes("threads"))).toBe(true);
    expect(notifications).toBeGreaterThan(0);
    dismissToast(id);
    expect(getToasts().some((item) => item.id === id)).toBe(false);
    unsubscribe();
  });

  test("error toasts carry the err kind", () => {
    const id = pushToast("err", "Connect failed: invalid state.");
    const item = getToasts().find((entry) => entry.id === id);
    expect(item?.kind).toBe("err");
    dismissToast(id);
  });
});
