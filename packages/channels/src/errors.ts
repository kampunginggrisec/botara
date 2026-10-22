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
