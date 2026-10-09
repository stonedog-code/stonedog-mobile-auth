/**
 * The client half of "connect a phone": a phone with no session joins an
 * account that is signed in on a website, then registers its device key.
 *
 * The flow, each step a server call:
 *
 * 1. **present** — `POST <connect> {ticket, device}` for a scanned QR, or
 *    `{code, device}` for the typed short code. The server answers with a
 *    nonce (and, for a typed code, the row id `ticketId`, because the phone
 *    never held the ticket). Nothing is issued yet.
 * 2. The person confirms on the phone; only then does the app start step 3.
 * 3. **wait** — `POST <complete> {ticket | ticketId, nonce}`, polled. `202`
 *    while the website has not decided; `200 {enrolmentToken, expiresIn}`
 *    once, after the person confirms this device on the website; `404` or
 *    `410` ends it.
 * 4. **enrol** — the caller's enrol function registers the device key. It is
 *    handed a `post` bound to the configured origin that carries the
 *    enrolment token as its bearer. It is never handed the token itself.
 *
 * `cancel` (`POST <cancel> {ticket | ticketId, nonce}`) tells the server the
 * person backed out, so the website stops waiting. Best effort: it never
 * throws.
 *
 * ## Security rules, each enforced here and pinned by a test
 *
 * - **The enrolment token is never stored.** It lives only inside an opaque
 *   `EnrolmentGrant`, in a module-private WeakMap. The grant serialises to a
 *   redacted placeholder, so even an app that persisted its whole screen
 *   state could not write the token. This module imports no store.
 * - **It only reaches the caller's enrol function as a bearer header**, on
 *   requests this module makes.
 * - **It is only sent to the configured origin.** Every request is built from
 *   `origin` + a path that must be origin-relative (`/...`, never `//...` or
 *   a full URL), so neither a route option nor the enrol function can point
 *   it anywhere else, and redirects are refused (`redirect: "error"`).
 * - **A QR whose origin differs from the configured one is refused**, by
 *   `parseConnectQr`'s allowlist, before anything is sent.
 *
 * No product copy lives here. Every outcome is a typed result code the app
 * maps to its own words.
 */
import { normaliseManualCode, parseConnectQr, MANUAL_CODE_LENGTH, type ConnectCodeRejection } from "./connect-code.js";
import { MobileAuthError } from "./errors.js";
import { checkOrigin, checkPath, readJsonObject, timers } from "./http.js";

// ── injected transport ───────────────────────────────────────────────────────

/** The smallest slice of a fetch Response this module reads. */
export interface ConnectResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface ConnectRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /**
   * Always `"error"`: a redirect is never followed, so a server-side open
   * redirect cannot carry the enrolment token's bearer header anywhere else.
   * A fetch that ignores the option still sees a 3xx, which is not success.
   */
  redirect: "error";
}

/** `fetch`, or anything shaped like it. Injected so the module runs and tests without a network. */
export type ConnectFetch = (url: string, init: ConnectRequestInit) => Promise<ConnectResponse>;

export interface ConnectPaths {
  /** Step 1. */
  connect: string;
  /** Step 3, polled. */
  complete: string;
  /** Backing out. */
  cancel: string;
}

/** Defaults. Override any of them with `paths`. */
export const DEFAULT_CONNECT_PATHS: Readonly<ConnectPaths> = Object.freeze({
  connect: "/api/mobile/v1/auth/connect",
  complete: "/api/mobile/v1/auth/connect/complete",
  cancel: "/api/mobile/v1/auth/connect/cancel",
});

export const DEFAULT_POLL_INTERVAL_MS = 2000;
/** A ticket lives about 120 s; a few seconds of slack covers a phone clock that disagrees. */
export const DEFAULT_WAIT_TIMEOUT_MS = 125_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Consecutive unanswered polls before the wait gives up. */
export const DEFAULT_MAX_POLL_FAILURES = 3;
/** Used when the server's 200 omits `expiresIn`. */
export const DEFAULT_ENROLMENT_TTL_S = 300;

