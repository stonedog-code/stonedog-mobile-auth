import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConnectHttpError,
  DEFAULT_CONNECT_PATHS,
  EnrolmentGrant,
  createConnectClient,
  createConnectReducer,
  initialConnectState,
  type ConnectClientOptions,
  type ConnectEvent,
  type ConnectFetch,
  type ConnectRequestInit,
  type ConnectResponse,
  type ConnectState,
  type EnrolmentPost,
} from "../connect-client.js";
import { MobileAuthError } from "../errors.js";

const ORIGIN = "https://app.example.com";
const TICKET = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"; // 43 chars
const QR = `${ORIGIN}/connect#t=${TICKET}`;
const TOKEN = "enrolment-token-SECRET-7f3a9c";

type Reply = { status: number; body?: unknown } | "network" | "hang" | "bad-json";

interface Call {
  url: string;
  init: ConnectRequestInit;
  body: Record<string, unknown>;
}

/** A scripted fetch: answers each call with the next reply, and records every call. */
function scripted(...replies: Reply[]): { fetch: ConnectFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: ConnectFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`unscripted call to ${url}`);
    if (reply === "network") throw new TypeError("Network request failed");
    if (reply === "hang") return new Promise<ConnectResponse>(() => {});
    if (reply === "bad-json") {
      return { status: 200, json: async () => { throw new SyntaxError("bad json"); } };
    }
    return { status: reply.status, json: async () => reply.body ?? null };
  };
  return { fetch, calls };
}

