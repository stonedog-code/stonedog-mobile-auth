#!/usr/bin/env bash
# Copyright (C) 2026 StoneDogCode L.L.C.
# SPDX-License-Identifier: Apache-2.0
#
# Publish @stonedogcode/mobile-auth to npm, end to end.
#
#   npm run release          (alias for npm run publish:stonedog-mobile-auth)
#
# Run it from a terminal, interactively. npm prompts for the 2FA one-time
# password itself (account `stonedogcode`) and the browser login flow needs a
# human, so neither works unattended. That's why this is a script you run
# rather than a step in CI.
#
# Adapted from stonedog-auth's script of the same name, and it keeps the same
# central lesson: a publish that prints no error can still have published
# nothing, or the wrong thing. So this reads the tarball before publishing and
# installs from the registry afterwards.
#
# ## The traps specific to THIS package
#
# 1. **Zero runtime dependencies is a claim the README makes.** This sits on the
#    sign-in path of every app that adopts it, so a dependency added without
#    noticing is inherited by all of them. Gated below, not just commented.
#
# 2. **expo-crypto must stay an OPTIONAL peer.** Only the `./expo` entry point
#    uses it, and an app that supplies its own CryptoPort must be able to install
#    this package without pulling in Expo.
#
# 3. **Two entry points** (`.` and `./expo`). A tarball missing either installs
#    fine and fails at the consumer's first import.
#
# 4. **Shipped source must be Hermes-safe.** No Buffer, URL, URLSearchParams or
#    TextEncoder: React Native provides them incompletely or not at all, so a use
#    passes every Node test and crashes on a phone. Lint enforces this; it is
#    repeated here because a publish is irreversible.
#
# 5. **No `console.*` in shipped source**, and tests must not ship.
set -euo pipefail

PACKAGE_NAME="@stonedogcode/mobile-auth"
# Sanity floor. Comfortably under the real count (32 at 0.1.0, counting
# sourcemaps and declaration maps) and far above what a `files`-misconfigured
# package would produce (3: package.json, README, LICENSE).
MIN_FILES=20
# Every path `exports` names.
REQUIRED_PATHS=("dist/index.js" "dist/index.d.ts" "dist/expo.js" "dist/expo.d.ts")

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mREFUSING: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Publish from a clean, current `main`.
# ---------------------------------------------------------------------------
say "Checking the working tree"
BRANCH="$(git branch --show-current)"
[ -n "$BRANCH" ] || fail "this checkout is in detached HEAD. Run: git checkout main && git pull"
[ "$BRANCH" = "main" ] || fail "on branch '$BRANCH'. Publish from main, never a feature branch."
[ -z "$(git status --porcelain | grep -v '^??')" ] || fail "the working tree has uncommitted changes."

git fetch --quiet origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  BEHIND="$(git rev-list --count HEAD..origin/main)"
  fail "HEAD is not origin/main ($BEHIND commit(s) behind). A checkout one commit behind publishes a tarball missing the very thing you are publishing for, and it looks like a success. Run: git pull"
fi
echo "  clean, on main, at $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
# 2. Authenticate.
#
# A 404 from `npm publish` means AUTH far more often than a missing package —
# npm answers 404 rather than 403 so it cannot leak whether a name exists. `npm
# whoami` turns that confusing failure into a clear one, and is the only thing
# that reveals an `_authToken` that is present but expired.
# ---------------------------------------------------------------------------
say "Checking npm authentication"
if ! NPM_USER="$(npm whoami 2>/dev/null)"; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  not logged in (fine for a dry run; npm run release will start the browser login)"
    NPM_USER=""
  else
    echo "  not logged in — starting the browser login flow"
    npm login
  fi
  [ "$DRY_RUN" -eq 1 ] || NPM_USER="$(npm whoami)"
fi
[ -n "$NPM_USER" ] && echo "  authenticated as $NPM_USER"

if [ -z "$NPM_USER" ]; then
  echo "  (skipping the ownership check: not logged in)"
elif npm view "$PACKAGE_NAME" version >/dev/null 2>&1; then
  npm owner ls "$PACKAGE_NAME" 2>/dev/null | grep -q "^$NPM_USER " \
    || fail "'$NPM_USER' is not an owner of $PACKAGE_NAME, so publishing will fail with a misleading 404."
  echo "  $NPM_USER is an owner of $PACKAGE_NAME"
else
  echo "  $PACKAGE_NAME does not exist yet — this is the first publish, which creates it"
  # A scoped name needs the scope to be an org you belong to, or your own
  # username. When it is neither, npm answers 404 rather than 403 — it will not
  # leak whether an org exists — so the failure reads as a missing package while
  # auth is perfectly fine. This is the check that turns that into a sentence.
  npm org ls stonedogcode >/dev/null 2>&1 \
    || echo "  NOTE: could not list the 'stonedogcode' org. If the publish 404s, that is why — not a missing package."
