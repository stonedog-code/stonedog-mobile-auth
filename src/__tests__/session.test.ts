import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { MobileAuthError } from "../errors.js";
import {
  DEFAULT_REFRESH_PATH,
  DEFAULT_REFRESH_TIMEOUT_MS,
  DEFAULT_SESSION_KEYS,
  Session,
  createSessionRefresher,
  createSessionStore,
  type RefreshFetch,
  type RefreshRequestInit,
  type RefreshResponse,
  type SessionEndReason,
  type SessionRefresherOptions,
  type SessionStorage,
  type SessionStore,
} from "../session.js";


/** Source with comments removed: a comment may NAME a banned API to explain the ban. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ORIGIN = "https://app.example.com";
const ACCESS = "access-token-SECRET-a1b2";
const REFRESH = "refresh-token-SECRET-c3d4";
const NEW_ACCESS = "access-token-SECRET-NEW-e5f6";
const NEW_REFRESH = "refresh-token-SECRET-NEW-g7h8";

/** A Map-backed storage, with optional per-call delay and planted failures. */
function memoryStorage(opts: { delayMs?: number } = {}) {
  const map = new Map<string, string>();
  const fail = { get: new Set<string>(), set: new Set<string>(), remove: new Set<string>() };
  const log: string[] = [];
  const pause = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());
  const storage: SessionStorage = {
    async get(key) {
      log.push(`get ${key}`);
      await pause();
      if (fail.get.has(key)) throw new MobileAuthError("store_error");
      return map.get(key) ?? null;
    },
    async set(key, value) {
      log.push(`set ${key}`);
      await pause();
      if (fail.set.has(key)) throw new MobileAuthError("store_error");
      map.set(key, value);
    },
    async remove(key) {
      log.push(`remove ${key}`);
      await pause();
      if (fail.remove.has(key)) throw new MobileAuthError("store_error");
      map.delete(key);
    },
  };
  return { storage, map, fail, log };
}

type Reply = { status: number; body?: unknown } | "network" | "hang" | "bad-json" | ((init: RefreshRequestInit) => Promise<RefreshResponse>);

interface Call {
  url: string;
  init: RefreshRequestInit;
  body: Record<string, unknown>;
}

function scripted(...replies: Reply[]): { fetch: RefreshFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: RefreshFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`unscripted call to ${url}`);
    if (typeof reply === "function") return reply(init);
    if (reply === "network") throw new TypeError("Network request failed");
    if (reply === "hang") return new Promise<RefreshResponse>(() => {});
    if (reply === "bad-json") return { status: 200, json: async () => { throw new SyntaxError("bad"); } };
    return { status: reply.status, json: async () => reply.body ?? null };
  };
  return { fetch, calls };
}

const OK = { status: 200, body: { accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH } };

async function signedIn(storageOpts: { delayMs?: number } = {}) {
  const mem = memoryStorage(storageOpts);
  const store = createSessionStore({ storage: mem.storage });
  await store.save({ accessToken: ACCESS, refreshToken: REFRESH });
  const ended: SessionEndReason[] = [];
  store.onCleared((r) => ended.push(r));
  return { mem, store, ended };
}

function refresher(store: SessionStore, fetch: RefreshFetch, extra: Partial<SessionRefresherOptions> = {}) {
  return createSessionRefresher(store, { origin: ORIGIN, fetch, ...extra });
}

