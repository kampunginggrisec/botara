import { money, type Money } from "@botara/shared";

/** One row of the cost ledger (mirrors packages/db cost_ledger). */
export interface CostLedgerEntry {
  workspaceId: string;
  channelAccountId?: string;
  channel: string;
  category: string;
  country?: string;
  units: number;
  amount: Money;
  referenceId?: string;
  createdAt: Date;
}

export type WhatsAppCategory = "marketing" | "utility" | "authentication" | "service";

/**
 * SAMPLE per-delivered-message rates (USD) for the estimator stub.
 * Real rates come from Meta's per-country rate card and change quarterly -
 * Fase 1 loads them from a versioned rates table, never from code.
 */
export const WHATSAPP_SAMPLE_RATES: Record<string, Partial<Record<WhatsAppCategory, number>>> = {
  ID: { marketing: 0.0416, utility: 0.0125, authentication: 0.0125, service: 0.0125 },
  US: { marketing: 0.025, utility: 0.0034, authentication: 0.0034, service: 0.0034 },
  IN: { marketing: 0.0118, utility: 0.0014, authentication: 0.0014, service: 0.0014 },
};

/** Free service messages per business phone number per month (since 2026-10-01 model). */
export const WHATSAPP_FREE_SERVICE_PER_MONTH = 1000;

export interface WhatsAppEstimateInput {
  country: string;
  messages: Partial<Record<WhatsAppCategory, number>>;
  /** Service messages already sent this month for this number (allowance consumption). */
  serviceMessagesAlreadySentThisMonth?: number;
}

export interface WhatsAppEstimate {
  country: string;
  billableByCategory: Partial<Record<WhatsAppCategory, number>>;
  freeServiceApplied: number;
  totalUsd: number;
  total: Money;
}

/**
 * WhatsApp cost estimator, post-2026-10-01 model:
 * - pricing is per DELIVERED message, rated by category + recipient country
 * - service messages are billed at the service (= utility) rate, except the
 *   first 1,000 per phone number per month, which are free
 * - incoming messages are free; the 72h free entry-point window is a Fase 1 refinement
 */
export function estimateWhatsAppCost(input: WhatsAppEstimateInput): WhatsAppEstimate {
  const rates = WHATSAPP_SAMPLE_RATES[input.country.toUpperCase()] ?? {};
  const already = input.serviceMessagesAlreadySentThisMonth ?? 0;
  const freeRemaining = Math.max(0, WHATSAPP_FREE_SERVICE_PER_MONTH - already);

  const billable: Partial<Record<WhatsAppCategory, number>> = {};
  let freeServiceApplied = 0;
  let totalUsd = 0;

  for (const [cat, count] of Object.entries(input.messages) as Array<[WhatsAppCategory, number]>) {
    let n = count;
    if (cat === "service") {
      freeServiceApplied = Math.min(n, freeRemaining);
      n -= freeServiceApplied;
    }
    billable[cat] = n;
    totalUsd += n * (rates[cat] ?? 0);
  }

  const rounded = Math.round(totalUsd * 1_000_000) / 1_000_000;
  return {
    country: input.country.toUpperCase(),
    billableByCategory: billable,
    freeServiceApplied,
    totalUsd: rounded,
    total: money(Math.round(rounded * 100), "USD"),
  };
}
