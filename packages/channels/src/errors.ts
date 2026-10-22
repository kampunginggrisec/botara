import { AppError, type ErrorCode } from "@botara/shared";

/**
 * Typed provider errors. Everything an adapter throws is an AppError from
 * the shared taxonomy, enriched with the provider's own code + fbtrace_id
 * so operators can quote them to Meta support verbatim.
 */

export interface ProviderErrorDetails {
  provider: string;
  providerCode?: number;
  providerSubcode?: number;
  fbtraceId?: string;
  /** true when the caller may retry the same request (rate limits, 5xx). */
  retryable: boolean;
}

export class ProviderApiError extends AppError {
  declare readonly details: ProviderErrorDetails;

  constructor(
    message: string,
    details: ProviderErrorDetails,
    options?: { code?: ErrorCode; status?: number },
  ) {
    super(options?.code ?? "PROVIDER_ERROR", message, {
      status: options?.status ?? 502,
      details,
    });
    this.name = "ProviderApiError";
  }

  get retryable(): boolean {
    return this.details.retryable;
  }
  get fbtraceId(): string | undefined {
    return this.details.fbtraceId;
  }
}

/** HTTP 190 / OAuthException family: the token is dead. Never retry; re-auth. */
export class ProviderAuthError extends ProviderApiError {
  constructor(message: string, details: ProviderErrorDetails) {
    super(message, { ...details, retryable: false }, { code: "TOKEN_EXPIRED", status: 401 });
    this.name = "ProviderAuthError";
  }
}

/** 130429 / 80007 / (#4): throughput or app-level rate limit. Safe to retry with backoff. */
export class ProviderRateLimitError extends ProviderApiError {
  constructor(message: string, details: ProviderErrorDetails) {
    super(message, { ...details, retryable: true }, { code: "RATE_LIMITED", status: 429 });
    this.name = "ProviderRateLimitError";
  }
}

/**
 * WhatsApp 131063: a marketing template was sent to /messages after the
 * account/template moved to the Marketing Messages API (or vice versa).
 * Signals the caller to refresh the template's latest_category from Meta
 * and reroute the send. Carries the endpoint that was (wrongly) used.
 */
export class TemplateCategoryMismatchError extends ProviderApiError {
  readonly needsCategoryRefresh = true;
  readonly attemptedRoute: "messages" | "marketing_messages";

  constructor(
    message: string,
    details: ProviderErrorDetails & { attemptedRoute: "messages" | "marketing_messages" },
  ) {
    super(message, details, { code: "CONFLICT", status: 409 });
    this.name = "TemplateCategoryMismatchError";
    this.attemptedRoute = details.attemptedRoute;
  }
}

/** WhatsApp 131049: marketing to US recipients is paused by Meta (since 2025-04-01). */
export class MarketingPausedError extends ProviderApiError {
  constructor(message: string, details: ProviderErrorDetails) {
    super(message, { ...details, retryable: false }, { code: "FORBIDDEN", status: 403 });
    this.name = "MarketingPausedError";
  }
}

export interface GraphErrorBodyShape {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/**
 * Generic Graph API error mapper for the non-WhatsApp Meta surfaces
 * (Instagram via Facebook Login, Messenger). WhatsApp has extra codes and
 * its own mapper in whatsapp.ts; this one covers the shared family:
 * 190 -> auth (dead token), 4/17/32/613/80007 -> rate limit, 5xx -> retryable.
 */
export function mapGraphError(body: GraphErrorBodyShape, httpStatus: number, provider: string): ProviderApiError {
  const e = body.error ?? {};
  const details: ProviderErrorDetails = {
    provider,
    providerCode: e.code,
    providerSubcode: e.error_subcode,
    fbtraceId: e.fbtrace_id,
    retryable: httpStatus >= 500,
  };
  const message = e.message ?? `${provider} Graph API error (HTTP ${httpStatus})`;
  switch (e.code) {
    case 190:
      return new ProviderAuthError(message, details);
    case 4: // app-level rate limit
    case 17: // user request limit reached
    case 32: // page-level rate limit
    case 613: // calls too many
    case 80007: // account-level rate limit
      return new ProviderRateLimitError(message, details);
    default:
      return new ProviderApiError(message, details);
  }
}