/** A clock the sleeps advance, so a two-minute wait runs instantly. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function client(fetch: ConnectFetch, extra: Partial<ConnectClientOptions> = {}) {
  const clock = fakeClock();
  return createConnectClient({ origin: ORIGIN, fetch, now: clock.now, sleep: clock.sleep, ...extra });
}

async function confirmedGrant(extra: Partial<ConnectClientOptions> = {}, expiresIn: unknown = 300) {
  const s = scripted({ status: 200, body: { enrolmentToken: TOKEN, expiresIn } });
  const c = client(s.fetch, extra);
  const r = await c.waitForConfirmation({ collect: { ticket: TICKET }, nonce: "n1" });
  if (r.kind !== "confirmed") throw new Error(`expected confirmed, got ${r.kind}`);
  return r.grant;
}

// ── configuration ────────────────────────────────────────────────────────────

describe("createConnectClient: configuration", () => {
  it("normalises the origin and defaults the paths to the documented routes", () => {
    const c = client(scripted().fetch, { origin: " HTTPS://App.Example.com:443/ " });
    expect(c.origin).toBe(ORIGIN);
    expect(c.paths).toEqual(DEFAULT_CONNECT_PATHS);
  });

  it("uses overridden paths", async () => {
    const s = scripted({ status: 200, body: { nonce: "n" } });
    const c = client(s.fetch, { paths: { connect: "/v2/link" } });
    await c.present({ ticket: TICKET });
    expect(s.calls[0]!.url).toBe(`${ORIGIN}/v2/link`);
    expect(c.paths.complete).toBe(DEFAULT_CONNECT_PATHS.complete);
  });

  it.each(["http://app.example.com", "app.example.com", "https://user@evil.test", "ftp://x.test", "https://x.test/path", ""])(
    "refuses origin %j",
    (origin) => {
      expect(() => client(scripted().fetch, { origin })).toThrow(new MobileAuthError("invalid_origin"));
    },
  );

  it("accepts http://localhost only with allowInsecureLocalhost", () => {
    expect(() => client(scripted().fetch, { origin: "http://localhost:3000" })).toThrow(MobileAuthError);
    const c = client(scripted().fetch, { origin: "http://localhost:3000", allowInsecureLocalhost: true });
    expect(c.origin).toBe("http://localhost:3000");
    expect(c.readScanned(`http://localhost:3000/connect#t=${TICKET}`)).toEqual({ ok: true, ref: { ticket: TICKET } });
  });

  it.each(["//evil.test/x", "https://evil.test/x", "relative", "/a/../b", "/a?x=1", "/a#f", "/a b"])(
    "refuses path %j, which could carry a request off the configured origin",
    (bad) => {
      expect(() => client(scripted().fetch, { paths: { complete: bad } })).toThrow(new MobileAuthError("invalid_path"));
    },
  );
});

// ── reading codes ────────────────────────────────────────────────────────────

describe("readScanned / readTyped", () => {
  const c = client(scripted().fetch);

  it("accepts the configured origin's QR", () => {
    expect(c.readScanned(QR)).toEqual({ ok: true, ref: { ticket: TICKET } });
  });

  it("refuses a QR for any other origin, before anything is sent", () => {
    const s = scripted();
    const c2 = client(s.fetch);
    expect(c2.readScanned(`https://app.example.com.evil.test/connect#t=${TICKET}`)).toEqual({
      ok: false,
      reason: "origin_not_allowed",
    });
    expect(c2.readScanned(`https://evil.test/connect#t=${TICKET}`)).toEqual({ ok: false, reason: "origin_not_allowed" });
    expect(s.calls).toHaveLength(0);
  });

  it("passes other QR rejections through", () => {
    expect(c.readScanned("hello")).toEqual({ ok: false, reason: "not_a_url" });
  });

  it("reads a typed code forgivingly", () => {
    expect(c.readTyped(" abcd-efgh ")).toEqual({ ok: true, ref: { code: "ABCDEFGH" } });
  });

  it("says too_short for a partial code and not_a_code otherwise", () => {
    expect(c.readTyped("abc")).toEqual({ ok: false, reason: "too_short" });
    expect(c.readTyped("")).toEqual({ ok: false, reason: "not_a_code" });
    expect(c.readTyped("abcdefghijk")).toEqual({ ok: false, reason: "not_a_code" });
  });

  it("sends a pasted link the QR's way, origin check included", () => {
    expect(c.readTyped(QR)).toEqual({ ok: true, ref: { ticket: TICKET } });
    expect(c.readTyped(`https://evil.test/connect#t=${TICKET}`)).toEqual({ ok: false, reason: "origin_not_allowed" });
  });
});

// ── present ──────────────────────────────────────────────────────────────────

describe("present", () => {
  it("happy path by ticket: posts {ticket, device} to the configured origin", async () => {
    const s = scripted({ status: 200, body: { maskedEmail: "e***@e***.org", nonce: "n1", expiresAt: "2026-01-01T00:00:00Z" } });
    const c = client(s.fetch, { headers: () => ({ "X-Client-Timezone": "UTC" }) });
    const r = await c.present({ ticket: TICKET }, { model: "Pixel" });
    expect(r).toEqual({
      kind: "ok",
      collect: { ticket: TICKET },
      nonce: "n1",
      maskedEmail: "e***@e***.org",
      expiresAt: "2026-01-01T00:00:00Z",
    });
    expect(s.calls[0]!.url).toBe(`${ORIGIN}${DEFAULT_CONNECT_PATHS.connect}`);
    expect(s.calls[0]!.init.method).toBe("POST");
    expect(s.calls[0]!.body).toEqual({ ticket: TICKET, device: { model: "Pixel" } });
    expect(s.calls[0]!.init.headers).toEqual({ "X-Client-Timezone": "UTC", "Content-Type": "application/json" });
  });

  it("happy path by code: posts {code} and collects by the returned ticketId", async () => {
    const s = scripted({ status: 201, body: { nonce: "n2", ticketId: "row-1" } });
    const r = await client(s.fetch).present({ code: "ABCDEFGH" });
    expect(r).toEqual({ kind: "ok", collect: { ticketId: "row-1" }, nonce: "n2", maskedEmail: null, expiresAt: null });
    expect(s.calls[0]!.body).toEqual({ code: "ABCDEFGH" });
  });

  it.each([
    [{ ticket: TICKET }, 404, "used_or_expired"],
    [{ ticket: TICKET }, 410, "used_or_expired"],
    [{ ticket: TICKET }, 429, "rate_limited"],
    [{ code: "ABCDEFGH" }, 404, "wrong_code"],
    [{ code: "ABCDEFGH" }, 410, "wrong_code"],
    [{ code: "ABCDEFGH" }, 400, "wrong_code"],
    [{ code: "ABCDEFGH" }, 429, "too_many_codes"],
  ] as const)("%j answered %i is %s", async (ref, status, kind) => {
    const r = await client(scripted({ status }).fetch).present(ref);
    expect(r).toEqual({ kind });
  });

  it.each([
    [{ status: 400 }, 400],
    [{ status: 500 }, 500],
    [{ status: 200, body: { maskedEmail: "x" } }, 200],
    [{ status: 200, body: { nonce: "" } }, 200],
    [{ status: 200, body: "nope" }, 200],
    ["bad-json", 200],
  ] as const)("a %j answer to a ticket is failed", async (reply, status) => {
    expect(await client(scripted(reply as Reply).fetch).present({ ticket: TICKET })).toEqual({ kind: "failed", status });
  });

  it("a typed code whose answer has no ticketId is failed (nothing to collect by)", async () => {
    const r = await client(scripted({ status: 200, body: { nonce: "n" } }).fetch).present({ code: "ABCDEFGH" });
    expect(r).toEqual({ kind: "failed", status: 200 });
  });

  it("a network failure is offline, and the claim is never retried", async () => {
    const s = scripted("network", { status: 200, body: { nonce: "n" } });
    expect(await client(s.fetch).present({ ticket: TICKET })).toEqual({ kind: "offline" });
    expect(s.calls).toHaveLength(1);
  });

  it("a request that runs past requestTimeoutMs is offline", async () => {
    const s = scripted("hang");
    const r = await client(s.fetch, { requestTimeoutMs: 5 }).present({ ticket: TICKET });
    expect(r).toEqual({ kind: "offline" });
  });
});

// ── waiting for the website ──────────────────────────────────────────────────

describe("waitForConfirmation", () => {
  it("202 then 200 hands over a grant, polling at the interval", async () => {
    const s = scripted({ status: 202 }, { status: 202 }, { status: 200, body: { enrolmentToken: TOKEN, expiresIn: 60 } });
    const clock = fakeClock();
    const sleeps: number[] = [];
    const c = createConnectClient({
      origin: ORIGIN,
      fetch: s.fetch,
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        await clock.sleep(ms);
      },
      pollIntervalMs: 1500,
    });
    const r = await c.waitForConfirmation({ collect: { ticket: TICKET }, nonce: "n1" });
    expect(r.kind).toBe("confirmed");
    if (r.kind !== "confirmed") return;
    expect(r.grant).toBeInstanceOf(EnrolmentGrant);
    expect(r.grant.expiresAt).toBe(clock.now() + 60_000);
    expect(r.grant.spent).toBe(false);
    expect(sleeps).toEqual([1500, 1500]);
    expect(s.calls.map((x) => x.url)).toEqual(Array(3).fill(`${ORIGIN}${DEFAULT_CONNECT_PATHS.complete}`));
    expect(s.calls[0]!.body).toEqual({ ticket: TICKET, nonce: "n1" });
  });

  it("collects a typed code by {ticketId, nonce}", async () => {
    const s = scripted({ status: 404 });
    await client(s.fetch).waitForConfirmation({ collect: { ticketId: "row-1" }, nonce: "n2" });
    expect(s.calls[0]!.body).toEqual({ ticketId: "row-1", nonce: "n2" });
  });

  it("defaults the grant lifetime when expiresIn is missing or nonsense", async () => {
    for (const expiresIn of [undefined, -1, "300"]) {
      const clock = fakeClock();
      const s = scripted({ status: 200, body: { enrolmentToken: TOKEN, expiresIn } });
      const r = await createConnectClient({ origin: ORIGIN, fetch: s.fetch, now: clock.now }).waitForConfirmation({
        collect: { ticket: TICKET },
        nonce: "n",
      });
      expect(r.kind === "confirmed" && r.grant.expiresAt).toBe(clock.now() + 300_000);
    }
  });

  it.each([
    [404, "not_confirmed"],
    [410, "not_confirmed"],
    [429, "rate_limited"],
  ] as const)("%i ends the wait as %s", async (status, kind) => {
    const r = await client(scripted({ status: 202 }, { status }).fetch).waitForConfirmation({
      collect: { ticket: TICKET },
      nonce: "n",
    });
    expect(r).toEqual({ kind });
  });

  it.each([
    [{ status: 418 }, 418],
    [{ status: 200, body: {} }, 200],
    [{ status: 200, body: { enrolmentToken: "" } }, 200],
    ["bad-json", 200],
  ] as const)("a %j answer is failed", async (reply, status) => {
    const r = await client(scripted(reply as Reply).fetch).waitForConfirmation({ collect: { ticket: TICKET }, nonce: "n" });
    expect(r).toEqual({ kind: "failed", status });
  });

  it("rides out fewer than maxPollFailures dropped polls, and a success resets the count", async () => {
    const s = scripted("network", "network", { status: 202 }, "hang", "network", {
      status: 200,
      body: { enrolmentToken: TOKEN },
    });
    const r = await client(s.fetch, { maxPollFailures: 3, requestTimeoutMs: 5 }).waitForConfirmation({
      collect: { ticket: TICKET },
      nonce: "n",
    });
    expect(r.kind).toBe("confirmed");
    expect(s.calls).toHaveLength(6);
  });

  it("gives up as offline at the retry limit", async () => {
    const s = scripted("network", "network", "network", { status: 200, body: { enrolmentToken: TOKEN } });
    const r = await client(s.fetch).waitForConfirmation({ collect: { ticket: TICKET }, nonce: "n" });
    expect(r).toEqual({ kind: "offline" });
    expect(s.calls).toHaveLength(3);
  });

  it("counts 5xx toward the same limit, and reports the last status", async () => {
    const s = scripted({ status: 502 }, { status: 503 });
    const r = await client(s.fetch, { maxPollFailures: 2 }).waitForConfirmation({ collect: { ticket: TICKET }, nonce: "n" });
    expect(r).toEqual({ kind: "failed", status: 503 });
  });

  it("times out at waitTimeoutMs", async () => {
    const s = scripted(...Array<Reply>(10).fill({ status: 202 }));
    const r = await client(s.fetch, { pollIntervalMs: 1000, waitTimeoutMs: 3000 }).waitForConfirmation({
      collect: { ticket: TICKET },
      nonce: "n",
    });
    expect(r).toEqual({ kind: "timed_out" });
    expect(s.calls).toHaveLength(3);
  });

  it("stops when asked, before or after a poll, without acting on the answer", async () => {
    const s1 = scripted();
    expect(await client(s1.fetch).waitForConfirmation({ collect: { ticket: TICKET }, nonce: "n", shouldStop: () => true })).toEqual({
      kind: "stopped",
    });
    expect(s1.calls).toHaveLength(0);

    let stop = false;
    const s2: ConnectFetch = async () => {
      stop = true;
      return { status: 200, json: async () => ({ enrolmentToken: TOKEN }) };
    };
    expect(await client(s2).waitForConfirmation({ collect: { ticket: TICKET }, nonce: "n", shouldStop: () => stop })).toEqual({
      kind: "stopped",
    });
  });

  it("uses real timers when no sleep or clock is given", async () => {
    const s = scripted({ status: 202 }, { status: 404 });
    const c = createConnectClient({ origin: ORIGIN, fetch: s.fetch, pollIntervalMs: 1 });
    expect(await c.waitForConfirmation({ collect: { ticket: TICKET }, nonce: "n" })).toEqual({ kind: "not_confirmed" });
  });
});

// ── cancel ───────────────────────────────────────────────────────────────────

describe("cancel", () => {
  it("posts {collect, nonce} to the cancel route", async () => {
    const s = scripted({ status: 204 });
    expect(await client(s.fetch).cancel({ ticketId: "row-1" }, "n")).toEqual({ kind: "sent" });
    expect(s.calls[0]!.url).toBe(`${ORIGIN}${DEFAULT_CONNECT_PATHS.cancel}`);
    expect(s.calls[0]!.body).toEqual({ ticketId: "row-1", nonce: "n" });
  });

  it("is best effort: a failure is reported, never thrown", async () => {
    expect(await client(scripted("network").fetch).cancel({ ticket: TICKET }, "n")).toEqual({ kind: "not_sent" });
    expect(await client(scripted({ status: 500 }).fetch).cancel({ ticket: TICKET }, "n")).toEqual({ kind: "not_sent" });
  });
});

// ── enrol ────────────────────────────────────────────────────────────────────

describe("enrol", () => {
  it("hands the enrol function a post bound to the origin, carrying the token as the bearer", async () => {
    const grant = await confirmedGrant();
    const s = scripted({ status: 200, body: { keyId: "k1", accessToken: "a", refreshToken: "r" } });
    const c = client(s.fetch, { headers: () => ({ Authorization: "Bearer someone-else", "X-A": "1" }) });
    const r = await c.enrol(grant, async (post) => post("/api/mobile/v1/devices/key", { publicKey: "PEM" }));
    expect(r).toEqual({ kind: "ok", value: { keyId: "k1", accessToken: "a", refreshToken: "r" } });
    expect(s.calls[0]!.url).toBe(`${ORIGIN}/api/mobile/v1/devices/key`);
    expect(s.calls[0]!.init.headers).toEqual({
      "X-A": "1",
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(s.calls[0]!.body).toEqual({ publicKey: "PEM" });
  });

  it("never follows a redirect, and a 3xx is not success", async () => {
    const grant = await confirmedGrant();
    const s = scripted({ status: 307 });
    const r = await client(s.fetch).enrol(grant, (post) => post("/k", {}));
    expect(s.calls[0]!.init.redirect).toBe("error");
    expect(r).toEqual({ kind: "refused", status: 307, code: null });
  });

  it("spends the grant on success: a second use never reaches the server", async () => {
    const grant = await confirmedGrant();
    const s = scripted({ status: 200, body: {} });
    const c = client(s.fetch);
    expect((await c.enrol(grant, (post) => post("/k", {}))).kind).toBe("ok");
    expect(grant.spent).toBe(true);
    let called = 0;
    const enrolFn = async () => {
      called += 1;
    };
    expect(await c.enrol(grant, enrolFn)).toEqual({ kind: "token_expired" });
    expect(called).toBe(0);
    expect(s.calls).toHaveLength(1);
  });

  it("refuses a grant past its lifetime without sending it", async () => {
    const clock = fakeClock();
    const grant = await confirmedGrant({ now: clock.now }, 60);
    clock.advance(60_000);
    const s = scripted();
    const c = createConnectClient({ origin: ORIGIN, fetch: s.fetch, now: clock.now });
    expect(await c.enrol(grant, (post) => post("/k", {}))).toEqual({ kind: "token_expired" });
    expect(s.calls).toHaveLength(0);
    expect(grant.spent).toBe(true);
  });

  it("a 401 is token_expired and spends the grant", async () => {
    const grant = await confirmedGrant();
    expect(await client(scripted({ status: 401 }).fetch).enrol(grant, (post) => post("/k", {}))).toEqual({
      kind: "token_expired",
    });
    expect(grant.spent).toBe(true);
  });

  it("any other refusal carries the status and the server's error code for the app to map", async () => {
    const grant = await confirmedGrant();
    const c = client(scripted({ status: 403, body: { error: "limit_reached" } }, { status: 500, body: "x" }).fetch);
    expect(await c.enrol(grant, (post) => post("/k", {}))).toEqual({ kind: "refused", status: 403, code: "limit_reached" });
    expect(await c.enrol(grant, (post) => post("/k", {}))).toEqual({ kind: "refused", status: 500, code: null });
    expect(grant.spent).toBe(false);
  });

  it("a network failure is offline; a dismissed fingerprint is cancelled; both keep the grant live", async () => {
    const grant = await confirmedGrant();
    expect(await client(scripted("network").fetch).enrol(grant, (post) => post("/k", {}))).toEqual({ kind: "offline" });
    expect(
      await client(scripted().fetch).enrol(grant, async () => {
        throw new MobileAuthError("authentication_cancelled");
      }),
    ).toEqual({ kind: "cancelled" });
    expect(grant.spent).toBe(false);
  });

  it("anything else the enrol function throws is failed, with the error", async () => {
    const grant = await confirmedGrant();
    const boom = new Error("boom");
    expect(
      await client(scripted().fetch).enrol(grant, async () => {
        throw boom;
      }),
    ).toEqual({ kind: "failed", error: boom });
  });

  it("a 2xx with no JSON body resolves to {}", async () => {
    const grant = await confirmedGrant();
    expect(await client(scripted("bad-json").fetch).enrol(grant, (post) => post("/k", {}))).toEqual({ kind: "ok", value: {} });
  });

  it("the token is never sent anywhere but the configured origin, whatever path the enrol function names", async () => {
    const grant = await confirmedGrant();
    for (const path of ["//evil.test/steal", "https://evil.test/steal", "/a/../../x"]) {
      const s = scripted({ status: 200, body: {} });
      const r = await client(s.fetch).enrol(grant, (post) => post(path, {}));
      expect(r.kind).toBe("failed");
      expect(r.kind === "failed" && r.error).toEqual(new MobileAuthError("invalid_path"));
      expect(s.calls).toHaveLength(0);
    }
  });

  it("ConnectHttpError carries no body text in its message", () => {
    expect(new ConnectHttpError(403, "x").message).toBe("mobile-auth: http_403");
  });
});

// ── the token is never stored ────────────────────────────────────────────────

describe("the enrolment token is never stored", () => {
  it("a grant does not expose or serialise its token", async () => {
    const grant = await confirmedGrant();
    expect(JSON.stringify(grant)).not.toContain(TOKEN);
    expect(JSON.stringify(grant)).toContain("redacted");
    expect(String(grant)).toBe("[EnrolmentGrant]");
    expect(Object.values(grant)).not.toContain(TOKEN);
    expect(Object.getOwnPropertyNames(grant).map((k) => (grant as unknown as Record<string, unknown>)[k])).not.toContain(TOKEN);
  });

  it("no state in the whole flow serialises the token, so persisting state cannot write it", async () => {
    const s = scripted(
      { status: 200, body: { nonce: "n1", maskedEmail: "e***" } },
      { status: 202 },
      { status: 200, body: { enrolmentToken: TOKEN, expiresIn: 300 } },
      "network",
      { status: 200, body: { ok: true } },
    );
    const c = client(s.fetch);
    const reduce = createConnectReducer(c);
    // Serialised at each step, not afterwards: a spent grant has dropped its
    // token, so a leak checked after the flow would be invisible.
    const seen: string[] = [];
    let state: ConnectState = initialConnectState;
    const step = (e: ConnectEvent): ConnectState => {
      const next = reduce(state, e);
      seen.push(JSON.stringify(next));
      return next;
    };
    state = step({ type: "scan" });
    state = step({ type: "code", source: "scan", raw: QR });
    if (state.step !== "checking") throw new Error(state.step);
    state = step({ type: "presented", result: await c.present(state.ref) });
    state = step({ type: "confirm" });
    if (state.step !== "waiting") throw new Error(state.step);
    state = step({ type: "website", result: await c.waitForConfirmation({ collect: state.collect, nonce: state.nonce }) });
    if (state.step !== "enrol") throw new Error(state.step);
    const enrolFn = (post: EnrolmentPost) => post("/k", { publicKey: "PEM" });
    state = step({ type: "enrolled", result: await c.enrol(state.grant, enrolFn) });
    expect(state.step).toBe("enrol_paused");
    state = step({ type: "retry" });
    if (state.step !== "enrol") throw new Error(state.step);
    state = step({ type: "enrolled", result: await c.enrol(state.grant, enrolFn) });
    expect(state).toEqual({ step: "done" });

    expect(seen.some((st) => st.includes('"step":"enrol"'))).toBe(true);
    for (const st of seen) expect(st).not.toContain(TOKEN);
    // And on the wire it went only to the configured origin, only as a bearer, never in a body.
    for (const call of s.calls) {
      expect(call.url.startsWith(`${ORIGIN}/`)).toBe(true);
      expect(call.init.body).not.toContain(TOKEN);
    }
    const bearing = s.calls.filter((x) => x.init.headers["Authorization"] === `Bearer ${TOKEN}`);
    expect(bearing.map((x) => x.url)).toEqual([`${ORIGIN}/k`, `${ORIGIN}/k`]);
  });

  it("the shipped module imports no store and calls no storage API", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "connect-client.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./connect-code.js", "./errors.js"]);
    expect(src).not.toMatch(/SecureStore|setItem|AsyncStorage|localStorage|setItemAsync/);
  });
});

// ── the reducer ──────────────────────────────────────────────────────────────

describe("createConnectReducer", () => {
  const c = client(scripted().fetch);
  const reduce = createConnectReducer(c);
  const collect = { ticket: TICKET };

  it("start -> scan / type, and between them", () => {
    expect(reduce(initialConnectState, { type: "scan" })).toEqual({ step: "scan", notice: null });
    expect(reduce(initialConnectState, { type: "type" })).toEqual({ step: "type", notice: null });
    expect(reduce({ step: "scan", notice: null }, { type: "type" })).toEqual({ step: "type", notice: null });
    expect(reduce({ step: "type", notice: null }, { type: "scan" })).toEqual({ step: "scan", notice: null });
    expect(reduce({ step: "done" }, { type: "scan" })).toEqual({ step: "done" });
    expect(reduce({ step: "done" }, { type: "type" })).toEqual({ step: "done" });
  });

  it("a QR for another origin stays on scan with a notice; ours goes to checking", () => {
    const scan: ConnectState = { step: "scan", notice: null };
    expect(reduce(scan, { type: "code", source: "scan", raw: `https://evil.test/connect#t=${TICKET}` })).toEqual({
      step: "scan",
      notice: "origin_not_allowed",
    });
    expect(reduce(scan, { type: "code", source: "scan", raw: QR })).toEqual({ step: "checking", ref: { ticket: TICKET } });
  });

  it("a typed code goes to checking, or back to type with a notice", () => {
    const type: ConnectState = { step: "type", notice: null };
    expect(reduce(type, { type: "code", source: "type", raw: "abcdefgh" })).toEqual({
      step: "checking",
      ref: { code: "ABCDEFGH" },
    });
    expect(reduce(type, { type: "code", source: "type", raw: "abc" })).toEqual({ step: "type", notice: "too_short" });
    expect(reduce(initialConnectState, { type: "code", source: "type", raw: "abcdefgh" })).toBe(initialConnectState);
  });

  it("presented: ok -> confirm, wrong_code -> type, others -> problem", () => {
    const checking: ConnectState = { step: "checking", ref: collect };
    expect(
      reduce(checking, {
        type: "presented",
        result: { kind: "ok", collect, nonce: "n", maskedEmail: null, expiresAt: null },
      }),
    ).toEqual({ step: "confirm", collect, nonce: "n", maskedEmail: null });
    expect(reduce(checking, { type: "presented", result: { kind: "wrong_code" } })).toEqual({
      step: "type",
      notice: "wrong_code",
    });
    expect(reduce(checking, { type: "presented", result: { kind: "offline" } })).toEqual({
      step: "problem",
      problem: "offline",
    });
    expect(reduce(initialConnectState, { type: "presented", result: { kind: "offline" } })).toBe(initialConnectState);
  });

  it("confirm -> waiting; cancel -> start (except from done)", () => {
    const confirm: ConnectState = { step: "confirm", collect, nonce: "n", maskedEmail: null };
    expect(reduce(confirm, { type: "confirm" })).toEqual({ step: "waiting", collect, nonce: "n" });
    expect(reduce(initialConnectState, { type: "confirm" })).toBe(initialConnectState);
    expect(reduce(confirm, { type: "cancel" })).toBe(initialConnectState);
    expect(reduce({ step: "done" }, { type: "cancel" })).toEqual({ step: "done" });
  });

  it("website: confirmed -> enrol, stopped -> start, others -> problem", async () => {
    const grant = await confirmedGrant();
    const waiting: ConnectState = { step: "waiting", collect, nonce: "n" };
    expect(reduce(waiting, { type: "website", result: { kind: "confirmed", grant } })).toEqual({ step: "enrol", grant });
    expect(reduce(waiting, { type: "website", result: { kind: "stopped" } })).toBe(initialConnectState);
    expect(reduce(waiting, { type: "website", result: { kind: "not_confirmed" } })).toEqual({
      step: "problem",
      problem: "not_confirmed",
    });
    expect(reduce(initialConnectState, { type: "website", result: { kind: "stopped" } })).toBe(initialConnectState);
  });

  it("enrolled: ok -> done, retryable -> paused, others -> problem; retry only from paused", async () => {
    const grant = await confirmedGrant();
    const enrol: ConnectState = { step: "enrol", grant };
    expect(reduce(enrol, { type: "enrolled", result: { kind: "ok", value: 1 } })).toEqual({ step: "done" });
    for (const kind of ["cancelled", "offline"] as const) {
      expect(reduce(enrol, { type: "enrolled", result: { kind } })).toEqual({ step: "enrol_paused", grant, reason: kind });
    }
    expect(reduce(enrol, { type: "enrolled", result: { kind: "failed", error: 1 } })).toEqual({
      step: "enrol_paused",
      grant,
      reason: "failed",
    });
    expect(reduce(enrol, { type: "enrolled", result: { kind: "token_expired" } })).toEqual({
      step: "problem",
      problem: "token_expired",
    });
    expect(reduce(enrol, { type: "enrolled", result: { kind: "refused", status: 403, code: null } })).toEqual({
      step: "problem",
      problem: "refused",
    });
    expect(reduce(initialConnectState, { type: "enrolled", result: { kind: "token_expired" } })).toBe(initialConnectState);
    expect(reduce({ step: "enrol_paused", grant, reason: "offline" }, { type: "retry" })).toEqual({ step: "enrol", grant });
    expect(reduce(initialConnectState, { type: "retry" })).toBe(initialConnectState);
    expect(reduce({ step: "problem", problem: "offline" }, { type: "start_again" })).toBe(initialConnectState);
  });
});
