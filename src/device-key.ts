/**
 * The on-device key: a P-256 key that never leaves the phone, unlocked by the
 * fingerprint, answering the server's sign-in challenge.
 *
 * - The PRIVATE key is kept in a store that requires biometric authentication
 *   to read (`expo-secure-store` with `requireAuthentication`, which the Android
 *   Keystore enforces). It is never synced and never exported.
 * - The PUBLIC key is kept separately, without authentication, so the app can
 *   tell whether this phone is set up without prompting for a fingerprint.
 * - Signatures are ECDSA P-256 over SHA-256, DER-encoded, standard base64: the
 *   format `node:crypto`'s `createVerify("SHA256").verify(pem, sig, "base64")`
 *   accepts by default. The server verifies with the PEM returned at enrolment.
 *
 * Key generation takes its randomness ONLY from the caller's `CryptoPort`: the
 * seed is passed explicitly, so it never depends on `crypto.getRandomValues`,
 * which React Native does not reliably provide. Signing nonces are
 * deterministic (RFC 6979, no extra entropy). The curve library DOES use
 * `getRandomValues` for side-channel blinding during signing when the runtime
 * provides it, and falls back safely when it does not. Neither case changes
 * the signature's validity or its nonce.
 *
 * This entry point (`@stonedogcode/mobile-auth/device-key`) needs the optional
 * peer `@noble/curves`. The core entry does not.
 */
import { p256 } from "@noble/curves/nist.js";
import { base64 } from "./base64.js";
import type { CryptoPort } from "./crypto-port.js";
import { MobileAuthError } from "./errors.js";

/**
 * Where the key lives. `expoDeviceKeyStore` from
 * `@stonedogcode/mobile-auth/expo-device-key` implements it over
 * `expo-secure-store`. Implementations must THROW a `MobileAuthError` with one
 * of the reason codes below when authentication fails, never return null.
 */
export interface DeviceKeyStore {
  set(name: string, value: string, options: { requireAuthentication: boolean; prompt?: string }): Promise<void>;
  get(name: string, options: { requireAuthentication: boolean; prompt?: string }): Promise<string | null>;
  remove(name: string): Promise<void>;
}

/** Reason codes a store may throw, plus the ones this module raises. */
export type DeviceKeyReason =
  | "authentication_cancelled"
  | "authentication_failed"
  | "key_invalidated"
  | "key_missing"
  | "biometrics_unavailable"
  | "store_error"
  | "key_corrupt"
  | "invalid_challenge"
  | "invalid_key_name";

export interface DeviceKeyOptions {
  store: DeviceKeyStore;
  /** Key name, so one app can hold a key per account. Letters, digits, `.`, `-`, `_`. */
  name?: string;
}

const DEFAULT_NAME = "stonedog.device-key";
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
/** Server challenges are opaque ASCII tokens; refuse anything else. */
const CHALLENGE = /^[\x21-\x7e]{16,1024}$/;

// SubjectPublicKeyInfo header for an uncompressed P-256 point (RFC 5480).
const SPKI_P256_PREFIX = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

function names(options: DeviceKeyOptions): { priv: string; pub: string } {
  const base = options.name ?? DEFAULT_NAME;
  if (!NAME.test(base)) throw new MobileAuthError("invalid_key_name");
  return { priv: `${base}.private`, pub: `${base}.public` };
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** PEM-encoded SubjectPublicKeyInfo for an uncompressed P-256 public key. */
export function publicKeyToPem(uncompressed: Uint8Array): string {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) throw new MobileAuthError("key_corrupt");
  const der = new Uint8Array(SPKI_P256_PREFIX.length + 65);
  der.set(SPKI_P256_PREFIX, 0);
  der.set(uncompressed, SPKI_P256_PREFIX.length);
  const b64 = base64(der);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Create this phone's key, replacing any existing one under the same name.
 * Storing the private key behind authentication may itself prompt for the
 * fingerprint on some devices, so `prompt` is required.
 *
 * @returns the public key as PEM, for the app to register with its server.
 */
export async function createDeviceKey(
  options: DeviceKeyOptions & { crypto: CryptoPort; prompt: string },
): Promise<{ publicKeyPem: string }> {
  const { priv, pub } = names(options);
  const seed = options.crypto.randomBytes(p256.lengths.seed ?? 48);
  if (seed.length !== (p256.lengths.seed ?? 48)) throw new MobileAuthError("bad_random_length");
  if (seed.every((b) => b === 0)) throw new MobileAuthError("random_source_returned_zeros");

  // The seed fully determines the key, so it is zeroed with the key on every
  // path, including a cancelled or failed store. (The hex string handed to the
  // store cannot be zeroed; JavaScript strings are immutable.)
  const secretKey = p256.utils.randomSecretKey(seed);
  try {
    const publicKeyPem = publicKeyToPem(p256.getPublicKey(secretKey, false));
    // Private first: if it fails (cancelled, no biometrics), no public half is
    // left behind claiming a key exists.
    await options.store.set(priv, toHex(secretKey), { requireAuthentication: true, prompt: options.prompt });
    await options.store.set(pub, publicKeyPem, { requireAuthentication: false });
    return { publicKeyPem };
  } finally {
    secretKey.fill(0);
    seed.fill(0);
  }
}

/** The registered public key, or null if this phone has no key. Never prompts. */
export async function getDevicePublicKey(options: DeviceKeyOptions): Promise<string | null> {
  return options.store.get(names(options).pub, { requireAuthentication: false });
}

/**
 * Sign the server's challenge. Reading the private key prompts for the
 * fingerprint; a cancelled or failed prompt throws with its reason code.
 *
 * @returns the signature, DER-encoded, standard base64.
 */
export async function signDeviceChallenge(
  options: DeviceKeyOptions & { challenge: string; prompt: string },
): Promise<string> {
  if (!CHALLENGE.test(options.challenge)) throw new MobileAuthError("invalid_challenge");
  const { priv } = names(options);
  const stored = await options.store.get(priv, { requireAuthentication: true, prompt: options.prompt });
  if (stored === null) {
    // Android permanently invalidates a biometric-bound key when the set of
    // enrolled fingerprints changes, and expo-secure-store then returns null
    // rather than throwing. A surviving PUBLIC half is how that is told apart
    // from a phone that was never set up: the app should offer to set up again.
    const pub = await options.store.get(names(options).pub, { requireAuthentication: false });
    throw new MobileAuthError(pub === null ? "key_missing" : "key_invalidated");
  }
  const secretKey = fromHex(stored);
  if (secretKey === null || secretKey.length !== 32 || !p256.utils.isValidSecretKey(secretKey)) {
    throw new MobileAuthError("key_corrupt");
  }
  try {
    const sig = p256.sign(asciiBytes(options.challenge), secretKey, {
      prehash: true,
      lowS: true,
      extraEntropy: false,
      format: "der",
    });
    return base64(sig);
  } finally {
    secretKey.fill(0);
  }
}

/** Remove this phone's key, both halves. Safe to call when there is none. */
export async function removeDeviceKey(options: DeviceKeyOptions): Promise<void> {
  const { priv, pub } = names(options);
  await options.store.remove(pub);
  await options.store.remove(priv);
}
