import {
  formatManualCode,
  normaliseManualCode,
  parseConnectQr,
  type ParseConnectCodeOptions,
} from "../connect-code.js";

const ORIGIN = "https://app.example.com";
const TICKET = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"; // 43 chars
const OPTS: ParseConnectCodeOptions = { allowedOrigins: [ORIGIN] };
const qr = (rest: string) => `${ORIGIN}${rest}`;

describe("parseConnectQr", () => {
  it("accepts the documented payload", () => {
    expect(TICKET).toHaveLength(43);
    expect(parseConnectQr(qr(`/connect#t=${TICKET}`), OPTS)).toEqual({
      ok: true,
      origin: ORIGIN,
      ticket: TICKET,
    });
  });

  it("tolerates surrounding whitespace, a trailing slash and origin case", () => {
    const r = parseConnectQr(`  HTTPS://APP.EXAMPLE.COM/connect/#t=${TICKET}\n`, OPTS);
    expect(r).toEqual({ ok: true, origin: ORIGIN, ticket: TICKET });
  });

  it.each([
    ["not a url at all", "not_a_url"],
    [`http://app.example.com/connect#t=${TICKET}`, "insecure_scheme"],
    [`https://app.example.com.evil.test/connect#t=${TICKET}`, "origin_not_allowed"],
    [`https://evil.test/connect#t=${TICKET}`, "origin_not_allowed"],
    [`https://app.example.com:8443/connect#t=${TICKET}`, "origin_not_allowed"],
    [`https://app.example.com/login#t=${TICKET}`, "wrong_path"],
    [`https://app.example.com/connect`, "missing_ticket"],
    [`https://app.example.com/connect?t=${TICKET}`, "missing_ticket"],
    [`https://app.example.com/connect#t=short`, "malformed_ticket"],
    [`https://app.example.com/connect#t=${TICKET}&t=${TICKET}`, "malformed_ticket"],
    [`https://app.example.com/connect#t=${TICKET.slice(0, 42)}!`, "malformed_ticket"],
  ])("rejects %s as %s", (raw, reason) => {
    expect(parseConnectQr(raw, OPTS)).toEqual({ ok: false, reason });
  });

  it.each([
    [`https://app.example.com@evil.test/connect#t=${TICKET}`, "userinfo look-alike"],
    [`https://user:pw@app.example.com/connect#t=${TICKET}`, "userinfo"],
    [`https://[::1]/connect#t=${TICKET}`, "IPv6 literal"],
    [`https:///connect#t=${TICKET}`, "empty host"],
    [`https://app.example.com:99999/connect#t=${TICKET}`, "port out of shape"],
  ])("refuses %s (%s) before it can reach the allowlist", (raw) => {
    const r = parseConnectQr(raw, OPTS);
    expect(r.ok).toBe(false);
  });

  it("treats an explicit default port as the same origin", () => {
    expect(parseConnectQr(`https://app.example.com:443/connect#t=${TICKET}`, OPTS)).toEqual({
      ok: true,
      origin: ORIGIN,
      ticket: TICKET,
    });
  });

  it("ignores other fragment parameters and an empty pair", () => {
    expect(parseConnectQr(qr(`/connect#v=1&&t=${TICKET}`), OPTS)).toMatchObject({ ok: true, ticket: TICKET });
    expect(parseConnectQr(qr(`/connect#t`), OPTS)).toEqual({ ok: false, reason: "malformed_ticket" });
  });

  it("matches an allowlist entry written with a trailing slash or capitals", () => {
    const opts = { allowedOrigins: ["HTTPS://App.Example.com/"] };
    expect(parseConnectQr(qr(`/connect#t=${TICKET}`), opts)).toMatchObject({ ok: true });
  });

  it("puts the ticket in the fragment only: a query-string ticket is not read", () => {
    // The fragment never reaches a server log; a query string does.
    expect(parseConnectQr(qr(`/connect?t=${TICKET}`), OPTS)).toEqual({ ok: false, reason: "missing_ticket" });
  });

  it("allows http://localhost only when explicitly enabled", () => {
    const local = { allowedOrigins: ["http://localhost:8081"] };
    const raw = `http://localhost:8081/connect#t=${TICKET}`;
    expect(parseConnectQr(raw, local)).toEqual({ ok: false, reason: "insecure_scheme" });
    expect(parseConnectQr(raw, { ...local, allowInsecureLocalhost: true })).toMatchObject({ ok: true });
    // ...and never for a non-local host, even when enabled.
    expect(
      parseConnectQr(`http://app.example.com/connect#t=${TICKET}`, {
        allowedOrigins: ["http://app.example.com"],
        allowInsecureLocalhost: true,
      }),
    ).toEqual({ ok: false, reason: "insecure_scheme" });
  });

  it("fails closed on an empty allowlist rather than accepting anything", () => {
    expect(() => parseConnectQr(qr(`/connect#t=${TICKET}`), { allowedOrigins: [] })).toThrow("empty_allowlist");
  });
});

describe("manual code", () => {
  it("normalises case, spaces, hyphens and the confusable letters", () => {
    expect(normaliseManualCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normaliseManualCode(" a b c d e f g h ")).toBe("ABCDEFGH");
    expect(normaliseManualCode("OIL0-1234")).toBe("0110" + "1234");
  });

  it.each(["ABCDEFG", "ABCDEFGHJ", "ABCDEFGU", "ABCD EFG!", ""])("rejects %p", (input) => {
    expect(normaliseManualCode(input)).toBeNull();
  });

  it("formats for display as ABCD-EFGH", () => {
    expect(formatManualCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(() => formatManualCode("nope")).toThrow("invalid_manual_code");
  });
});
