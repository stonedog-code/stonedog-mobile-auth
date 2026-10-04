/**
 * Reading a "connect a phone" code: the QR the website shows, or the short
 * manual code that is its accessible alternative.
 *
 * ## The QR payload
 *
 *     https://<origin>/connect#t=<ticket>
 *
 * - An https URL, so scanning it with the phone's own camera opens the app
 *   through Android App Links / iOS Universal Links.
 * - The ticket is in the FRAGMENT, which a browser never sends to a server, so
 *   a payload opened in a browser by mistake does not land in an access log.
 * - The ticket is opaque: 32 random bytes, base64url, exactly 43 characters.
 *   It carries no account detail, so a photographed QR discloses nothing.
 *
 * ## Why the origin is checked against an allowlist
 *
 * A QR code is attacker-supplied input. One that points at a look-alike host
 * would otherwise have the app send its claim, and the device details with it,
 * to whoever printed the code. `allowedOrigins` comes from the app's own build
 * configuration, never from the payload.
 */
import { MobileAuthError } from "./errors.js";

export const CONNECT_PATH = "/connect";
const TICKET = /^[A-Za-z0-9_-]{43}$/;

export type ConnectCodeRejection =
  | "not_a_url"
  | "insecure_scheme"
  | "origin_not_allowed"
  | "wrong_path"
  | "missing_ticket"
  | "malformed_ticket";

export type ParsedConnectCode =
  | { ok: true; origin: string; ticket: string }
  | { ok: false; reason: ConnectCodeRejection };

export interface ParseConnectCodeOptions {
  /** Exact origins this app may connect to, e.g. `["https://example.com"]`. */
  allowedOrigins: readonly string[];
  /**
   * Accept `http://localhost` and `http://127.0.0.1` for a development build.
   * Off by default; never enable it in a store build.
   */
  allowInsecureLocalhost?: boolean;
}

/**
 * A strict parser rather than `new URL()`. React Native's built-in URL has
 * historically left getters such as `hostname` and `hash` unimplemented, so a
 * parser built on it can pass every Node test and still throw on a phone.
 *
 * Accepts `scheme://host[:port][/path][?query][#fragment]`. Refuses userinfo
 * (`https://app.example.com@evil.test/...`), the classic look-alike.
 */
const URL_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;
const HOST_PORT = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/;

interface UrlParts {
  scheme: string;
  host: string;
  origin: string;
  path: string;
  fragment: string;
}

function splitUrl(raw: string): UrlParts | null {
  const m = URL_SHAPE.exec(raw);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!;
  const hp = HOST_PORT.exec(authority);
  if (!hp) return null; // userinfo, IPv6 literals, or garbage: none are valid here
  const host = hp[1]!.toLowerCase();
  const port = hp[2];
  const defaultPort = (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
  const origin = `${scheme}://${host}${port && !defaultPort ? `:${port}` : ""}`;
  return { scheme, host, origin, path: m[3] ?? "", fragment: (m[5] ?? "").replace(/^#/, "") };
}

function normaliseOrigin(origin: string): string {
  const parts = splitUrl(origin.trim().replace(/\/+$/, ""));
  return parts ? parts.origin : origin.toLowerCase();
}

function fragmentValues(fragment: string, key: string): string[] {
  const values: string[] = [];
  for (const pair of fragment.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const k = eq === -1 ? pair : pair.slice(0, eq);
    if (k === key) values.push(eq === -1 ? "" : pair.slice(eq + 1));
  }
  return values;
}

export function parseConnectQr(raw: string, options: ParseConnectCodeOptions): ParsedConnectCode {
  if (options.allowedOrigins.length === 0) {
    // An empty allowlist must fail closed, never mean "anything goes".
    throw new MobileAuthError("empty_allowlist");
  }
  const url = splitUrl(raw.trim());
  if (!url) return { ok: false, reason: "not_a_url" };

  const isLocalhost = url.host === "localhost" || url.host === "127.0.0.1";
  if (url.scheme !== "https" && !(url.scheme === "http" && isLocalhost && options.allowInsecureLocalhost)) {
    return { ok: false, reason: "insecure_scheme" };
  }
  if (!options.allowedOrigins.some((o) => normaliseOrigin(o) === url.origin)) {
    return { ok: false, reason: "origin_not_allowed" };
  }
  if (url.path.replace(/\/+$/, "") !== CONNECT_PATH) {
    return { ok: false, reason: "wrong_path" };
  }

  const tickets = fragmentValues(url.fragment, "t");
  if (tickets.length === 0) return { ok: false, reason: "missing_ticket" };
  // Exactly one: two values means the payload was tampered with or mis-built,
  // and choosing either would be a guess.
  if (tickets.length > 1 || !TICKET.test(tickets[0]!)) {
    return { ok: false, reason: "malformed_ticket" };
  }
  return { ok: true, origin: url.origin, ticket: tickets[0]! };
}

/**
 * The manual code: 8 characters of Crockford base32, shown as `ABCD-EFGH`.
 *
 * For a person who cannot scan, it must be easy to read aloud and to type, so
 * the alphabet has no I, L, O or U, and typing is forgiving: case, spaces and
 * hyphens are ignored, and I/L read as 1 and O as 0.
 *
 * At 40 bits it is short by design, so it is only safe with what the SERVER
 * must also do: single use, a lifetime of about two minutes, a tight attempt
 * limit, and confirmation on the signed-in website before anything is issued.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MANUAL_CODE_LENGTH = 8;

/** Canonical form (`ABCDEFGH`), or `null` if the input cannot be a manual code. */
export function normaliseManualCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length !== MANUAL_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CROCKFORD.includes(ch)) return null;
  return cleaned;
}

/** Display form, `ABCD-EFGH`, from a canonical code. */
export function formatManualCode(canonical: string): string {
  const code = normaliseManualCode(canonical);
  if (code === null) throw new MobileAuthError("invalid_manual_code");
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
