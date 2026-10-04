import { createHash, randomBytes } from "node:crypto";
import type { CryptoPort } from "../crypto-port.js";

/** A real CryptoPort for tests, backed by node:crypto. */
export const nodeCrypto: CryptoPort = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  sha256: async (data) => new Uint8Array(createHash("sha256").update(data).digest()),
};
