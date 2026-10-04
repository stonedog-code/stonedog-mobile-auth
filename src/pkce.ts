/**
 * PKCE (RFC 7636) for the phone side, S256 only.
 *
 * The phone that starts a cross-device link keeps the verifier and sends only
 * the challenge. Redeeming the link later needs the verifier, so a ticket that
 * was photographed, relayed or intercepted is useless to anyone but the phone
 * that claimed it. The server half is `verifyPkceS256` in `@stonedogcode/auth`.
 *
 * `plain` is deliberately not offered: with `plain` the challenge IS the
 * verifier, which defeats the purpose.
 */
import { base64url } from "./base64url.js";
import type { CryptoPort } from "./crypto-port.js";
import { MobileAuthError } from "./errors.js";

/** 32 random bytes encode to exactly 43 base64url characters, RFC 7636's minimum. */
export const VERIFIER_BYTES = 32;

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface PkcePair {
  /** Keep on the phone. Never send it until the redeem step. */
  verifier: string;
  /** Send with the claim. */
  challenge: string;
  method: "S256";
}

export async function pkceChallengeS256(verifier: string, crypto: CryptoPort): Promise<string> {
  if (!VERIFIER.test(verifier)) throw new MobileAuthError("invalid_verifier");
  // The verifier is ASCII by construction (checked above), so its bytes are its
  // char codes. No TextEncoder: not every React Native runtime provides one.
  const bytes = new Uint8Array(verifier.length);
  for (let i = 0; i < verifier.length; i++) bytes[i] = verifier.charCodeAt(i);
  const digest = await crypto.sha256(bytes);
  if (digest.length !== 32) throw new MobileAuthError("bad_digest");
  return base64url(digest);
}

export async function createPkcePair(crypto: CryptoPort): Promise<PkcePair> {
  const bytes = crypto.randomBytes(VERIFIER_BYTES);
  // A port that returns the wrong length, or a stub that returns zeros, would
  // produce a guessable verifier and still "work". Refuse rather than proceed.
  if (bytes.length !== VERIFIER_BYTES) throw new MobileAuthError("bad_random_length");
  if (bytes.every((b) => b === 0)) throw new MobileAuthError("random_source_returned_zeros");
  const verifier = base64url(bytes);
  return { verifier, challenge: await pkceChallengeS256(verifier, crypto), method: "S256" };
}
