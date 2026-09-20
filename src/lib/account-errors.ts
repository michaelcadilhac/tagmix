// Server pages and API routes can bundle separate copies of this class while
// sharing the same account store. A global symbol keeps recognition consistent.
const ACCOUNT_ERROR = Symbol.for("tagmix:account-error");

export class AccountError extends Error {
  readonly [ACCOUNT_ERROR] = true;

  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "AccountError";
  }
}

export function isAccountError(error: unknown): error is AccountError {
  return typeof error === "object" && error !== null
    && ACCOUNT_ERROR in error && error[ACCOUNT_ERROR] === true
    && "message" in error && typeof error.message === "string"
    && "status" in error && typeof error.status === "number";
}
