/**
 * The signed-in session on the phone: an access token and a refresh token,
 * kept in the platform keystore, refreshed when the server says the access
 * token has run out.
 *
 * Two pieces, so storage never depends on the network configuration:
 *
 * - **`createSessionStore`** — load, save, clear, and be told when the session
 *   is cleared. Storage is injected (`SessionStorage`); the Expo adapter is
 *   `@stonedogcode/mobile-auth/expo-session-storage`, over `expo-secure-store`.
 * - **`createSessionRefresher`** — the refresh call, single-flight, and
 *   `authorized(send)`: send once, refresh once on a 401, send again, and end
 *   the session if the server still refuses.
 *
 * ## Rules, each enforced here and pinned by a test
 *
 * - **Tokens are only ever in the injected storage.** This module imports no
 *   store, and the Expo adapter writes only to `expo-secure-store`: no
 *   AsyncStorage, no file, no fallback.
 * - **A token is never logged or serialised by accident.** A loaded `Session`
 *   keeps its tokens in a module-private WeakMap behind getters. It has no own
 *   enumerable properties, `JSON.stringify` gives a redacted placeholder, and
 *   `String()` / Node's inspector give `[Session]`. Errors carry reason codes.
 * - **One refresh at a time.** Concurrent callers share the in-flight refresh,
 *   per store, however many refreshers are built over it. A refresh token is
 *   single use on most servers: two parallel refreshes would make the second
 *   look like a replay.
 * - **A refresh never resurrects a session.** Sign-out or a new sign-in while
 *   a refresh is in flight wins: the refresh's answer is discarded
 *   (`superseded`). Writes and reads are serialised, so a load never sees half
 *   of one session and half of another.
 * - **The refresh token is only sent to the configured origin**: origin +
 *   an origin-relative path, `redirect: "error"`, and extra headers cannot set
 *   `Authorization`.
 * - **No loop.** `authorized` refreshes at most once per call. A refresh that
 *   fails for any reason leaves the original 401, and the session is cleared.
 * - **Every request has a ceiling** (`requestTimeoutMs`, 15 s by default). A
 *   refresh that goes unanswered is `offline`, never a hang.
 */
import { MobileAuthError } from "./errors.js";
import { checkOrigin, checkPath, readJsonObject, timers } from "./http.js";

// ── storage ──────────────────────────────────────────────────────────────────

/**
 * Where the tokens live. `expoSessionStorage` implements it over
 * `expo-secure-store`. A failure should throw a `MobileAuthError` with a reason
 * code; it must never put a value in the error.
 */
export interface SessionStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The storage key for each token. Letters, digits, `.`, `-`, `_` (what `expo-secure-store` accepts). */
export interface SessionKeys {
  accessToken: string;
  refreshToken: string;
}

export const DEFAULT_SESSION_KEYS: Readonly<SessionKeys> = Object.freeze({
  accessToken: "stonedog.session.access-token",
  refreshToken: "stonedog.session.refresh-token",
});

/** A pair of tokens, as the server issues them. */
export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/**
 * Why a session ended. `signed-out`: the person asked. `session-ended`: the
 * server refused the session even after a refresh. Passed in by the caller,
 * because both run the same code and nothing in storage remembers which.
 */
export type SessionEndReason = "signed-out" | "session-ended";

export type SessionClearedListener = (reason: SessionEndReason) => void;

// ── the session value: tokens held where nothing can serialise them ─────────

const sessionTokens = new WeakMap<Session, SessionTokens>();

/**
 * A stored session. Read `accessToken` and `refreshToken` to use them; nothing
 * else exposes them. Spreading it, `JSON.stringify` and `String()` do not.
 */
