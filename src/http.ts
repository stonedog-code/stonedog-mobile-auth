/**
 * Internal: the transport rules shared by every module that talks to the
 * app's server (the connect client and the session refresher). Not exported
 * from the package entry; each module re-states the rules it relies on.
 *
 * - An origin is `https://host[:port]`, lower-cased, with no path. Plain
 *   `http` only for `localhost` / `127.0.0.1`, and only when the app opts in
 *   for a development build.
 * - A path is origin-relative with a single leading slash: never `//host`, a
 *   full URL, `..`, a query or a fragment. So a request is always
 *   `origin + path`, and nothing a caller passes can point it elsewhere.
 */
import { MobileAuthError } from "./errors.js";

const ORIGIN = /^(https?):\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?$/;
/** Origin-relative, single leading slash: `/a/b`. Not `//host`, not a URL, no query or fragment. */
const PATH = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

export function checkOrigin(raw: string, allowInsecureLocalhost: boolean): string {
  const trimmed = raw.trim().replace(/\/+$/, "").toLowerCase();
  const m = ORIGIN.exec(trimmed);
  if (!m) throw new MobileAuthError("invalid_origin");
  const scheme = m[1]!;
  const host = m[2]!;
  const port = m[3];
  const isLocalhost = host === "localhost" || host === "127.0.0.1";
  if (scheme !== "https" && !(isLocalhost && allowInsecureLocalhost)) throw new MobileAuthError("invalid_origin");
  const defaultPort = (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
  return `${scheme}://${host}${port && !defaultPort ? `:${port}` : ""}`;
}

export function checkPath(path: string): string {
  if (!PATH.test(path) || path.split("/").includes("..")) throw new MobileAuthError("invalid_path");
  return path;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** A response's JSON body as an object, or `null` when it is absent, malformed or not an object. */
export async function readJsonObject(res: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const body = await res.json();
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Timers through `globalThis`, typed here, because the published build sees
 * only the ES library (no DOM, no Node), and every runtime this targets
 * (Hermes, Node, a browser) provides both. Looked up at call time, so a test's
 * fake timers apply.
 */
export const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};
