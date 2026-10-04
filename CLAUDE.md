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
- **Publishing** is manual, from a clean `main`: `npm publish` with a 2FA one-time password.
  Bump the version in the same PR that adds an export.