export interface ConnectClientOptions {
  /** The app's own API origin, from its build configuration. Never from a QR. */
  origin: string;
  fetch: ConnectFetch;
  paths?: Partial<ConnectPaths>;
  /** Extra headers on every request, e.g. a timezone. Cannot set `Authorization`. */
  headers?: () => Record<string, string>;
  /** Accept `http://localhost` / `127.0.0.1` for a development build. Never in a store build. */
  allowInsecureLocalhost?: boolean;
  /** Per-request timeout. A request that runs over counts as a network failure. */
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
  /** Consecutive failed polls (network, timeout or 5xx) before the wait gives up. */
  maxPollFailures?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// ── references and results ───────────────────────────────────────────────────

/** How the phone names the code to `connect`: the scanned ticket, or the typed code. */
export type PresentRef = { ticket: string } | { code: string };

/** How the phone names the row afterwards, to `complete` and `cancel`. */
export type CollectRef = { ticket: string } | { ticketId: string };

export type ReadScanned = { ok: true; ref: { ticket: string } } | { ok: false; reason: ConnectCodeRejection };

export type TypedRejection = "too_short" | "not_a_code" | ConnectCodeRejection;
export type ReadTyped = { ok: true; ref: PresentRef } | { ok: false; reason: TypedRejection };

export type PresentResult =
  | { kind: "ok"; collect: CollectRef; nonce: string; maskedEmail: string | null; expiresAt: string | null }
  /** A scanned ticket the server does not know: unknown, expired, used or cancelled. */
  | { kind: "used_or_expired" }
  /** A typed code the server did not accept: mistyped, or run out. */
  | { kind: "wrong_code" }
  /** 429 on a scanned ticket. */
  | { kind: "rate_limited" }
  /** 429 on a typed code: the server allows only a few attempts. */
  | { kind: "too_many_codes" }
  | { kind: "offline" }
  | { kind: "failed"; status: number | null };

export type WaitResult =
  | { kind: "confirmed"; grant: EnrolmentGrant }
  /** 404 or 410: the website cancelled, the code ran out, or it was already used. */
  | { kind: "not_confirmed" }
  | { kind: "timed_out" }
  | { kind: "rate_limited" }
  /** `maxPollFailures` consecutive polls went unanswered. */
  | { kind: "offline" }
  | { kind: "failed"; status: number | null }
  | { kind: "stopped" };

export type CancelResult = { kind: "sent" } | { kind: "not_sent" };

export type EnrolResult<T> =
  | { kind: "ok"; value: T }
  /** The token is past its lifetime, already spent, or the server answered 401. Start again. */
  | { kind: "token_expired" }
  /** The fingerprint prompt was dismissed. The grant is still live: retry. */
  | { kind: "cancelled" }
  | { kind: "offline" }
  /** The server refused with something other than 401. `code` is its `error` field, if any. */
  | { kind: "refused"; status: number; code: string | null }
  /** Anything else the enrol function threw. */
  | { kind: "failed"; error: unknown };

/** A non-2xx answer to an enrolment `post`. */
export class ConnectHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`mobile-auth: http_${status}`);
    this.name = "ConnectHttpError";
  }
}

/** An enrolment `post` that got no answer (network failure or timeout). */
export class ConnectNetworkError extends Error {
  constructor() {
    super("mobile-auth: network");
    this.name = "ConnectNetworkError";
  }
}

/** Sends `body` to `<origin><path>` with the enrolment token as the bearer. Resolves the JSON body on 2xx. */
export type EnrolmentPost = (path: string, body: Record<string, unknown>) => Promise<unknown>;

// ── the enrolment grant: the token, held where nothing can persist it ───────

const grantTokens = new WeakMap<EnrolmentGrant, string>();

/**
 * Proof that the website confirmed this phone. Opaque: the token inside is
 * reachable only by the client that minted it, and only as a bearer header.
 */
export class EnrolmentGrant {
  /** Epoch milliseconds after which the server will refuse the token. */
  readonly expiresAt: number;

  /** @internal Minted by `waitForConfirmation`; not for apps. */
  constructor(token: string, expiresAt: number) {
    grantTokens.set(this, token);
    this.expiresAt = expiresAt;
  }

  /** True once enrolment succeeded or the token was refused: it will not work again. */
  get spent(): boolean {
    return !grantTokens.has(this);
  }

  /** Serialises without the token, so persisting state cannot write it. */
  toJSON(): { enrolmentGrant: "redacted"; expiresAt: number } {
    return { enrolmentGrant: "redacted", expiresAt: this.expiresAt };
  }