fi

# ---------------------------------------------------------------------------
# 3. A version may be published at most once, ever.
# ---------------------------------------------------------------------------
VERSION="$(node -p "require('./package.json').version")"
say "Preparing $PACKAGE_NAME@$VERSION"

if npm view "$PACKAGE_NAME@$VERSION" version >/dev/null 2>&1; then
  fail "$PACKAGE_NAME@$VERSION is already published. A version can never be reused — bump it (npm run version:bump:patch), land that, then re-run."
fi

# ---------------------------------------------------------------------------
# 3b. Install exactly what the lockfile says, before anything reads node_modules.
#
# Every check above is about GIT. None of them looks at node_modules, and the
# two diverge exactly when a manifest change has just been pulled — which is
# precisely when someone is about to publish.
#
# stonedog-howto 0.1.2 hit this (NEH-497). The checkout was clean, on main and
# current, so the script reported readiness in as many words — but `npm install`
# had never run after the pull that renamed the style dependency. The old
# unscoped package was still on disk and the scoped one absent, and Panda's
# codegen, which resolves that import for real, died with
# "Could not resolve @stonedogcode/style/preset". That reads as a config defect
# rather than an un-run install, and it costs an interactive 2FA attempt to
# find out otherwise.
#
# `npm ci` rather than `npm install`, for two reasons: it installs exactly the
# lockfile, and it FAILS when the lockfile and manifest disagree. That
# disagreement is itself a reason not to publish — `npm install` would quietly
# reconcile it and ship a tarball built against a lockfile nobody committed.
# ---------------------------------------------------------------------------
say "Installing dependencies from the lockfile"
[ -f package-lock.json ] || fail "there is no package-lock.json, so there is nothing to install reproducibly from."
npm ci
echo "  node_modules now matches package-lock.json"

# ---------------------------------------------------------------------------
# 4. The manifest invariants, before anything slow runs.
# ---------------------------------------------------------------------------
say "Checking the manifest invariants"
node -e '
  const pkg = require("./package.json");

  const deps = Object.keys(pkg.dependencies || {});
  if (deps.length > 0) {
    console.error(`REFUSING: this package claims ZERO runtime dependencies and now has ${deps.length}: ${deps.join(", ")}.`);
    console.error("  It sits on the sign-in path of every app that adopts it, and every dependency it");
    console.error("  takes, every consumer inherits. If this is deliberate, change the README claim");
    console.error("  in the same commit that adds it.");
    process.exit(1);
  }

  const meta = (pkg.peerDependenciesMeta || {})["expo-crypto"];
  if (!(pkg.peerDependencies || {})["expo-crypto"] || !meta || meta.optional !== true) {
    console.error("REFUSING: expo-crypto must be an OPTIONAL peer dependency. Only the ./expo entry uses it,");
    console.error("  and an app with its own CryptoPort must be able to install this without Expo.");
    process.exit(1);
  }

  if (pkg.license !== "Apache-2.0") {
    console.error(`REFUSING: license is "${pkg.license}", expected Apache-2.0.`);
    process.exit(1);
  }
  if (!pkg.publishConfig || pkg.publishConfig.access !== "public") {
    console.error("REFUSING: publishConfig.access is not \"public\". A scoped package defaults to RESTRICTED,");
    console.error("  which needs a paid plan and fails the publish.");
    process.exit(1);
  }
'
echo "  zero dependencies; expo-crypto an optional peer; Apache-2.0; public"

# ---------------------------------------------------------------------------
# 5. No credential can reach a log from shipped source.
# ---------------------------------------------------------------------------
say "Checking that shipped source writes nothing to the console"
if grep -rnE 'console\.(log|info|warn|error|debug)' src --include='*.ts' | grep -v '__tests__'; then
  fail "shipped source writes to the console. This library handles verifiers and tickets, and whoever writes a log line is debugging at the time, which is exactly when a secret is closest to hand."
fi
echo "  clean"

say "Checking that shipped source is Hermes-safe"
if grep -rnE '\b(Buffer|URLSearchParams|TextEncoder)\b|new URL\(' src --include='*.ts' \
     | grep -v '__tests__' | grep -vE '^[^:]+:[0-9]+:\s*(\*|//)'; then
  fail "shipped source uses Buffer, URL, URLSearchParams or TextEncoder. React Native provides these incompletely or not at all, so this would pass every Node test and crash on a phone."
fi
echo "  clean"

# ---------------------------------------------------------------------------
# 6. The gate, which ends with the package check.
#
# Both, in this order. The gate proves the SOURCE is good; verify:package
# proves what a CONSUMER receives is good. Publishing is irreversible on a
# version number, so neither is assumed from a green PR — this checkout may
# carry commits that merged after the last CI run.
# ---------------------------------------------------------------------------
say "Running the gate (it ends with verify:package, the packed-tarball consumer check)"
npm run gate

