/**
 * Errors carry a reason code, never the input. A verifier, ticket or code must
 * not reach a log line through an error message.
 */
export class MobileAuthError extends Error {
  constructor(readonly reason: string) {
    super(`mobile-auth: ${reason}`);
    this.name = "MobileAuthError";
  }
}
