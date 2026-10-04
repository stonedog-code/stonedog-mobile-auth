import { randomBytes } from "node:crypto";
import { base64 } from "../base64.js";

describe("base64", () => {
  it("matches Node's standard encoder for every remainder length", () => {
    for (let len = 0; len <= 70; len++) {
      const bytes = new Uint8Array(randomBytes(len));
      expect(base64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});