# ---------------------------------------------------------------------------
# 7. Read the tarball before trusting it.
# ---------------------------------------------------------------------------
say "Verifying the tarball"
PACK_OUTPUT="$(npm pack --dry-run 2>&1)"
FILE_COUNT="$(printf '%s' "$PACK_OUTPUT" | sed -n 's/.*total files:[[:space:]]*\([0-9]*\).*/\1/p' | tail -1)"

[ -n "$FILE_COUNT" ] || fail "could not read a file count from npm pack."
[ "$FILE_COUNT" -ge "$MIN_FILES" ] \
  || fail "the tarball has only $FILE_COUNT files (expected >= $MIN_FILES). Publishing this would ship a near-empty package on a version number that can never be reused."

printf '%s' "$PACK_OUTPUT" | grep -q '__tests__' \
  && fail "the tarball contains test files. They import jest globals that are not dependencies."

for path in "${REQUIRED_PATHS[@]}"; do
  printf '%s' "$PACK_OUTPUT" | grep -q "$path" \
    || fail "'$path' is not in the tarball, but package.json's \"exports\" names it. Every consumer import of that entry point would fail."
done

printf '%s' "$PACK_OUTPUT" | grep -q 'README.md' \
  || fail "no README.md in the tarball — npmjs.com would show 'This package does not have a README', and this package's README carries its security disclaimer and the server-side obligations."
printf '%s' "$PACK_OUTPUT" | grep -q 'LICENSE' \
  || fail "no LICENSE in the tarball. This package is Apache-2.0 and the licence text ships with it."
printf '%s' "$PACK_OUTPUT" | grep -q 'NOTICE' \
  || fail "no NOTICE in the tarball. Apache-2.0 section 4(d) requires it to travel with the work."

echo "  $FILE_COUNT files; entry points, README, LICENSE and NOTICE present; no tests"

say "Tarball contents — read this before confirming"
printf '%s\n' "$PACK_OUTPUT" | sed -n 's/^npm notice[[:space:]]*[0-9.]*[kMG]*B*[[:space:]]*\(dist\/.*\)/  \1/p' | sort
echo "  ($FILE_COUNT files total)"

# ---------------------------------------------------------------------------
# 8. Publish. npm prompts for the OTP here.
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n\033[32m✓ dry run: every check passed for %s@%s. Nothing was published.\033[0m\n' "$PACKAGE_NAME" "$VERSION"
  echo "  Run npm run release to publish."
  exit 0
fi

say "Publishing $PACKAGE_NAME@$VERSION — npm will ask for your 2FA code"
npm publish --access public

# ---------------------------------------------------------------------------
# 9. PROVE IT. The registry is eventually consistent for a few seconds, so this
#    polls rather than asserting once, and ends with a real install.
# ---------------------------------------------------------------------------
say "Verifying it is actually installable"
PROBE_DIR="$(mktemp -d)"
trap 'rm -rf "$PROBE_DIR"' EXIT

for attempt in $(seq 1 20); do
  if npm view "$PACKAGE_NAME@$VERSION" version >/dev/null 2>&1; then break; fi
  [ "$attempt" -lt 20 ] || fail "$PACKAGE_NAME@$VERSION is still not on the registry after publishing. The publish did NOT succeed, whatever it printed."
  sleep 3
done

printf '{"name":"probe","version":"1.0.0"}' > "$PROBE_DIR/package.json"
(cd "$PROBE_DIR" && npm install --silent "$PACKAGE_NAME@$VERSION" >/dev/null 2>&1) \
  || fail "$PACKAGE_NAME@$VERSION resolves but cannot be installed."

INSTALLED="$(node -p "require('$PROBE_DIR/node_modules/$PACKAGE_NAME/package.json').version")"
[ "$INSTALLED" = "$VERSION" ] || fail "installed $INSTALLED but published $VERSION."

for path in "${REQUIRED_PATHS[@]}"; do
  [ -f "$PROBE_DIR/node_modules/$PACKAGE_NAME/$path" ] \
    || fail "$path is missing from the INSTALLED package, though it was in the tarball."
done

# Installing this package alone must NOT pull in Expo. That is the point of the
# optional peer, and it is what an app supplying its own CryptoPort depends on.
if [ -d "$PROBE_DIR/node_modules/expo-crypto" ] || [ -d "$PROBE_DIR/node_modules/expo" ]; then
  fail "installing $PACKAGE_NAME alone pulled in expo-crypto or expo. It must stay an optional peer."
fi

printf '\n\033[32m✓ %s@%s is published and installable.\033[0m\n' "$PACKAGE_NAME" "$VERSION"
echo "  https://www.npmjs.com/package/$PACKAGE_NAME"
printf '\n\033[1mNext:\033[0m in an Expo app, install it with expo-crypto and import the adapter from\n'
printf '  @stonedogcode/mobile-auth/expo. The server half is @stonedogcode/auth.\n'
