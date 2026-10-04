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
         package/LICENSE package/NOTICE package/README.md; do
  printf '%s\n' "$LIST" | grep -qx "$f" || { echo "MISSING from tarball: $f" >&2; exit 1; }
done
if printf '%s\n' "$LIST" | grep -E '__tests__|\.test\.' >/dev/null; then
  echo "tests leaked into the tarball" >&2; exit 1
fi

cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "./$TARBALL" @stonedogcode/auth@^0.4.0 >/dev/null
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
console.log("consumer import + run: ok");
JS
node check.mjs
