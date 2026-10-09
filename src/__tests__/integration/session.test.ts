/**
 * Integration tier: the session store and refresher against a real HTTP server
 * with a rotating refresh token, over real sockets with Node's own fetch. The
 * unit tier's scripted fetch agrees with whatever it is told; this proves the
 * refresh request is one a server can route, parse and answer, that the
 * single-flight holds when the requests are real, and that a real redirect is
 * not followed.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSessionRefresher, createSessionStore, type SessionStorage } from "../../session.js";

const FIRST_ACCESS = "access-SECRET-0";
const FIRST_REFRESH = "refresh-SECRET-0";

interface Seen {
  path: string;
  authorization: string | undefined;
  timezone: string | undefined;
  body: Record<string, unknown>;
}

/**
 * A refresh endpoint with single-use rotation: each refresh token works once
 * and is replaced. `/api/data` answers 200 only to the current access token.
 */
function authServer(opts: { redirectTo?: string; refuse?: boolean; hang?: boolean; latencyMs?: number } = {}) {
  const seen: Seen[] = [];
  let generation = 0;
  let access = FIRST_ACCESS;
  let refresh = FIRST_REFRESH;
  const hung: import("node:http").ServerResponse[] = [];

  const read = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let s = "";
      req.on("data", (d: Buffer) => (s += d.toString()));
      req.on("end", () => resolve(s ? (JSON.parse(s) as Record<string, unknown>) : {}));
    });

  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? "";
    const tz = req.headers["x-client-timezone"];
    seen.push({ path, authorization: req.headers.authorization, timezone: typeof tz === "string" ? tz : undefined, body });
    const send = (status: number, json?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    if (path === "/api/auth/refresh-token" && req.method === "POST") {
      if (opts.hang) return void hung.push(res);
      if (opts.redirectTo) {
        res.writeHead(307, { Location: opts.redirectTo });
        return res.end();
      }
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      if (opts.refuse || body["refreshToken"] !== refresh) return send(401, { error: "refresh_refused" });
      generation += 1;
      access = `access-SECRET-${generation}`;
      refresh = `refresh-SECRET-${generation}`;
      return send(200, { accessToken: access, refreshToken: refresh });
    }
    if (path === "/api/data") {
      return req.headers.authorization === `Bearer ${access}` ? send(200, { ok: true }) : send(401);
    }
    return send(404);
  });

  return {
    seen,
    refreshes: () => seen.filter((s) => s.path === "/api/auth/refresh-token"),
    /** Expire the current access token, as time would. */
    expireAccess: () => {
      access = `expired-${generation}-${Math.random()}`;
    },
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const r of hung) r.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function memoryStorage(): { storage: SessionStorage; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => void map.set(k, v),
      remove: async (k) => void map.delete(k),
    },
  };
}

async function setUp(srvOpts: Parameters<typeof authServer>[0] = {}) {
  const srv = authServer(srvOpts);
  const origin = await srv.start();
  const mem = memoryStorage();
  const store = createSessionStore({ storage: mem.storage });
  await store.save({ accessToken: FIRST_ACCESS, refreshToken: FIRST_REFRESH });
  const ended: string[] = [];
  store.onCleared((r) => ended.push(r));
  const refresher = createSessionRefresher(store, {
    origin,
    allowInsecureLocalhost: true,
    fetch: (url, init) => fetch(url, init as Parameters<typeof fetch>[1]),
    headers: () => ({ "X-Client-Timezone": "Europe/London" }),
    requestTimeoutMs: 2000,
  });
  const getData = () =>
    refresher.authorized((token) => fetch(`${origin}/api/data`, { headers: { Authorization: `Bearer ${token ?? ""}` } }));
  return { srv, origin, mem, store, ended, refresher, getData };
}

describe("session refresh against a rotating-token server (integration)", () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (stops.length) await stops.pop()!();
  });

  it("an expired access token is refreshed once, the rotated pair is stored, and the request succeeds", async () => {
    const t = await setUp();
    stops.push(t.srv.stop);
    t.srv.expireAccess();
    const res = await t.getData();
    expect(res.status).toBe(200);
    expect(t.srv.refreshes()).toEqual([
      {
        path: "/api/auth/refresh-token",
        authorization: `Bearer ${FIRST_ACCESS}`,
        timezone: "Europe/London",
        body: { refreshToken: FIRST_REFRESH },
      },
    ]);
    const s = await t.store.load();
    expect(s?.accessToken).toBe("access-SECRET-1");
    expect(s?.refreshToken).toBe("refresh-SECRET-1");
    expect(t.ended).toEqual([]);
  });

  it("five screens loading at once with an expired token make ONE refresh, and none is a replay", async () => {
    const t = await setUp({ latencyMs: 30 });
    stops.push(t.srv.stop);
    t.srv.expireAccess();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => t.getData()));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(t.srv.refreshes()).toHaveLength(1);
    expect(t.ended).toEqual([]);
  });

  it("a refused refresh ends the session once, clears both tokens, and does not try again", async () => {
    const t = await setUp({ refuse: true });
    stops.push(t.srv.stop);
    t.srv.expireAccess();
    const results = await Promise.all([t.getData(), t.getData()]);
    expect(results.map((r) => r.status)).toEqual([401, 401]);
    expect(t.srv.refreshes()).toHaveLength(1);
    expect(t.mem.map.size).toBe(0);
    expect(t.ended).toEqual(["session-ended"]);
    // Signed out now: the next request does not refresh at all.
    await t.getData();
    expect(t.srv.refreshes()).toHaveLength(1);
  });

  it("a redirect from the refresh endpoint is not followed: the refresh token goes nowhere else", async () => {
    const elsewhere = authServer();
    const elsewhereOrigin = await elsewhere.start();
    stops.push(elsewhere.stop);
    const t = await setUp({ redirectTo: `${elsewhereOrigin}/api/auth/refresh-token` });
    stops.push(t.srv.stop);
    await expect(t.refresher.refresh()).resolves.toEqual({ kind: "offline" });
    expect(elsewhere.seen).toEqual([]);
    expect((await t.store.load())?.refreshToken).toBe(FIRST_REFRESH);
  });

  it("an unanswered refresh ends at the ceiling as offline", async () => {
    const srv = authServer({ hang: true });
    const origin = await srv.start();
    stops.push(srv.stop);
    const store = createSessionStore({ storage: memoryStorage().storage });
    await store.save({ accessToken: FIRST_ACCESS, refreshToken: FIRST_REFRESH });
    const r = createSessionRefresher(store, {
      origin,
      allowInsecureLocalhost: true,
      fetch: (url, init) => fetch(url, init as Parameters<typeof fetch>[1]),
      requestTimeoutMs: 100,
    });
    const started = Date.now();
    await expect(r.refresh()).resolves.toEqual({ kind: "offline" });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