  toString(): string {
    return "[EnrolmentGrant]";
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// The origin and path rules live in `./http.js`, shared with the session refresher.

const TIMED_OUT = Symbol("timed_out");

function realSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

// ── the client ───────────────────────────────────────────────────────────────

export interface ConnectClient {
  /** The configured origin, normalised. Every request goes here and nowhere else. */
  readonly origin: string;
  readonly paths: Readonly<ConnectPaths>;
  /** A scanned QR. Refused unless its origin is exactly the configured one. */
  readScanned(raw: string): ReadScanned;
  /** A typed short code, or a pasted connect link (which goes the QR's way). */
  readTyped(raw: string): ReadTyped;
  present(ref: PresentRef, device?: Record<string, unknown>): Promise<PresentResult>;
  waitForConfirmation(opts: { collect: CollectRef; nonce: string; shouldStop?: () => boolean }): Promise<WaitResult>;
  cancel(collect: CollectRef, nonce: string): Promise<CancelResult>;
  /**
   * Runs the caller's enrol function with a `post` that carries the token.
   * Spends the grant on success, or when the server says the token is dead.
   */
  enrol<T>(grant: EnrolmentGrant, enrolFn: (post: EnrolmentPost) => Promise<T>): Promise<EnrolResult<T>>;
}

export function createConnectClient(options: ConnectClientOptions): ConnectClient {
  const allowInsecureLocalhost = options.allowInsecureLocalhost === true;
  const origin = checkOrigin(options.origin, allowInsecureLocalhost);
  const paths: Readonly<ConnectPaths> = Object.freeze({
    connect: checkPath(options.paths?.connect ?? DEFAULT_CONNECT_PATHS.connect),
    complete: checkPath(options.paths?.complete ?? DEFAULT_CONNECT_PATHS.complete),
    cancel: checkPath(options.paths?.cancel ?? DEFAULT_CONNECT_PATHS.cancel),
  });
  const doFetch = options.fetch;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => Date.now());
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const maxPollFailures = Math.max(1, options.maxPollFailures ?? DEFAULT_MAX_POLL_FAILURES);

  function headers(bearer?: string): Record<string, string> {
    const extra = options.headers?.() ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra)) {
      if (k.toLowerCase() !== "authorization") out[k] = v;
    }
    out["Content-Type"] = "application/json";
    if (bearer !== undefined) out["Authorization"] = `Bearer ${bearer}`;
    return out;
  }

  /** POST to the configured origin. `null` means no answer: network failure or timeout. */
  async function post(path: string, body: Record<string, unknown>, bearer?: string): Promise<ConnectResponse | null> {
    const url = `${origin}${checkPath(path)}`;
    let timer: unknown;
    try {
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = timers.setTimeout(() => resolve(TIMED_OUT), requestTimeoutMs);
      });
      const res = await Promise.race([
        doFetch(url, { method: "POST", headers: headers(bearer), body: JSON.stringify(body), redirect: "error" }),
        timeout,
      ]);
      return res === TIMED_OUT ? null : res;
    } catch {
      return null;
    } finally {
      if (timer !== undefined) timers.clearTimeout(timer);
    }
  }

  function readScanned(raw: string): ReadScanned {
    const parsed = parseConnectQr(raw, { allowedOrigins: [origin], allowInsecureLocalhost });
    return parsed.ok ? { ok: true, ref: { ticket: parsed.ticket } } : { ok: false, reason: parsed.reason };
  }

  function readTyped(raw: string): ReadTyped {
    const trimmed = raw.trim();
    if (trimmed.includes("://")) return readScanned(trimmed);
    const code = normaliseManualCode(trimmed);
    if (code !== null) return { ok: true, ref: { code } };
    const compact = trimmed.replace(/[\s-]+/g, "");
    return {
      ok: false,
      reason: compact.length > 0 && compact.length < MANUAL_CODE_LENGTH ? "too_short" : "not_a_code",
    };
  }

  async function present(ref: PresentRef, device?: Record<string, unknown>): Promise<PresentResult> {
    const byCode = "code" in ref;
    const body: Record<string, unknown> = byCode ? { code: ref.code } : { ticket: ref.ticket };
    if (device !== undefined) body["device"] = device;
    // Never retried: a claim the server processed but whose answer was lost
    // would be refused the second time, which reads as "wrong code".
    const res = await post(paths.connect, body);
    if (res === null) return { kind: "offline" };
    if (res.status === 404 || res.status === 410 || (byCode && res.status === 400)) {
      return { kind: byCode ? "wrong_code" : "used_or_expired" };
    }
    if (res.status === 429) return { kind: byCode ? "too_many_codes" : "rate_limited" };
    if (res.status < 200 || res.status > 299) return { kind: "failed", status: res.status };
    const json = await readJsonObject(res);
    if (json === null || typeof json["nonce"] !== "string" || json["nonce"].length === 0) {
      return { kind: "failed", status: res.status };
    }
    let collect: CollectRef;
    if (byCode) {
      const ticketId = json["ticketId"];
      if (typeof ticketId !== "string" || ticketId.length === 0) return { kind: "failed", status: res.status };
      collect = { ticketId };
    } else {
      collect = { ticket: ref.ticket };
    }
    return {
      kind: "ok",
      collect,
      nonce: json["nonce"],
      maskedEmail: typeof json["maskedEmail"] === "string" ? json["maskedEmail"] : null,
      expiresAt: typeof json["expiresAt"] === "string" ? json["expiresAt"] : null,
    };
  }

  async function waitForConfirmation(opts: {
    collect: CollectRef;
    nonce: string;
    shouldStop?: () => boolean;
  }): Promise<WaitResult> {
    const deadline = now() + waitTimeoutMs;
    const stopped = () => opts.shouldStop?.() === true;
    let failures = 0;

    while (!stopped()) {
      if (now() >= deadline) return { kind: "timed_out" };
      const res = await post(paths.complete, { ...opts.collect, nonce: opts.nonce });
      if (stopped()) break;
      if (res === null || res.status >= 500) {
        // One dropped poll on a phone moving between rooms is not the end of
        // it; several in a row is.
        failures += 1;
        if (failures >= maxPollFailures) {
          return res === null ? { kind: "offline" } : { kind: "failed", status: res.status };
        }
      } else {
        failures = 0;
        if (res.status === 200) {
          const json = await readJsonObject(res);
          const token = json?.["enrolmentToken"];
          if (typeof token !== "string" || token.length === 0) return { kind: "failed", status: 200 };
          const expiresIn = json?.["expiresIn"];
          const ttl = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : DEFAULT_ENROLMENT_TTL_S;
          return { kind: "confirmed", grant: new EnrolmentGrant(token, now() + ttl * 1000) };
        }
        if (res.status === 404 || res.status === 410) return { kind: "not_confirmed" };
        if (res.status === 429) return { kind: "rate_limited" };
        if (res.status !== 202) return { kind: "failed", status: res.status };
      }
      await sleep(pollIntervalMs);
    }
    return { kind: "stopped" };
  }

  async function cancel(collect: CollectRef, nonce: string): Promise<CancelResult> {
    // Best effort. If it fails, the ticket still dies on its own, and nothing
    // can be collected without the nonce.
    const res = await post(paths.cancel, { ...collect, nonce });
    return res !== null && res.status >= 200 && res.status <= 299 ? { kind: "sent" } : { kind: "not_sent" };
  }

  async function enrol<T>(
    grant: EnrolmentGrant,
    enrolFn: (post: EnrolmentPost) => Promise<T>,
  ): Promise<EnrolResult<T>> {
    const token = grantTokens.get(grant);
    if (token === undefined || now() >= grant.expiresAt) {
      grantTokens.delete(grant);
      return { kind: "token_expired" };
    }
    const bound: EnrolmentPost = async (path, body) => {
      const res = await post(path, body, token);
      if (res === null) throw new ConnectNetworkError();
      if (res.status < 200 || res.status > 299) {
        const json = await readJsonObject(res);
        const code = json?.["error"];
        throw new ConnectHttpError(res.status, typeof code === "string" ? code : null);
      }
      return (await readJsonObject(res)) ?? {};
    };
    try {
      const value = await enrolFn(bound);
      grantTokens.delete(grant);
      return { kind: "ok", value };
    } catch (error) {
      if (error instanceof MobileAuthError && error.reason === "authentication_cancelled") return { kind: "cancelled" };
      if (error instanceof ConnectNetworkError) return { kind: "offline" };
      if (error instanceof ConnectHttpError) {
        if (error.status === 401) {
          grantTokens.delete(grant);
          return { kind: "token_expired" };
        }
        return { kind: "refused", status: error.status, code: error.code };
      }
      return { kind: "failed", error };
    }
  }

  return { origin, paths, readScanned, readTyped, present, waitForConfirmation, cancel, enrol };
}

