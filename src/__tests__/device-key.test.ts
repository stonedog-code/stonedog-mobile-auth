import { createPublicKey, createVerify } from "node:crypto";
import {
  createDeviceKey,
  getDevicePublicKey,
  publicKeyToPem,
  removeDeviceKey,
  signDeviceChallenge,
} from "../device-key.js";
import type { CryptoPort } from "../crypto-port.js";
import { memoryStore } from "./memory-store.js";
import { nodeCrypto } from "./node-crypto.js";

const PROMPT = "Use your fingerprint to sign in";
const CHALLENGE = "c3VwZXItc2VjcmV0LWNoYWxsZW5nZS0xMjM0NTY3ODk";

/** Exactly what hopper-web's /api/auth/biometric/register does with a device key. */
function serverVerifies(pem: string, challenge: string, signatureB64: string): boolean {
  const verifier = createVerify("SHA256");
  verifier.update(challenge);
  return verifier.verify(pem, signatureB64, "base64");
}

describe("on-device key", () => {
  it("creates a key whose signature the server verifies with node:crypto, and only for its own challenge", async () => {
    const m = memoryStore();
    const { publicKeyPem } = await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
    const sig = await signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT });

    expect(serverVerifies(publicKeyPem, CHALLENGE, sig)).toBe(true);
    expect(serverVerifies(publicKeyPem, CHALLENGE + "x", sig)).toBe(false);

    const other = memoryStore();
    const { publicKeyPem: otherPem } = await createDeviceKey({ store: other.store, crypto: nodeCrypto, prompt: PROMPT });
    expect(serverVerifies(otherPem, CHALLENGE, sig)).toBe(false);
  });

  it("verifies across many independently generated keys", async () => {
    for (let i = 0; i < 25; i++) {
      const m = memoryStore();
      const { publicKeyPem } = await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
      const challenge = `${CHALLENGE}-${i}`;
      expect(serverVerifies(publicKeyPem, challenge, await signDeviceChallenge({ store: m.store, challenge, prompt: PROMPT }))).toBe(true);
    }
  });

  it("emits a PEM node:crypto reads as a P-256 SubjectPublicKeyInfo", async () => {
    const m = memoryStore();
    const { publicKeyPem } = await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
    const key = createPublicKey(publicKeyPem);
    expect(key.asymmetricKeyType).toBe("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("keeps the private key behind authentication and the public key outside it", async () => {
    const m = memoryStore();
    await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
    expect([...m.protectedNames]).toEqual(["stonedog.device-key.private"]);
    expect(m.values.has("stonedog.device-key.public")).toBe(true);

    // Checking whether the phone is set up must NOT prompt for a fingerprint.
    expect(await getDevicePublicKey({ store: m.store })).toMatch(/BEGIN PUBLIC KEY/);
    expect(m.reads.every((r) => !r.requireAuthentication)).toBe(true);

    // Signing must read the private key WITH authentication and the app's prompt.
    await signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT });
    expect(m.reads.at(-1)).toEqual({ name: "stonedog.device-key.private", requireAuthentication: true, prompt: PROMPT });
  });

  it("is deterministic per key and challenge (RFC 6979), so it never needs the platform RNG to sign", async () => {
    const m = memoryStore();
    await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
    const a = await signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT });
    const b = await signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT });
    expect(a).toBe(b);
  });

  it("keeps separate keys under separate names", async () => {
    const m = memoryStore();
    const a = await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT, name: "account-a" });
    const b = await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT, name: "account-b" });
    expect(a.publicKeyPem).not.toBe(b.publicKeyPem);
    const sig = await signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT, name: "account-a" });
    expect(serverVerifies(a.publicKeyPem, CHALLENGE, sig)).toBe(true);
    expect(serverVerifies(b.publicKeyPem, CHALLENGE, sig)).toBe(false);
  });

  it("reports key_missing on a phone that was never set up", async () => {
    const m = memoryStore();
    await expect(signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT })).rejects.toThrow("key_missing");
  });

  it("reports key_invalidated when Android dropped the private key after a fingerprint change", async () => {
    // expo-secure-store returns null for a permanently invalidated key; the
    // surviving public half is what distinguishes this from "never set up".
    const m = memoryStore();
    await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
    m.values.delete("stonedog.device-key.private");
    await expect(signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT })).rejects.toThrow("key_invalidated");
  });

  it("passes the store's own reason through when the fingerprint is cancelled", async () => {
    const m = memoryStore();
    await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
    m.failNextAuthWith("authentication_cancelled");
    await expect(signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT })).rejects.toThrow(
      "authentication_cancelled",
    );
  });

  it("refuses a corrupt stored key rather than signing with it", async () => {
    const m = memoryStore();
    await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
    for (const bad of ["zz", "00".repeat(32), "ff".repeat(32), "ab".repeat(31)]) {
      m.values.set("stonedog.device-key.private", bad);
      await expect(signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT })).rejects.toThrow("key_corrupt");
    }
  });

  it.each(["short", "x".repeat(1025), "has space in it ok?", "non-ascii-ünïcødé-challenge"])(
    "refuses a challenge that is not 16-1024 printable ASCII: %p",
    async (challenge) => {
      const m = memoryStore();
      await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
      await expect(signDeviceChallenge({ store: m.store, challenge, prompt: PROMPT })).rejects.toThrow("invalid_challenge");
    },
  );

  it("refuses an unsafe key name", async () => {
    const m = memoryStore();
    await expect(
      createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT, name: "../escape" }),
    ).rejects.toThrow("invalid_key_name");
  });

  it("refuses a bad random source rather than creating a guessable key", async () => {
    const m = memoryStore();
    const short: CryptoPort = { ...nodeCrypto, randomBytes: () => new Uint8Array(16).fill(9) };
    const zeros: CryptoPort = { ...nodeCrypto, randomBytes: (n) => new Uint8Array(n) };
    await expect(createDeviceKey({ store: m.store, crypto: short, prompt: PROMPT })).rejects.toThrow("bad_random_length");
    await expect(createDeviceKey({ store: m.store, crypto: zeros, prompt: PROMPT })).rejects.toThrow("random_source_returned_zeros");
    expect(m.values.size).toBe(0);
  });

  it("leaves no public half behind if storing the private key fails", async () => {
    const m = memoryStore();
    const failing = { ...m.store, set: async () => { throw new Error("biometrics_unavailable"); } };
    await expect(createDeviceKey({ store: failing, crypto: nodeCrypto, prompt: PROMPT })).rejects.toThrow();
    expect(await getDevicePublicKey({ store: m.store })).toBeNull();
  });

  it("removes both halves", async () => {
    const m = memoryStore();
    await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
    await removeDeviceKey({ store: m.store });
    expect(m.values.size).toBe(0);
    await expect(signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT })).rejects.toThrow("key_missing");
  });

  it("rejects a malformed public point", () => {
    expect(() => publicKeyToPem(new Uint8Array(64))).toThrow("key_corrupt");
    expect(() => publicKeyToPem(new Uint8Array(65))).toThrow("key_corrupt");
  });

  it("puts no secret in an error message", async () => {
    const m = memoryStore();
    await createDeviceKey({ store: m.store, crypto: nodeCrypto, prompt: PROMPT });
    const secret = m.values.get("stonedog.device-key.private")!;
    m.values.set("stonedog.device-key.private", secret.slice(0, 63) + "z");
    await signDeviceChallenge({ store: m.store, challenge: CHALLENGE, prompt: PROMPT }).catch((e: Error) => {
      expect(e.message).not.toContain(secret.slice(0, 20));
    });
  });
});
