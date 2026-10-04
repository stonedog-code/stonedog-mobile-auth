# stonedog-mobile-auth

Phone-side authentication helpers for Expo apps, published as `@stonedogcode/mobile-auth`. The
server side is `@stonedogcode/auth` (stonedog-auth). They meet at the PKCE challenge and the
connect-code format, so change both together.

- **PUBLIC repository.** No issue ids, internal hostnames or product names in shipped source or
  the README. PRDs live in the internal `stonedog-prd` repo, reached through the gitignored
  `docs/prd` symlink.
- **No runtime dependencies.** Expo is reached only through `src/expo.ts` (the `./expo` entry)
  and an optional peer.
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
