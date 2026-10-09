# stonedog-mobile-auth

Phone-side authentication helpers for Expo apps, published as `@stonedogcode/mobile-auth`. The
server side is `@stonedogcode/auth` (stonedog-auth). They meet at the PKCE challenge and the
connect-code format, so change both together.

- **PUBLIC repository.** No issue ids, internal hostnames or product names in shipped source or
  the README. PRDs live in the internal `stonedog-prd` repo, reached through the gitignored
  `docs/prd` symlink.
- **No runtime dependencies.** Each optional capability is its own entry with an optional peer:
  `./expo` (expo-crypto), `./device-key` (@noble/curves), `./expo-device-key`
  (expo-secure-store, expo-local-authentication), `./expo-session-storage` (expo-secure-store).
  The core `.` entry imports none of them.
- **Session (0.4.0):** tokens only in the injected storage (the Expo adapter: expo-secure-store,
  default keychain service, never `requireAuthentication`). A `Session` holds its tokens in a
  WeakMap behind getters and serialises redacted. Refresh is single-flight per store; `save` and
  `clear` bump a generation and a refresh writes only if it has not moved. The refresh's own write
  deliberately does NOT bump it, so concurrent callers still refused after a refresh can end the
  session. `authorized` refreshes at most once.
- **Device key:** key-generation randomness only from the caller's `CryptoPort`; signing nonces
  deterministic (RFC 6979, `extraEntropy: false`). @noble/curves uses `getRandomValues` only for
  optional blinding, and falls back safely without it. The Expo adapter uses two dedicated
  keychain services (never the default), because an invalidation wipes a whole service. Signatures
  are DER + standard base64 so `node:crypto`'s `createVerify("SHA256")` verifies them unchanged.
- **Hermes-safe core.** No `Buffer`, no Node built-ins outside `src/__tests__`.
- **Errors carry reason codes, never secrets.**
- **Gate:** `npm run gate`. It ends with `verify:package`, which installs the packed tarball into
  a throwaway project and runs it.
- **Releasing:** `npm run release` from a clean, current `main`, in a terminal (npm asks for the
  2FA one-time password). It runs `scripts/publish-package.sh`: it refuses a stale or dirty
  checkout, a version already published, a runtime dependency, or non-Hermes-safe source; reads
  the tarball; publishes; then installs from the registry to prove it. `npm run release:dry-run`
  runs every check and stops before publishing. Never call a script `publish`: that's npm's
  lifecycle name and it would fire twice.
- **Versions:** `npm run version:bump:patch` or `version:bump:minor`, in the same PR that changes
  the code. A published version can never be reused.