export class Session implements SessionTokens {
  /** @internal Minted by the session store; not for apps. */
  constructor(tokens: SessionTokens) {
    sessionTokens.set(this, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    Object.freeze(this);
  }

  get accessToken(): string {
    return sessionTokens.get(this)!.accessToken;
  }

  get refreshToken(): string {
    return sessionTokens.get(this)!.refreshToken;
  }

  /** Serialises without the tokens, so persisting or logging state cannot write them. */
  toJSON(): { session: "redacted" } {
    return { session: "redacted" };
  }

  toString(): string {
    return "[Session]";
  }
}

// Node's inspector (console.log in tests and Node tools) reads this symbol.
// Defined off the class so the published declarations name no private symbol.
Object.defineProperty(Session.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value: () => "[Session]",
});

// ── the store ────────────────────────────────────────────────────────────────

export interface SessionStoreOptions {
  storage: SessionStorage;
  /** Storage keys. Keep an app's existing names here, or every upgrade signs everyone out. */
  keys?: Partial<SessionKeys>;
}

export interface SessionStore {
  readonly keys: Readonly<SessionKeys>;
  /** The stored session, or `null` when there is none or only half of one. */
  load(): Promise<Session | null>;
  /** Store a session the server issued. Does not notify `onCleared` listeners. */
  save(tokens: SessionTokens): Promise<Session>;
  /**
   * Remove both tokens. Both removals are attempted even if one fails, the
   * listeners are told either way, and then the first failure is thrown: a
   * keystore that will not give up a token is exactly when the app must stop
   * claiming to be signed in.
   */
  clear(reason?: SessionEndReason): Promise<void>;
  /** Be told when the session is cleared. Returns its own unsubscribe. */
  onCleared(listener: SessionClearedListener): () => void;
}

interface StoreInternals {
  /** Bumped by every `save` and `clear`; a refresh writes only if it has not moved. */
  generation: number;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  snapshot(): Promise<{ session: Session | null; generation: number }>;
  write(tokens: SessionTokens): Promise<void>;
  clearIf(generation: number | null, reason: SessionEndReason): Promise<void>;
  inFlight: Promise<RefreshResult> | null;
}

const internals = new WeakMap<SessionStore, StoreInternals>();

/** What `expo-secure-store` accepts as a key. */
const KEY = /^[A-Za-z0-9._-]+$/;

function checkKeys(keys: Partial<SessionKeys> | undefined): Readonly<SessionKeys> {
  const out = { ...DEFAULT_SESSION_KEYS, ...keys };
  if (!KEY.test(out.accessToken) || !KEY.test(out.refreshToken) || out.accessToken === out.refreshToken) {
    throw new MobileAuthError("invalid_key_name");
  }
  return Object.freeze(out);
}

