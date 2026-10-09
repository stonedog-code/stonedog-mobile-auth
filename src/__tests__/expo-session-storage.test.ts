import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jest } from "@jest/globals";


/** Source with comments removed: a comment may NAME a banned API to explain the ban. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const secure = {
  setItemAsync: jest.fn<(...a: unknown[]) => Promise<void>>(),
  getItemAsync: jest.fn<(...a: unknown[]) => Promise<string | null>>(),
  deleteItemAsync: jest.fn<(...a: unknown[]) => Promise<void>>(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 5,
};
jest.unstable_mockModule("expo-secure-store", () => secure);

const { expoSessionStorage, createExpoSessionStorage } = await import("../expo-session-storage.js");
const { MobileAuthError } = await import("../errors.js");

beforeEach(() => jest.clearAllMocks());

describe("expoSessionStorage", () => {
  it("calls expo-secure-store with NO options, where plain setItemAsync(key, value) stored them", async () => {
    secure.setItemAsync.mockResolvedValue(undefined);
    secure.getItemAsync.mockResolvedValue("v");
    secure.deleteItemAsync.mockResolvedValue(undefined);
    await expoSessionStorage.set("k", "v");
    await expect(expoSessionStorage.get("k")).resolves.toBe("v");
    await expoSessionStorage.remove("k");
    expect(secure.setItemAsync.mock.calls).toEqual([["k", "v"]]);
    expect(secure.getItemAsync.mock.calls).toEqual([["k"]]);
    expect(secure.deleteItemAsync.mock.calls).toEqual([["k"]]);
  });

  it("passes a keychain service and accessibility through, and never asks for authentication", async () => {
    secure.setItemAsync.mockResolvedValue(undefined);
    const s = createExpoSessionStorage({ keychainService: "app.session", keychainAccessible: 5 });
    await s.set("k", "v");
    expect(secure.setItemAsync).toHaveBeenCalledWith("k", "v", { keychainService: "app.session", keychainAccessible: 5 });
    const only = createExpoSessionStorage({ keychainService: "app.session" });
    await only.set("k", "v");
    expect(secure.setItemAsync).toHaveBeenLastCalledWith("k", "v", { keychainService: "app.session" });
  });

  it("maps every native failure to store_error and never attaches the native message", async () => {
    const native = new Error("Could not encrypt the value for key 'k' token-SECRET");
    secure.getItemAsync.mockRejectedValue(native);
    secure.setItemAsync.mockRejectedValue(native);
    secure.deleteItemAsync.mockRejectedValue(native);
    for (const p of [expoSessionStorage.get("k"), expoSessionStorage.set("k", "token-SECRET"), expoSessionStorage.remove("k")]) {
      const e = await p.then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toEqual(new MobileAuthError("store_error"));
      expect(String(e)).not.toContain("SECRET");
      expect((e as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("imports expo-secure-store and nothing that could store a token elsewhere", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "expo-session-storage.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./errors.js", "./session.js", "expo-secure-store"]);
    expect(code(src)).not.toMatch(/AsyncStorage|localStorage|requireAuthentication:/);
  });
});
