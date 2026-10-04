/**
 * The Expo adapter for `CryptoPort`, a separate entry point
 * (`@stonedogcode/mobile-auth/expo`) so the core never imports Expo and stays
 * testable in Node.
 */
import { CryptoDigestAlgorithm, digest, getRandomBytes } from "expo-crypto";
import type { CryptoPort } from "./crypto-port.js";

export const expoCrypto: CryptoPort = {
  randomBytes: (length) => getRandomBytes(length),
  sha256: async (data) =>
    new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, data as Uint8Array<ArrayBuffer>)),
};
