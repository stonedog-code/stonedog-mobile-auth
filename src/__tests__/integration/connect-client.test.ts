/**
 * Integration tier: the client against a real HTTP server implementing the
 * connect contract, over real sockets with Node's own fetch. The unit tier's
 * scripted fetch agrees with whatever it is told; this proves the requests the
 * client builds are ones a server can actually route, parse and answer.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createConnectClient, createConnectReducer, initialConnectState, type ConnectState } from "../../connect-client.js";

const TICKET = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const CODE = "ABCDEFGH";
const TOKEN = "enrolment-token-SECRET-int-41c2";

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** A tiny in-process server for the contract: connect, complete (polled), cancel, and a key route. */
function contractServer(redirectTo = "http://127.0.0.1:9/") {
  const seen: Seen[] = [];
  const rows = new Map<string, { ticket: string; nonce: string; polls: number; cancelled: boolean; spent: boolean }>();
  let issued = 0;

  const read = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let s = "";
      req.on("data", (d: Buffer) => (s += d.toString()));
      req.on("end", () => resolve(s ? (JSON.parse(s) as Record<string, unknown>) : {}));
    });

  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path, authorization: req.headers.authorization, body });
    const send = (status: number, json?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const find = () => {
      const id = typeof body["ticketId"] === "string" ? body["ticketId"] : null;
      const byTicket = typeof body["ticket"] === "string" ? [...rows.entries()].find(([, r]) => r.ticket === body["ticket"]) : null;
      const entry = id ? ([id, rows.get(id)] as const) : byTicket;
      return entry && entry[1] && entry[1].nonce === body["nonce"] ? entry[1] : null;
    };

    if (req.method !== "POST") return send(405);
    if (path === "/api/mobile/v1/auth/connect") {
      if (body["ticket"] === TICKET || body["code"] === CODE) {
        const id = `row-${++issued}`;
        const nonce = `nonce-${issued}`;
        rows.set(id, { ticket: TICKET, nonce, polls: 0, cancelled: false, spent: false });
        return send(200, { maskedEmail: "e***@e***.test", nonce, ...("code" in body ? { ticketId: id } : {}) });
      }
      return send(404);
    }
    if (path === "/api/mobile/v1/auth/connect/complete") {
      const row = find();
      if (!row || row.cancelled) return send(404);
      if (row.spent) return send(410);
      row.polls += 1;
      if (row.polls < 3) return send(202);
      row.spent = true;
      return send(200, { enrolmentToken: TOKEN, expiresIn: 300 });
    }
    if (path === "/api/mobile/v1/auth/connect/cancel") {
      const row = find();
      if (row) row.cancelled = true;
      return send(204);
    }
    if (path === "/api/mobile/v1/devices/redirect") {
      res.writeHead(307, { Location: redirectTo });
      return res.end();
    }
    if (path === "/api/mobile/v1/devices/key") {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorised" });
      return send(201, { keyId: "key-1", accessToken: "access", refreshToken: "refresh" });
    }
    return send(404);
  });

  return {
    seen,
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("connect client against a contract server (integration)", () => {
  let srv: ReturnType<typeof contractServer>;
  let origin: string;

  beforeEach(async () => {
    srv = contractServer();
    origin = await srv.start();
  });
  afterEach(() => srv.stop());

  const make = () =>
    createConnectClient({
      origin,
      allowInsecureLocalhost: true,
      fetch: (url, init) => fetch(url, init),
      pollIntervalMs: 5,
      requestTimeoutMs: 2000,
    });

  it("scans, presents, waits through 202s, and enrols with the token as bearer only", async () => {
    const c = make();
    const reduce = createConnectReducer(c);
    let state: ConnectState = reduce(initialConnectState, { type: "scan" });
    state = reduce(state, { type: "code", source: "scan", raw: `${origin}/connect#t=${TICKET}` });
    if (state.step !== "checking") throw new Error(state.step);
    state = reduce(state, { type: "presented", result: await c.present(state.ref, { model: "test" }) });
    if (state.step !== "confirm") throw new Error(state.step);
    expect(state.maskedEmail).toBe("e***@e***.test");
    state = reduce(state, { type: "confirm" });
    if (state.step !== "waiting") throw new Error(state.step);
    state = reduce(state, { type: "website", result: await c.waitForConfirmation({ collect: state.collect, nonce: state.nonce }) });
    if (state.step !== "enrol") throw new Error(state.step);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    const result = await c.enrol(state.grant, (post) => post("/api/mobile/v1/devices/key", { publicKey: "PEM" }));
    expect(result).toEqual({ kind: "ok", value: { keyId: "key-1", accessToken: "access", refreshToken: "refresh" } });
    state = reduce(state, { type: "enrolled", result });
    expect(state).toEqual({ step: "done" });

    expect(srv.seen.map((s) => s.path)).toEqual([
      "/api/mobile/v1/auth/connect",
      "/api/mobile/v1/auth/connect/complete",
      "/api/mobile/v1/auth/connect/complete",
      "/api/mobile/v1/auth/connect/complete",
      "/api/mobile/v1/devices/key",
    ]);
    expect(srv.seen[0]!.body).toEqual({ ticket: TICKET, device: { model: "test" } });
    // The token reached the server exactly once, as the bearer on the key route, never in a body.
    expect(srv.seen.filter((s) => s.authorization !== undefined).map((s) => s.path)).toEqual(["/api/mobile/v1/devices/key"]);
    for (const s of srv.seen) expect(JSON.stringify(s.body)).not.toContain(TOKEN);
  });

  it("a typed code collects by ticketId; a spent ticket then answers 410 and ends the wait", async () => {
    const c = make();
    const presented = await c.present({ code: CODE });
    if (presented.kind !== "ok") throw new Error(presented.kind);
    expect(presented.collect).toEqual({ ticketId: "row-1" });
    const first = await c.waitForConfirmation({ collect: presented.collect, nonce: presented.nonce });
    expect(first.kind).toBe("confirmed");
    expect(await c.waitForConfirmation({ collect: presented.collect, nonce: presented.nonce })).toEqual({
      kind: "not_confirmed",
    });
  });

  it("cancel reaches the server, and the wait then ends as not_confirmed", async () => {
    const c = make();
    const presented = await c.present({ ticket: TICKET });
    if (presented.kind !== "ok") throw new Error(presented.kind);
    expect(await c.cancel(presented.collect, presented.nonce)).toEqual({ kind: "sent" });
    expect(await c.waitForConfirmation({ collect: presented.collect, nonce: presented.nonce })).toEqual({
      kind: "not_confirmed",
    });
  });

  it("a redirect from the configured origin is not followed: the token goes nowhere else", async () => {
    const elsewhere = contractServer();
    const elsewhereOrigin = await elsewhere.start();
    await srv.stop();
    srv = contractServer(`${elsewhereOrigin}/api/mobile/v1/devices/key`);
    origin = await srv.start();
    try {
      const c = make();
      const presented = await c.present({ ticket: TICKET });
      if (presented.kind !== "ok") throw new Error(presented.kind);
      const waited = await c.waitForConfirmation({ collect: presented.collect, nonce: presented.nonce });
      if (waited.kind !== "confirmed") throw new Error(waited.kind);
      const r = await c.enrol(waited.grant, (post) => post("/api/mobile/v1/devices/redirect", {}));
      expect(r.kind).toBe("offline");
      expect(waited.grant.spent).toBe(false);
      expect(elsewhere.seen).toEqual([]);
    } finally {
      await elsewhere.stop();
    }
  });

  it("an unknown code is wrong_code; an unreachable server is offline", async () => {
    expect(await make().present({ code: "ZZZZZZZZ" })).toEqual({ kind: "wrong_code" });
    await srv.stop();
    expect(await make().present({ ticket: TICKET })).toEqual({ kind: "offline" });
    srv = contractServer();
    origin = await srv.start();
  });
});
