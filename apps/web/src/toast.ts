/**
 * Minimal toast store for transient success/failure alerts (module-level
 * state + subscribers, consumed via useSyncExternalStore). Producers call
 * pushToast from anywhere; the <Toasts /> overlay renders the stack.
 */
export type ToastKind = "ok" | "err";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

export const TOAST_AUTO_DISMISS_MS = 6000;

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function pushToast(kind: ToastKind, text: string): number {
  const id = ++seq;
  items = [...items, { id, kind, text }];
  emit();
  setTimeout(() => dismissToast(id), TOAST_AUTO_DISMISS_MS);
  return id;
}

export function dismissToast(id: number): void {
  const next = items.filter((item) => item.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

export function getToasts(): ToastItem[] {
  return items;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
