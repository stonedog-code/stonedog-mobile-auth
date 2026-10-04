import { randomBytes } from "node:crypto";
import { base64url } from "../base64url.js";

describe("base64url", () => {
  it("matches Node's encoder for every remainder length, including empty", () => {
    for (let len = 0; len <= 70; len++) {
      const bytes = new Uint8Array(randomBytes(len));
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });
});