// ── the flow, as a pure state machine the screen drives ──────────────────────

export type ConnectProblem =
  | "used_or_expired"
  | "rate_limited"
  | "too_many_codes"
  | "not_confirmed"
  | "timed_out"
  | "token_expired"
  | "offline"
  | "failed"
  | "refused";

export type ConnectState =
  | { step: "start" }
  | { step: "scan"; notice: ConnectCodeRejection | null }
  | { step: "type"; notice: TypedRejection | "wrong_code" | null }
  | { step: "checking"; ref: PresentRef }
  | { step: "confirm"; collect: CollectRef; nonce: string; maskedEmail: string | null }
  | { step: "waiting"; collect: CollectRef; nonce: string }
  | { step: "enrol"; grant: EnrolmentGrant }
  /** Enrolment stopped short but can be tried again with the same grant. */
  | { step: "enrol_paused"; grant: EnrolmentGrant; reason: "cancelled" | "offline" | "failed" }
  | { step: "done" }
  | { step: "problem"; problem: ConnectProblem };

export type ConnectEvent =
  | { type: "scan" }
  | { type: "type" }
  /** Text from the camera (`source: "scan"`) or the code field (`source: "type"`). */
  | { type: "code"; source: "scan" | "type"; raw: string }
  | { type: "presented"; result: PresentResult }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "website"; result: WaitResult }
  | { type: "enrolled"; result: EnrolResult<unknown> }
  | { type: "retry" }
  | { type: "start_again" };