function isToken(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const storage = options.storage;
  const keys = checkKeys(options.keys);
  const listeners = new Set<SessionClearedListener>();

  // Every read and write runs in turn, so a load never sees a half-written
  // session and a refresh's write cannot interleave with a sign-out.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function read(): Promise<Session | null> {
    const accessToken = await storage.get(keys.accessToken);
    const refreshToken = await storage.get(keys.refreshToken);
    // Half a session is worse than none: the app would look signed in and
    // fail on every call. Treating it as none sends the person to sign in.
    if (!isToken(accessToken) || !isToken(refreshToken)) return null;
    return new Session({ accessToken, refreshToken });
  }

  async function write(tokens: SessionTokens): Promise<void> {
    await storage.set(keys.accessToken, tokens.accessToken);
    await storage.set(keys.refreshToken, tokens.refreshToken);
  }

  function notify(reason: SessionEndReason): void {
    for (const listener of [...listeners]) {
      try {
        listener(reason);
      } catch {
        // A subscriber's own failure must not turn into a failed sign-out.
      }
    }
  }

  /** Clear, unless `generation` is given and the session has changed since. */
  async function clearIf(generation: number | null, reason: SessionEndReason): Promise<void> {
    const outcome = await exclusive(async () => {
      if (generation !== null && state.generation !== generation) return null;
      state.generation += 1;
      return Promise.allSettled([storage.remove(keys.accessToken), storage.remove(keys.refreshToken)]);
    });
    if (outcome === null) return;
    notify(reason);
    const failed = outcome.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  const store: SessionStore = {
    keys,
    load: () => exclusive(read),
    async save(tokens) {
      if (!isToken(tokens?.accessToken) || !isToken(tokens?.refreshToken)) throw new MobileAuthError("invalid_session");
      const copy = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
      await exclusive(async () => {
        state.generation += 1;
        await write(copy);
      });
      return new Session(copy);
    },
    clear: (reason = "signed-out") => clearIf(null, reason),
    onCleared(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const state: StoreInternals = {
    generation: 0,
    exclusive,
    snapshot: () => exclusive(async () => ({ session: await read(), generation: state.generation })),
    write,
    clearIf,
    inFlight: null,
  };
  internals.set(store, state);
  return store;
}

// ── the refresher ────────────────────────────────────────────────────────────

/** The smallest slice of a fetch Response this module reads. */
export interface RefreshResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface RefreshRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /**
   * Always `"error"`: a redirect is never followed, so an open redirect on the
   * server cannot carry the refresh token anywhere else. A fetch that ignores
   * the option still sees a 3xx, which is not success.
   */
  redirect: "error";
  /** An `AbortSignal`, when the runtime has `AbortController`. Aborted at the timeout. */
  signal?: unknown;
}

/** `fetch`, or anything shaped like it. */
export type RefreshFetch = (url: string, init: RefreshRequestInit) => Promise<RefreshResponse>;

export const DEFAULT_REFRESH_PATH = "/api/auth/refresh-token";
export const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

export interface SessionRefresherOptions {
  /** The app's API origin, from its build configuration. */
  origin: string;
  fetch: RefreshFetch;
  /** Origin-relative. Default `DEFAULT_REFRESH_PATH`. */
  path?: string;
  /** Extra headers on the refresh request, e.g. a timezone. Cannot set `Authorization`. */
  headers?: () => Record<string, string>;
  /** Send the current access token as the bearer, as well as the refresh token in the body. Default true. */
  sendAccessToken?: boolean;
  /** Accept `http://localhost` / `127.0.0.1` for a development build. Never in a store build. */
  allowInsecureLocalhost?: boolean;
  /** How long the refresh may go unanswered before it counts as offline. Default 15 000. */
  requestTimeoutMs?: number;
}

export type RefreshResult =
  /** New tokens are stored. */
  | { kind: "refreshed"; session: Session }
  /** Nothing to refresh. */
  | { kind: "no_session" }
  /** The server answered, and not with 2xx. */
  | { kind: "rejected"; status: number }
  /** No answer: network failure, a refused redirect, or the timeout. */
  | { kind: "offline" }
  /** A 2xx without both tokens. */
  | { kind: "invalid_response" }
  /** The session was cleared or replaced while the refresh was in flight; its answer was discarded. */
  | { kind: "superseded" }
  /** Storage refused a read or write. */
  | { kind: "store_error" };

export interface SessionRefresher {
  readonly origin: string;
  readonly path: string;
  /** Refresh now. Concurrent calls share one request. Never throws. */
  refresh(): Promise<RefreshResult>;
  /**
   * Run `send` with the current access token (or `null` with no session). On
   * a 401, refresh once and send again. If the answer is still 401, clear the
   * session with `session-ended`, unless it was replaced or cleared meanwhile.
   * Resolves the last response; rejects only if `send` does.
   */
  authorized<R extends { readonly status: number }>(send: (accessToken: string | null) => Promise<R>): Promise<R>;
}

const TIMED_OUT = Symbol("timed_out");

type AbortControllerLike = { signal: unknown; abort(): void };

function abortController(): AbortControllerLike | null {
  const ctor = (globalThis as unknown as { AbortController?: new () => AbortControllerLike }).AbortController;
  return typeof ctor === "function" ? new ctor() : null;
}

export function createSessionRefresher(store: SessionStore, options: SessionRefresherOptions): SessionRefresher {
  const state = internals.get(store);
  if (state === undefined) throw new MobileAuthError("invalid_session_store");
  const origin = checkOrigin(options.origin, options.allowInsecureLocalhost === true);
  const path = checkPath(options.path ?? DEFAULT_REFRESH_PATH);
  const url = `${origin}${path}`;
  const doFetch = options.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const sendAccessToken = options.sendAccessToken !== false;

  function headers(session: Session): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.headers?.() ?? {})) {
      if (k.toLowerCase() !== "authorization") out[k] = v;
    }
    out["Content-Type"] = "application/json";
    if (sendAccessToken) out["Authorization"] = `Bearer ${session.accessToken}`;
    return out;
  }

  /** `null` means no answer: network failure, refused redirect or timeout. */
  async function post(session: Session): Promise<RefreshResponse | null> {
    const controller = abortController();
    let timer: unknown;
    try {
      const init: RefreshRequestInit = {
        method: "POST",
        headers: headers(session),
        body: JSON.stringify({ refreshToken: session.refreshToken }),
        redirect: "error",
      };
      if (controller !== null) init.signal = controller.signal;
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = timers.setTimeout(() => {
          controller?.abort();
          resolve(TIMED_OUT);
        }, requestTimeoutMs);
      });
      // The race is what guarantees the bound: a fetch that ignores the
      // signal still cannot hang the caller.
      const res = await Promise.race([doFetch(url, init), timeout]);
      return res === TIMED_OUT ? null : res;
    } catch {
      return null;
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function run(): Promise<RefreshResult> {
    let snap: { session: Session | null; generation: number };
    try {
      snap = await state!.snapshot();
    } catch {
      return { kind: "store_error" };
    }
    const { session, generation } = snap;
    if (session === null) return { kind: "no_session" };
    const res = await post(session);
    if (res === null) return { kind: "offline" };
    if (res.status < 200 || res.status > 299) return { kind: "rejected", status: res.status };
    const json = await readJsonObject(res);
    const accessToken = json?.["accessToken"];
    const refreshToken = json?.["refreshToken"];
    if (!isToken(accessToken) || !isToken(refreshToken)) return { kind: "invalid_response" };
    return state!.exclusive(async (): Promise<RefreshResult> => {
      // The same session, continued: this write does NOT bump the generation,
      // deliberately. Callers that sent with the old token and are still
      // refused after this refresh must be able to end the session.
      if (state!.generation !== generation) return { kind: "superseded" };
      try {
        await state!.write({ accessToken, refreshToken });
      } catch {
        return { kind: "store_error" };
      }
      return { kind: "refreshed", session: new Session({ accessToken, refreshToken }) };
    });
  }

  function refresh(): Promise<RefreshResult> {
    if (state!.inFlight !== null) return state!.inFlight;
    const p = run().finally(() => {
      if (state!.inFlight === p) state!.inFlight = null;
    });
    state!.inFlight = p;
    return p;
  }

  async function authorized<R extends { readonly status: number }>(
    send: (accessToken: string | null) => Promise<R>,
  ): Promise<R> {
    const { session, generation } = await state!.snapshot();
    let res = await send(session?.accessToken ?? null);
    if (res.status !== 401) return res;
    const refreshed = await refresh();
    if (refreshed.kind === "refreshed") {
      res = await send(refreshed.session.accessToken);
      if (res.status !== 401) return res;
    }
    // Still refused after one refresh, or the refresh failed: the session is
    // over. Cleared rather than left as a token that cannot work. Not if it
    // was replaced (a new sign-in) or already cleared since this call began.
    await state!.clearIf(generation, "session-ended").catch(() => undefined);
    return res;
  }

  return { origin, path, refresh, authorized };
}
