/** Money is handled in integer minor units (cents) to avoid float drift. */
export interface Money {
  amountMinor: number;
  currency: string; // ISO 4217, e.g. "USD"
}

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor)) throw new Error("amountMinor must be an integer");
  return { amountMinor, currency: currency.toUpperCase() };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

/** USD decimal amount -> integer cents, rounded half-up. */
export function usdToCents(amount: number): number {
  return Math.round(amount * 100);
}

export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

/** Messaging-window check used by channel send paths (e.g. Meta's 24h window). */
export function isWithinWindow(lastUserMessageAt: Date | null, now: Date, windowHours: number): boolean {
  if (!lastUserMessageAt) return false;
  return now.getTime() - lastUserMessageAt.getTime() <= windowHours * 3_600_000;
}
