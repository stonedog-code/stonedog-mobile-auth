/**
 * The two cryptographic operations this package needs, supplied by the caller.
 *
 * A port rather than a direct import so the logic is testable in Node and the
 * package never decides which crypto implementation an app runs. In an Expo app
 * use `expoCrypto` from `@stonedogcode/mobile-auth/expo`.
 */
export interface CryptoPort {
  /** Cryptographically secure random bytes. Never `Math.random`. */
  randomBytes(length: number): Uint8Array;
  /** SHA-256 of `data`. */
  sha256(data: Uint8Array): Promise<Uint8Array>;
}