/** A reply the test releases by hand, to hold a refresh in flight. */
function gate() {
  let release!: (r: RefreshResponse) => void;
  const reply = () => new Promise<RefreshResponse>((resolve) => (release = resolve));
  return { reply, release: (r: { status: number; body?: unknown }) => release({ status: r.status, json: async () => r.body }) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ── the session value ────────────────────────────────────────────────────────

describe("Session: tokens are never serialised by accident", () => {
  const s = new Session({ accessToken: ACCESS, refreshToken: REFRESH });

  it("exposes the tokens through getters", () => {
    expect(s.accessToken).toBe(ACCESS);
    expect(s.refreshToken).toBe(REFRESH);
  });

  it("JSON.stringify gives a redacted placeholder, alone or nested", () => {
    expect(JSON.stringify(s)).toBe('{"session":"redacted"}');
    const screenState = { step: "home", session: s, list: [s] };
    const json = JSON.stringify(screenState);
    expect(json).not.toContain(ACCESS);
    expect(json).not.toContain(REFRESH);
  });

  it("has no own enumerable property, so spreading, Object.entries and inspect see nothing", () => {
    expect(Object.keys(s)).toEqual([]);
    expect(Object.getOwnPropertyNames(s)).toEqual([]);
    expect({ ...s }).toEqual({});
    expect(String(s)).toBe("[Session]");
    expect(`${s}`).toBe("[Session]");
    expect(inspect(s)).toBe("[Session]");
    expect(inspect({ s }, { depth: 5, showHidden: true })).not.toContain(ACCESS);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(s)).toBe(true);
  });
});

// ── the store ────────────────────────────────────────────────────────────────

describe("createSessionStore", () => {
  it("round-trips a session under the default keys", async () => {
    const mem = memoryStorage();
    const store = createSessionStore({ storage: mem.storage });
    expect(store.keys).toEqual(DEFAULT_SESSION_KEYS);
    const saved = await store.save({ accessToken: ACCESS, refreshToken: REFRESH });
    expect(saved).toBeInstanceOf(Session);
    expect(mem.map.get(DEFAULT_SESSION_KEYS.accessToken)).toBe(ACCESS);
    expect(mem.map.get(DEFAULT_SESSION_KEYS.refreshToken)).toBe(REFRESH);
    const loaded = await store.load();
    expect(loaded?.accessToken).toBe(ACCESS);
    expect(loaded?.refreshToken).toBe(REFRESH);
  });

  it("keeps an app's existing key names, so an upgrade does not sign everyone out", async () => {
    const mem = memoryStorage();
    mem.map.set("app.accessToken", "a");
    mem.map.set("app.refreshToken", "r");
    const store = createSessionStore({ storage: mem.storage, keys: { accessToken: "app.accessToken", refreshToken: "app.refreshToken" } });
    const loaded = await store.load();
    expect(loaded?.accessToken).toBe("a");
    expect(loaded?.refreshToken).toBe("r");
  });

  it.each([
    [{ accessToken: "has space" }],
    [{ refreshToken: "a/b" }],
    [{ accessToken: "" }],
    [{ accessToken: "same", refreshToken: "same" }],
  ])("refuses key names expo-secure-store would reject, or that collide: %j", (keys) => {
    expect(() => createSessionStore({ storage: memoryStorage().storage, keys })).toThrow(
      new MobileAuthError("invalid_key_name"),
    );
  });

  it("returns null when nothing is stored", async () => {
    const store = createSessionStore({ storage: memoryStorage().storage });
    await expect(store.load()).resolves.toBeNull();
  });

  it("treats half a session, or an empty token, as no session", async () => {
    const mem = memoryStorage();
    const store = createSessionStore({ storage: mem.storage });
    mem.map.set(DEFAULT_SESSION_KEYS.accessToken, "a");
    await expect(store.load()).resolves.toBeNull();
    mem.map.set(DEFAULT_SESSION_KEYS.refreshToken, "");
    await expect(store.load()).resolves.toBeNull();
  });

  it.each([
    [{ accessToken: "", refreshToken: "r" }],
    [{ accessToken: "a", refreshToken: "" }],
    [{ accessToken: 1, refreshToken: "r" }],
    [{ accessToken: "a" }],
    [null],
  ])("refuses to save anything but two non-empty tokens: %j", async (tokens) => {
    const mem = memoryStorage();
    const store = createSessionStore({ storage: mem.storage });
    await expect(store.save(tokens as never)).rejects.toThrow(new MobileAuthError("invalid_session"));
    expect(mem.map.size).toBe(0);
  });

  it("saving does not notify cleared-listeners", async () => {
    const { store, ended } = await signedIn();
    await store.save({ accessToken: "a2", refreshToken: "r2" });
    expect(ended).toEqual([]);
  });

  it("clear removes both tokens and announces 'signed-out' by default", async () => {
    const { mem, store, ended } = await signedIn();
    await store.clear();
    expect(mem.map.size).toBe(0);
    await expect(store.load()).resolves.toBeNull();
    expect(ended).toEqual(["signed-out"]);
    await store.clear("session-ended");
    expect(ended).toEqual(["signed-out", "session-ended"]);
  });

  it("a listener that throws does not fail the sign-out, and unsubscribing stops delivery", async () => {
    const { store, ended } = await signedIn();
    const off = store.onCleared(() => {
      throw new Error("listener bug");
    });
    const seen: string[] = [];
    const offSeen = store.onCleared((r) => seen.push(r));
    await expect(store.clear()).resolves.toBeUndefined();
    off();
    offSeen();
    await store.clear();
    expect(seen).toEqual(["signed-out"]);
    expect(ended).toEqual(["signed-out", "signed-out"]);
  });

  it("still removes the second token when the first removal fails, announces, then reports the failure", async () => {
    const { mem, store, ended } = await signedIn();
    mem.fail.remove.add(DEFAULT_SESSION_KEYS.accessToken);
    await expect(store.clear()).rejects.toThrow(new MobileAuthError("store_error"));
    expect(mem.map.has(DEFAULT_SESSION_KEYS.refreshToken)).toBe(false);
    expect(mem.log).toContain(`remove ${DEFAULT_SESSION_KEYS.refreshToken}`);
    expect(ended).toEqual(["signed-out"]);
  });

  it("serialises reads and writes: a load during a save sees the whole new session, never half", async () => {
    const { store } = await signedIn({ delayMs: 5 });
    const saving = store.save({ accessToken: "a2", refreshToken: "r2" });
    const loaded = await store.load();
    await saving;
    expect(loaded?.accessToken).toBe("a2");
    expect(loaded?.refreshToken).toBe("r2");
  });

  it("keeps going after a failed operation", async () => {
    const { mem, store } = await signedIn();
    mem.fail.get.add(DEFAULT_SESSION_KEYS.accessToken);
    await expect(store.load()).rejects.toThrow(MobileAuthError);
    mem.fail.get.clear();
    await expect(store.load()).resolves.not.toBeNull();
  });
});

// ── the refresher: configuration and the wire ───────────────────────────────

describe("createSessionRefresher: configuration", () => {
  const store = createSessionStore({ storage: memoryStorage().storage });
  const f = scripted().fetch;

  it("normalises the origin and defaults the path", () => {
    const r = createSessionRefresher(store, { origin: "HTTPS://App.Example.com:443/", fetch: f });
    expect(r.origin).toBe(ORIGIN);
    expect(r.path).toBe(DEFAULT_REFRESH_PATH);
    expect(DEFAULT_REFRESH_TIMEOUT_MS).toBe(15_000);
  });

  it.each(["http://app.example.com", "app.example.com", "https://user@app.example.com", "https://app.example.com/api", "http://localhost:3000"])(
    "refuses origin %s",
    (origin) => {
      expect(() => createSessionRefresher(store, { origin, fetch: f })).toThrow(new MobileAuthError("invalid_origin"));
    },
  );

  it("accepts http localhost only behind the development flag", () => {
    expect(createSessionRefresher(store, { origin: "http://localhost:3000", fetch: f, allowInsecureLocalhost: true }).origin).toBe(
      "http://localhost:3000",
    );
  });

  it.each(["//evil.example/refresh", "https://evil.example/refresh", "refresh", "/a/../b", "/refresh?x=1", "/refresh#f"])(
    "refuses path %s",
    (path) => {
      expect(() => createSessionRefresher(store, { origin: ORIGIN, fetch: f, path })).toThrow(new MobileAuthError("invalid_path"));
    },
  );

  it("refuses a store it did not make", () => {
    const fake = { keys: DEFAULT_SESSION_KEYS, load: async () => null } as unknown as SessionStore;
    expect(() => createSessionRefresher(fake, { origin: ORIGIN, fetch: f })).toThrow(new MobileAuthError("invalid_session_store"));
  });
});

describe("refresh", () => {
  it("posts the refresh token to origin + path only, refuses redirects, and stores the new pair", async () => {
    const { mem, store, ended } = await signedIn();
    const s = scripted(OK);
    const r = refresher(store, s.fetch, {
      path: "/api/v2/refresh",
      headers: () => ({ "X-Client-Timezone": "Europe/London", authorization: "Bearer attacker", AUTHORIZATION: "x" }),
    });
    const result = await r.refresh();
    expect(result.kind).toBe("refreshed");
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0]!;
    expect(call.url).toBe(`${ORIGIN}/api/v2/refresh`);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect(call.init.signal).toBeDefined();
    expect(call.init.headers).toEqual({
      "X-Client-Timezone": "Europe/London",
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS}`,
    });
    expect(call.body).toEqual({ refreshToken: REFRESH });
    expect(mem.map.get(DEFAULT_SESSION_KEYS.accessToken)).toBe(NEW_ACCESS);
    expect(mem.map.get(DEFAULT_SESSION_KEYS.refreshToken)).toBe(NEW_REFRESH);
    if (result.kind !== "refreshed") throw new Error(result.kind);
    expect(result.session.accessToken).toBe(NEW_ACCESS);
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
    expect(ended).toEqual([]);
  });

  it("can leave the access token off the refresh request", async () => {
    const { store } = await signedIn();
    const s = scripted(OK);
    await refresher(store, s.fetch, { sendAccessToken: false }).refresh();
    expect(s.calls[0]!.init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("is no_session, with no request, when signed out", async () => {
    const store = createSessionStore({ storage: memoryStorage().storage });
    const s = scripted();
    await expect(refresher(store, s.fetch).refresh()).resolves.toEqual({ kind: "no_session" });
    expect(s.calls).toHaveLength(0);
  });

  it.each([
    [{ status: 401 }, { kind: "rejected", status: 401 }],
    [{ status: 500 }, { kind: "rejected", status: 500 }],
    [{ status: 307 }, { kind: "rejected", status: 307 }],
    ["network" as const, { kind: "offline" }],
    [{ status: 200, body: { accessToken: NEW_ACCESS } }, { kind: "invalid_response" }],
    [{ status: 200, body: { accessToken: "", refreshToken: NEW_REFRESH } }, { kind: "invalid_response" }],
    [{ status: 200, body: "tokens" }, { kind: "invalid_response" }],
    ["bad-json" as const, { kind: "invalid_response" }],
  ])("%j -> %j, leaving the stored session untouched", async (reply, expected) => {
    const { mem, store } = await signedIn();
    await expect(refresher(store, scripted(reply).fetch).refresh()).resolves.toEqual(expected);
    expect(mem.map.get(DEFAULT_SESSION_KEYS.accessToken)).toBe(ACCESS);
    expect(mem.map.get(DEFAULT_SESSION_KEYS.refreshToken)).toBe(REFRESH);
  });

  it("gives up at the timeout, aborts the request, and reports offline", async () => {
    const { store } = await signedIn();
    const s = scripted("hang");
    const started = Date.now();
    await expect(refresher(store, s.fetch, { requestTimeoutMs: 30 }).refresh()).resolves.toEqual({ kind: "offline" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect((s.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
  });

  it("still bounds the request on a runtime with no AbortController", async () => {
    const { store } = await signedIn();
    const saved = globalThis.AbortController;
    // @ts-expect-error -- simulating a runtime without it
    delete globalThis.AbortController;
    try {
      const s = scripted("hang");
      await expect(refresher(store, s.fetch, { requestTimeoutMs: 10 }).refresh()).resolves.toEqual({ kind: "offline" });
      expect("signal" in s.calls[0]!.init).toBe(false);
    } finally {
      globalThis.AbortController = saved;
    }
  });

  it("is store_error when storage refuses the read or the write", async () => {
    const { mem, store } = await signedIn();
    mem.fail.get.add(DEFAULT_SESSION_KEYS.refreshToken);
    await expect(refresher(store, scripted().fetch).refresh()).resolves.toEqual({ kind: "store_error" });
    mem.fail.get.clear();
    mem.fail.set.add(DEFAULT_SESSION_KEYS.accessToken);
    await expect(refresher(store, scripted(OK).fetch).refresh()).resolves.toEqual({ kind: "store_error" });
  });
});

// ── single flight ────────────────────────────────────────────────────────────

describe("refresh: single flight", () => {
  it("concurrent callers share ONE request and one result", async () => {
    const { store } = await signedIn();
    const g = gate();
    const s = scripted(g.reply);
    const r = refresher(store, s.fetch);
    const all = Promise.all([r.refresh(), r.refresh(), r.refresh()]);
    await flush();
    g.release(OK);
    const results = await all;
    expect(s.calls).toHaveLength(1);
    expect(results.map((x) => x.kind)).toEqual(["refreshed", "refreshed", "refreshed"]);
    expect(results[1]).toBe(results[0]);
  });

  it("is shared across refreshers built over the same store", async () => {
    const { store } = await signedIn();
    const g = gate();
    const s = scripted(g.reply);
    const a = refresher(store, s.fetch);
    const b = refresher(store, s.fetch);
    const both = Promise.all([a.refresh(), b.refresh()]);
    await flush();
    g.release(OK);
    await both;
    expect(s.calls).toHaveLength(1);
  });

  it("a settled refresh, failed or not, lets the next one run with the stored tokens", async () => {
    const { store } = await signedIn();
    const s = scripted("network", OK, { status: 200, body: { accessToken: "a3", refreshToken: "r3" } });
    const r = refresher(store, s.fetch);
    expect((await r.refresh()).kind).toBe("offline");
    expect((await r.refresh()).kind).toBe("refreshed");
    expect((await r.refresh()).kind).toBe("refreshed");
    expect(s.calls.map((c) => c.body["refreshToken"])).toEqual([REFRESH, REFRESH, NEW_REFRESH]);
  });

  it("a sign-out while a refresh is in flight wins: the answer is discarded, nothing is resurrected", async () => {
    const { mem, store } = await signedIn();
    const g = gate();
    const r = refresher(store, scripted(g.reply).fetch);
    const pending = r.refresh();
    await flush();
    await store.clear();
    g.release(OK);
    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(mem.map.size).toBe(0);
  });

  it("a new sign-in while a refresh is in flight wins: the new session is kept", async () => {
    const { store } = await signedIn();
    const g = gate();
    const r = refresher(store, scripted(g.reply).fetch);
    const pending = r.refresh();
    await flush();
    await store.save({ accessToken: "fresh-a", refreshToken: "fresh-r" });
    g.release(OK);
    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect((await store.load())?.accessToken).toBe("fresh-a");
  });
});

// ── authorized: send, refresh once on 401, send again, or end the session ──

describe("authorized", () => {
  const status = (n: number) => ({ status: n });

  it("sends with the current access token, and passes a non-401 straight through", async () => {
    const { store, ended } = await signedIn();
    const s = scripted();
    const seen: (string | null)[] = [];
    const res = await refresher(store, s.fetch).authorized(async (t) => (seen.push(t), status(500)));
    expect(res.status).toBe(500);
    expect(seen).toEqual([ACCESS]);
    expect(s.calls).toHaveLength(0);
    expect(ended).toEqual([]);
  });

  it("on a 401: refreshes once, sends again with the NEW token, and keeps the session", async () => {
    const { store, ended } = await signedIn();
    const s = scripted(OK);
    const seen: (string | null)[] = [];
    const replies = [401, 200];
    const res = await refresher(store, s.fetch).authorized(async (t) => (seen.push(t), status(replies.shift()!)));
    expect(res.status).toBe(200);
    expect(seen).toEqual([ACCESS, NEW_ACCESS]);
    expect(s.calls).toHaveLength(1);
    expect(ended).toEqual([]);
  });

  it("a refused refresh clears the session as 'session-ended', once, with no second attempt", async () => {
    const { mem, store, ended } = await signedIn();
    const s = scripted({ status: 401 });
    const seen: (string | null)[] = [];
    const res = await refresher(store, s.fetch).authorized(async (t) => (seen.push(t), status(401)));
    expect(res.status).toBe(401);
    expect(seen).toEqual([ACCESS]);
    expect(s.calls).toHaveLength(1);
    expect(mem.map.size).toBe(0);
    expect(ended).toEqual(["session-ended"]);
  });

  it("still 401 after a successful refresh: clears, and does not refresh again", async () => {
    const { mem, store, ended } = await signedIn();
    const s = scripted(OK);
    const seen: (string | null)[] = [];
    const res = await refresher(store, s.fetch).authorized(async (t) => (seen.push(t), status(401)));
    expect(res.status).toBe(401);
    expect(seen).toEqual([ACCESS, NEW_ACCESS]);
    expect(s.calls).toHaveLength(1);
    expect(mem.map.size).toBe(0);
    expect(ended).toEqual(["session-ended"]);
  });

  it("concurrent 401s share one refresh, and a refused one ends the session once", async () => {
    const { store, ended } = await signedIn();
    const g = gate();
    const s = scripted(g.reply);
    const r = refresher(store, s.fetch);
    const all = Promise.all([1, 2, 3].map(() => r.authorized(async () => status(401))));
    await flush();
    await flush();
    g.release({ status: 401 });
    const results = await all;
    expect(results.map((x) => x.status)).toEqual([401, 401, 401]);
    expect(s.calls).toHaveLength(1);
    expect(ended).toEqual(["session-ended"]);
  });

  it("concurrent 401s share one refresh, then all retry with the new token", async () => {
    const { store } = await signedIn();
    const g = gate();
    const s = scripted(g.reply);
    const r = refresher(store, s.fetch);
    const all = Promise.all([1, 2, 3].map(() => r.authorized(async (t) => status(t === NEW_ACCESS ? 200 : 401))));
    await flush();
    await flush();
    g.release(OK);
    expect((await all).map((x) => x.status)).toEqual([200, 200, 200]);
    expect(s.calls).toHaveLength(1);
  });

  it("an offline refresh also ends a refused session (the 401 stands)", async () => {
    const { store, ended } = await signedIn();
    await refresher(store, scripted("network").fetch).authorized(async () => status(401));
    expect(ended).toEqual(["session-ended"]);
  });

  it("with no session: sends null, and a 401 ends it as session-ended", async () => {
    const store = createSessionStore({ storage: memoryStorage().storage });
    const ended: string[] = [];
    store.onCleared((r) => ended.push(r));
    const seen: (string | null)[] = [];
    const s = scripted();
    await refresher(store, s.fetch).authorized(async (t) => (seen.push(t), status(401)));
    expect(seen).toEqual([null]);
    expect(s.calls).toHaveLength(0);
    expect(ended).toEqual(["session-ended"]);
  });

  it("does not clear a session that was replaced while the request was out", async () => {
    const { store, ended } = await signedIn();
    const r = refresher(store, scripted({ status: 401 }).fetch);
    await r.authorized(async () => {
      await store.save({ accessToken: "fresh-a", refreshToken: "fresh-r" });
      return status(401);
    });
    expect((await store.load())?.accessToken).toBe("fresh-a");
    expect(ended).toEqual([]);
  });

  it("a send that throws propagates, with no refresh and no clear", async () => {
    const { store, ended } = await signedIn();
    const s = scripted();
    await expect(
      refresher(store, s.fetch).authorized(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(s.calls).toHaveLength(0);
    expect(ended).toEqual([]);
  });

  it("a keystore that will not clear is swallowed: the 401 is still returned and the UI still told", async () => {
    const { mem, store, ended } = await signedIn();
    mem.fail.remove.add(DEFAULT_SESSION_KEYS.accessToken);
    const res = await refresher(store, scripted({ status: 401 }).fetch).authorized(async () => status(401));
    expect(res.status).toBe(401);
    expect(ended).toEqual(["session-ended"]);
  });
});

// ── the module boundary ──────────────────────────────────────────────────────

describe("session module", () => {
  it("imports no store, writes nothing to the console, and uses nothing Hermes lacks", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "session.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./errors.js", "./http.js"]);
    expect(code(src)).not.toMatch(/SecureStore|AsyncStorage|localStorage|console\./);
    expect(code(src)).not.toMatch(/\bBuffer\b|new URL\(|URLSearchParams|TextEncoder/);
  });

  it("no error it throws carries a token", async () => {
    const { mem, store } = await signedIn();
    mem.fail.remove.add(DEFAULT_SESSION_KEYS.accessToken);
    const errors: unknown[] = [];
    await store.clear().catch((e: unknown) => errors.push(e));
    await store.save({ accessToken: ACCESS, refreshToken: "" }).catch((e: unknown) => errors.push(e));
    expect(errors).toHaveLength(2);
    for (const e of errors) {
      expect(String(e)).not.toMatch(/SECRET/);
      expect(JSON.stringify(e)).not.toMatch(/SECRET/);
    }
  });
});

describe("the comment stripper the boundary tests rely on", () => {
  it("removes comments and keeps code, including a // inside a URL", () => {
    expect(code("/* AsyncStorage */ const a = 1; // console.log\nconst u = \"https://x\";")).toBe(
      ' const a = 1; \nconst u = "https://x";',
    );
    expect(code("const s = AsyncStorage;")).toMatch(/AsyncStorage/);
  });
});
