/** Standard error taxonomy for the whole platform. */
export const ERROR_CODES = [
  "NOT_IMPLEMENTED",
  "VALIDATION",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "TOKEN_EXPIRED",
  "MESSAGING_WINDOW_CLOSED",
  "CONFIGURATION",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = options?.status ?? defaultStatusFor(code);
    this.details = options?.details;
  }
}

function defaultStatusFor(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION": return 400;
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN": return 403;
    case "NOT_FOUND": return 404;
    case "CONFLICT": return 409;
    case "RATE_LIMITED": return 429;
    case "NOT_IMPLEMENTED": return 501;
    default: return 500;
  }
}

export class NotImplementedError extends AppError {
  constructor(what: string) {
    super("NOT_IMPLEMENTED", `${what} is not implemented yet (Fase 0 stub)`);
    this.name = "NotImplementedError";
  }
}
