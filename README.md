# @stonedogcode/mobile-auth

Phone-side authentication helpers for **Expo** apps. It pairs with
[`@stonedogcode/auth`](https://github.com/stonedog-code/stonedog-auth), which holds the server
side.

It covers connecting a phone to an account that is already signed in on a website, and
fingerprint sign-in with an on-device key:

- **PKCE** (RFC 7636, S256 only). The phone keeps the verifier and sends only the challenge. A
  ticket that was photographed, relayed or intercepted can't be redeemed by anyone else.
- **Reading a "connect a phone" code**: the QR code a website shows, or the short manual code
  that is its accessible alternative.

```bash
npm install @stonedogcode/mobile-auth expo-crypto
```

---

## ⚠️ Disclaimer

**This software is provided "AS IS", without warranty of any kind, express or implied, and
without any liability whatsoever.** See sections 7 and 8 of the [Apache License 2.0](./LICENSE),
which govern.

- **It has not been independently audited.** It makes no claim of fitness for any regulated
  purpose.
- **A client library cannot make a sign-in flow secure on its own.** The guarantees below depend
  on what the server does too. Each section says which half is whose.

---

## Usage

```ts
import { createPkcePair, parseConnectQr, normaliseManualCode } from "@stonedogcode/mobile-auth";
import { expoCrypto } from "@stonedogcode/mobile-auth/expo";

// 1. Read the code the user scanned.
const parsed = parseConnectQr(scannedText, { allowedOrigins: ["https://app.example.com"] });
if (!parsed.ok) {
  // parsed.reason is one of: not_a_url, insecure_scheme, origin_not_allowed,
  // wrong_path, missing_ticket, malformed_ticket.
  return showCannotConnect(parsed.reason);
}

// 2. Create a PKCE pair. Send the challenge with the claim; keep the verifier.
const { verifier, challenge } = await createPkcePair(expoCrypto);
await claim(parsed.origin, parsed.ticket, challenge); // your app's API call

// 3. Once the website has confirmed, redeem with the verifier.
await redeem(parsed.origin, parsed.ticket, verifier);
```

For a person who can't scan, accept the manual code:

```ts
const code = normaliseManualCode(typedText); // "abcd efgh" -> "ABCDEFGH", or null
```

## The QR payload

```
https://<origin>/connect#t=<ticket>
```

| Part | Why |
|---|---|
| `https` URL | Scanning it with the phone's own camera opens the app via Android App Links / iOS Universal Links |
| ticket in the **fragment** | A browser never sends the fragment to a server, so a code opened in a browser by mistake doesn't land in an access log |
| ticket is 43 base64url characters | 32 random bytes and opaque. It carries no account detail, so a photographed code discloses nothing |

**The origin is checked against an allowlist from the app's own build configuration**, never from
the payload. A QR code is attacker-supplied input. One that points at a look-alike host would
otherwise make the app send its claim, and its device details, to whoever printed it. An empty
allowlist throws rather than accepting anything.

`http://localhost` is accepted only with `allowInsecureLocalhost: true`, for development builds.

## The manual code

Eight characters of Crockford base32, displayed as `ABCD-EFGH`. The alphabet has no I, L, O or U,
so it is easy to read aloud. Typing is forgiving: case, spaces and hyphens are ignored, and I/L
read as 1 and O as 0.

**It is short by design, and it is only safe if the server does its half:**
- single use;
- a lifetime of about two minutes;
- a tight attempt limit;
- confirmation on the signed-in website before anything is issued.

## The on-device key (0.2.0)

Fingerprint sign-in with a key that never leaves the phone. The private key is
kept in `expo-secure-store` behind `requireAuthentication`: the Android Keystore
protects it, the fingerprint unlocks it, and it is never synced. The phone signs
the server's challenge; the server verifies with the public key it was given at
enrolment.

```bash
npm install @noble/curves expo-secure-store expo-local-authentication
```

```ts
import { createDeviceKey, signDeviceChallenge, getDevicePublicKey } from "@stonedogcode/mobile-auth/device-key";
import { expoDeviceKeyStore, fingerprintAvailability } from "@stonedogcode/mobile-auth/expo-device-key";
import { expoCrypto } from "@stonedogcode/mobile-auth/expo";

// Only offer set-up on a phone with a STRONG biometric enrolled.
if ((await fingerprintAvailability()).available) {
  const { publicKeyPem } = await createDeviceKey({
    store: expoDeviceKeyStore, crypto: expoCrypto, prompt: "Set up fingerprint sign-in",
  });
  await registerWithServer(publicKeyPem); // your app's API call, from a signed-in session
}

// Later, at sign-in: the read prompts for the fingerprint.
const signature = await signDeviceChallenge({
  store: expoDeviceKeyStore, challenge: serverChallenge, prompt: "Use your fingerprint to sign in",
});
```

**The signature format:** ECDSA P-256 over SHA-256, DER-encoded, standard base64.
That's what `node:crypto` verifies by default:

```ts
createVerify("SHA256").update(challenge).verify(publicKeyPem, signature, "base64");
```

**Failures are reason codes.** Every app should handle these:

| reason | meaning, and what the app should do |
|---|---|
| `authentication_cancelled` | the person dismissed the prompt; let them try again or use another way in |
| `authentication_failed` | the fingerprint was not recognised |
| `biometrics_unavailable` | no strong biometric is enrolled; don't offer fingerprint sign-in |
| `key_missing` | this phone was never set up |
| `key_invalidated` | Android dropped the key because the enrolled fingerprints changed; offer to set up again |
| `key_corrupt`, `store_error` | treat as `key_missing`, and set up again |

**Randomness.** It comes only from the `CryptoPort` you pass in. Signing is
deterministic (RFC 6979), so the curve library never reaches for
`crypto.getRandomValues`, which React Native does not reliably provide.

**The server's half is yours to write:**
- issue single-use, short-lived challenges;
- store the public key per device;
- verify;
- rate-limit;
- let the user revoke a phone.

## Design rules

- **No runtime dependencies.** Each optional capability has its own entry point and optional
  peer: `./expo` (expo-crypto), `./device-key` (@noble/curves), `./expo-device-key`
  (expo-secure-store, expo-local-authentication). The core never
  imports Expo, so it is testable in Node, and an app can supply its own `CryptoPort`.
- **No secret leaves through an error.** Errors carry a reason code, never the verifier, ticket
  or code.
- **Runs on Hermes.** The core doesn't use `Buffer`.

## Roadmap

Token storage, with single-flight refresh, is planned and not in this release.

## Development

```bash
npm ci
npm run gate             # type-check, lint, unit tests with coverage, build, and a packed-tarball consumer check
npm run release:dry-run  # every release check, stopping before npm publish
npm run release          # publish (maintainers; from a clean, current main; asks for a 2FA code)
```

## Licence

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
