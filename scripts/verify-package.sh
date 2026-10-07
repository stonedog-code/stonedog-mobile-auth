#!/usr/bin/env bash
# Prove the PUBLISHED artifact works, which every other gate step is blind to:
# `files`, the `exports` map and the tarball contents are what a consumer
# receives, and they break at publish time on a version that can never be
# reused. Packs the tarball, checks what is inside it, installs it into a
# throwaway project, and imports and RUNS it as a consumer would.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build >/dev/null
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

TARBALL=$(npm pack --pack-destination "$WORK" --silent)
LIST=$(tar -tzf "$WORK/$TARBALL")
echo "tarball: $TARBALL ($(printf '%s\n' "$LIST" | wc -l) files)"

for f in package/dist/index.js package/dist/index.d.ts package/dist/expo.js package/dist/expo.d.ts \
         package/dist/device-key.js package/dist/device-key.d.ts \
         package/dist/expo-device-key.js package/dist/expo-device-key.d.ts \
         package/dist/connect-client.js package/dist/connect-client.d.ts \
         package/LICENSE package/NOTICE package/README.md; do
  printf '%s\n' "$LIST" | grep -qx "$f" || { echo "MISSING from tarball: $f" >&2; exit 1; }
done
if printf '%s\n' "$LIST" | grep -E '__tests__|\.test\.' >/dev/null; then
  echo "tests leaked into the tarball" >&2; exit 1
fi

cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "./$TARBALL" @stonedogcode/auth@^0.4.0 @noble/curves@^2.4.0 >/dev/null
cat > check.mjs <<'JS'
import { createHash, randomBytes } from "node:crypto";
import { createPkcePair, parseConnectQr, formatManualCode } from "@stonedogcode/mobile-auth";
import { verifyPkceS256 } from "@stonedogcode/auth";
const port = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  sha256: async (d) => new Uint8Array(createHash("sha256").update(d).digest()),
};
const pair = await createPkcePair(port);
if (!verifyPkceS256(pair.verifier, pair.challenge)) throw new Error("PKCE pair rejected by @stonedogcode/auth");
const t = "A".repeat(43);
const r = parseConnectQr(`https://app.example.com/connect#t=${t}`, { allowedOrigins: ["https://app.example.com"] });
if (!r.ok) throw new Error("documented payload rejected: " + r.reason);
if (formatManualCode("abcdefgh") !== "ABCD-EFGH") throw new Error("manual code format");
// The on-device key, as a consumer uses it: sign, then verify exactly as the
// server does, with node:crypto.
const { createVerify } = await import("node:crypto");
const { createDeviceKey, signDeviceChallenge } = await import("@stonedogcode/mobile-auth/device-key");
const mem = new Map();
const store = {
  set: async (k, v) => { mem.set(k, v); },
  get: async (k) => mem.get(k) ?? null,
  remove: async (k) => { mem.delete(k); },
};
const { publicKeyPem } = await createDeviceKey({ store, crypto: port, prompt: "Use your fingerprint" });
const challenge = "consumer-check-challenge-0123456789";
const sig = await signDeviceChallenge({ store, challenge, prompt: "Use your fingerprint" });
const v = createVerify("SHA256"); v.update(challenge);
if (!v.verify(publicKeyPem, sig, "base64")) throw new Error("device-key signature rejected by node:crypto");
// The connect client, as a consumer drives it, with a scripted fetch.
const { createConnectClient } = await import("@stonedogcode/mobile-auth");
const replies = [{ status: 200, body: { nonce: "n" } }, { status: 202 }, { status: 200, body: { enrolmentToken: "tok" } }];
const sent = [];
const client = createConnectClient({
  origin: "https://app.example.com",
  fetch: async (url, init) => { sent.push([url, init]); const r = replies.shift(); return { status: r.status, json: async () => r.body }; },
  sleep: async () => {},
});
if (client.readScanned(`https://evil.example/connect#t=${t}`).ok) throw new Error("foreign-origin QR accepted");
const p = await client.present({ ticket: t });
if (p.kind !== "ok") throw new Error("present: " + p.kind);
const w = await client.waitForConfirmation({ collect: p.collect, nonce: p.nonce });
if (w.kind !== "confirmed" || JSON.stringify(w.grant).includes("tok")) throw new Error("wait: " + w.kind);
console.log("consumer import + run: ok (PKCE, connect code, connect client, device key)");
JS
node check.mjs
