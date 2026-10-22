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

/** A versioned WhatsApp rate card: per-delivered-message USD rates by country + category. */
export interface WhatsAppRatesTable {
  /** Bumped whenever rates are replaced; stamped onto every estimate + ledger row. */
  version: string;
  /** Date this card takes effect (ISO date). */
  effectiveDate: string;
  currency: "USD";
  /** SAMPLE values pending the live Meta rate card - see `note`. */
  note: string;
  rates: Record<string, Partial<Record<WhatsAppCategory, number>>>;
}

/**
 * Current rate card (Fase 1). Values are still SAMPLE numbers in the shape of
 * Meta's published card - they exist so estimates/ledger math is real and
 * testable; ops replaces this table (and bumps `version`) when the live
 * per-country rate card is loaded. Rates change quarterly upstream.
 */
export const WHATSAPP_RATES_TABLE: WhatsAppRatesTable = {
  version: "sample-2026-q4",
  effectiveDate: "2026-10-01",
  currency: "USD",
  note: "SAMPLE rates pending the live Meta rate card; structure and math are production-shaped.",
  rates: {
    ID: { marketing: 0.0416, utility: 0.0125, authentication: 0.0125, service: 0.0125 },
    US: { marketing: 0.025, utility: 0.0034, authentication: 0.0034, service: 0.0034 },
    IN: { marketing: 0.0118, utility: 0.0014, authentication: 0.0014, service: 0.0014 },
    BR: { marketing: 0.0625, utility: 0.0068, authentication: 0.0068, service: 0.0068 },
    MX: { marketing: 0.0397, utility: 0.0085, authentication: 0.0085, service: 0.0085 },
    GB: { marketing: 0.0523, utility: 0.0167, authentication: 0.0167, service: 0.0167 },
    AU: { marketing: 0.0389, utility: 0.0089, authentication: 0.0089, service: 0.0089 },
    SG: { marketing: 0.0393, utility: 0.0148, authentication: 0.0148, service: 0.0148 },
  },
};

/** Backwards-compatible alias (Fase 0 name). */
export const WHATSAPP_SAMPLE_RATES = WHATSAPP_RATES_TABLE.rates;

export const WHATSAPP_RATES_VERSION = WHATSAPP_RATES_TABLE.version;

/** Rate for one delivered message, or undefined when the country is not on the card. */
export function getWhatsAppRate(
  country: string,
  category: WhatsAppCategory,
  table: WhatsAppRatesTable = WHATSAPP_RATES_TABLE,
): number | undefined {
  return table.rates[country.toUpperCase()]?.[category];
}

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
  /** Rate card the numbers came from - always stamped so reports are auditable. */
  ratesVersion: string;
  ratesEffectiveDate: string;
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
    ratesVersion: WHATSAPP_RATES_TABLE.version,
    ratesEffectiveDate: WHATSAPP_RATES_TABLE.effectiveDate,
  };
}

/** Per-country slice of a broadcast estimate (country mix support). */
export interface BroadcastEstimateLine {
  country: string;
  category: WhatsAppCategory;
  recipients: number;
  billable: number;
  freeServiceApplied: number;
  rateUsd: number;
  subtotalUsd: number;
}

export interface BroadcastEstimate {
  lines: BroadcastEstimateLine[];
  totalRecipients: number;
  totalUsd: number;
  ratesVersion: string;
  ratesEffectiveDate: string;
}

/**
 * Broadcast estimator: one template category fanned out over a country mix.
 * The 1,000 free monthly service allowance applies per phone number, so the
 * caller passes how much of it this broadcast's number has already consumed.
 */
export function estimateBroadcastCost(input: {
  category: WhatsAppCategory;
  countryMix: Array<{ country: string; recipients: number }>;
  serviceMessagesAlreadySentThisMonth?: number;
}): BroadcastEstimate {
  const lines: BroadcastEstimateLine[] = [];
  let serviceAlready = input.serviceMessagesAlreadySentThisMonth ?? 0;
  let totalUsd = 0;
  let totalRecipients = 0;

  for (const slice of input.countryMix) {
    const est = estimateWhatsAppCost({
      country: slice.country,
      messages: { [input.category]: slice.recipients },
      serviceMessagesAlreadySentThisMonth: serviceAlready,
    });
    // Allowance is consumed across slices (single sending number per broadcast).
    serviceAlready += input.category === "service" ? slice.recipients : 0;
    const billable = est.billableByCategory[input.category] ?? 0;
    const subtotal = billable * (getWhatsAppRate(slice.country, input.category) ?? 0);
    lines.push({
      country: est.country,
      category: input.category,
      recipients: slice.recipients,
      billable,
      freeServiceApplied: est.freeServiceApplied,
      rateUsd: getWhatsAppRate(slice.country, input.category) ?? 0,
      subtotalUsd: Math.round(subtotal * 1_000_000) / 1_000_000,
    });
    totalUsd += subtotal;
    totalRecipients += slice.recipients;
  }

  return {
    lines,
    totalRecipients,
    totalUsd: Math.round(totalUsd * 1_000_000) / 1_000_000,
    ratesVersion: WHATSAPP_RATES_TABLE.version,
    ratesEffectiveDate: WHATSAPP_RATES_TABLE.effectiveDate,
  };
}
