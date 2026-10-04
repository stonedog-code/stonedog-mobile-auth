import { verifyPkceS256 } from "@stonedogcode/auth";
import type { CryptoPort } from "../crypto-port.js";
import { MobileAuthError } from "../errors.js";
import { VERIFIER_BYTES, createPkcePair, pkceChallengeS256 } from "../pkce.js";
import { nodeCrypto } from "./node-crypto.js";

describe("pkceChallengeS256", () => {
  it("reproduces the RFC 7636 Appendix B test vector", async () => {
    await expect(
      pkceChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", nodeCrypto),
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("refuses a verifier outside RFC 7636's length and alphabet", async () => {
    await expect(pkceChallengeS256("too-short", nodeCrypto)).rejects.toThrow("invalid_verifier");
    await expect(pkceChallengeS256("a".repeat(129), nodeCrypto)).rejects.toThrow("invalid_verifier");
    await expect(pkceChallengeS256("a".repeat(42) + "!", nodeCrypto)).rejects.toThrow("invalid_verifier");
  });

  it("refuses a digest that is not 32 bytes", async () => {
    const shortDigest: CryptoPort = { ...nodeCrypto, sha256: async () => new Uint8Array(16) };
    await expect(pkceChallengeS256("a".repeat(43), shortDigest)).rejects.toThrow("bad_digest");
  });
});

describe("createPkcePair", () => {
  it("produces a 43-character verifier and an S256 challenge", async () => {
    const pair = await createPkcePair(nodeCrypto);
    expect(pair.method).toBe("S256");
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  /**
   * The interop claim: what the phone produces is exactly what the server-side
   * library accepts. Both directions, so a check that always says yes would fail.
   */
  it("is accepted by @stonedogcode/auth's verifyPkceS256, and only with its own verifier", async () => {
    const a = await createPkcePair(nodeCrypto);
    const b = await createPkcePair(nodeCrypto);
    expect(verifyPkceS256(a.verifier, a.challenge)).toBe(true);
    expect(verifyPkceS256(b.verifier, a.challenge)).toBe(false);
  });

  it("never repeats a verifier", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add((await createPkcePair(nodeCrypto)).verifier);
    expect(seen.size).toBe(200);
  });

  it("refuses a random source of the wrong length", async () => {
    const short: CryptoPort = { ...nodeCrypto, randomBytes: () => new Uint8Array(VERIFIER_BYTES - 1).fill(7) };
    await expect(createPkcePair(short)).rejects.toThrow("bad_random_length");
  });

  it("refuses a random source that returns zeros (a stub left in place)", async () => {
    const zeros: CryptoPort = { ...nodeCrypto, randomBytes: (n) => new Uint8Array(n) };
    await expect(createPkcePair(zeros)).rejects.toThrow(MobileAuthError);
  });

  it("puts no secret in an error message", async () => {
    const verifier = "a".repeat(42) + "!";
    await pkceChallengeS256(verifier, nodeCrypto).catch((e: Error) => {
      expect(e.message).not.toContain(verifier);
    });
  });
});