export const initialConnectState: ConnectState = Object.freeze({ step: "start" });

/**
 * The connect flow as a reducer. Bound to a client because reading a scanned
 * code applies that client's origin check: a QR for any other origin never
 * leaves the `scan` step.
 *
 * Effects are the screen's: on entering `checking` call `present`, on
 * `waiting` call `waitForConfirmation`, on `enrol` call `enrol`, and on a
 * `cancel` from `confirm` or `waiting` call `cancel`.
 */
export function createConnectReducer(
  client: Pick<ConnectClient, "readScanned" | "readTyped">,
): (state: ConnectState, event: ConnectEvent) => ConnectState {
  return function connectReducer(state, event) {
    switch (event.type) {
      case "scan":
        return state.step === "start" || state.step === "type" ? { step: "scan", notice: null } : state;
      case "type":
        return state.step === "start" || state.step === "scan" ? { step: "type", notice: null } : state;
      case "code": {
        if (state.step !== "scan" && state.step !== "type") return state;
        if (event.source === "scan") {
          const read = client.readScanned(event.raw);
          return read.ok ? { step: "checking", ref: read.ref } : { step: "scan", notice: read.reason };
        }
        const read = client.readTyped(event.raw);
        return read.ok ? { step: "checking", ref: read.ref } : { step: "type", notice: read.reason };
      }
      case "presented": {
        if (state.step !== "checking") return state;
        const r = event.result;
        if (r.kind === "ok") return { step: "confirm", collect: r.collect, nonce: r.nonce, maskedEmail: r.maskedEmail };
        if (r.kind === "wrong_code") return { step: "type", notice: "wrong_code" };
        return { step: "problem", problem: r.kind };
      }
      case "confirm":
        return state.step === "confirm" ? { step: "waiting", collect: state.collect, nonce: state.nonce } : state;
      case "cancel":
        return state.step === "done" ? state : initialConnectState;
      case "website": {
        if (state.step !== "waiting") return state;
        const r = event.result;
        if (r.kind === "confirmed") return { step: "enrol", grant: r.grant };
        if (r.kind === "stopped") return initialConnectState;
        return { step: "problem", problem: r.kind };
      }
      case "enrolled": {
        if (state.step !== "enrol") return state;
        const r = event.result;
        if (r.kind === "ok") return { step: "done" };
        if (r.kind === "cancelled" || r.kind === "offline" || r.kind === "failed") {
          return { step: "enrol_paused", grant: state.grant, reason: r.kind };
        }
        return { step: "problem", problem: r.kind };
      }
      case "retry":
        return state.step === "enrol_paused" ? { step: "enrol", grant: state.grant } : state;
      case "start_again":
        return initialConnectState;
    }
  };
}
