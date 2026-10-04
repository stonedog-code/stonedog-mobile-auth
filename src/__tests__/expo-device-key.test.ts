import { jest } from "@jest/globals";

const secure = {
  setItemAsync: jest.fn<(...a: unknown[]) => Promise<void>>(),
  getItemAsync: jest.fn<(...a: unknown[]) => Promise<string | null>>(),
  deleteItemAsync: jest.fn<(...a: unknown[]) => Promise<void>>(),
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
};
const local = {
  hasHardwareAsync: jest.fn<() => Promise<boolean>>(),
  getEnrolledLevelAsync: jest.fn<() => Promise<number>>(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
};
jest.unstable_mockModule("expo-secure-store", () => secure);
jest.unstable_mockModule("expo-local-authentication", () => local);

const { expoDeviceKeyStore, fingerprintAvailability } = await import("../expo-device-key.js");

beforeEach(() => jest.clearAllMocks());

describe("expoDeviceKeyStore", () => {
  it("binds protected values to authentication, on this device only, with the app's prompt", async () => {
    secure.setItemAsync.mockResolvedValue(undefined);
    await expoDeviceKeyStore.set("k", "v", { requireAuthentication: true, prompt: "Use your fingerprint" });
    expect(secure.setItemAsync).toHaveBeenCalledWith("k", "v", {
      requireAuthentication: true,
      authenticationPrompt: "Use your fingerprint",
      keychainAccessible: 6,
    });
  });

  it("reads without a prompt when none is needed", async () => {
    secure.getItemAsync.mockResolvedValue("pem");
    await expect(expoDeviceKeyStore.get("k", { requireAuthentication: false })).resolves.toBe("pem");
    expect(secure.getItemAsync).toHaveBeenCalledWith("k", { requireAuthentication: false, keychainAccessible: 6 });
  });

  it.each([
    ["Could not Authenticate the user: Authentication was cancelled", "authentication_cancelled"],
    ["Could not Authenticate the user: No biometrics are currently enrolled", "biometrics_unavailable"],
    ["Could not Authenticate the user: No hardware available for biometric authentication.", "biometrics_unavailable"],
    ["Could not Authenticate the user: Couldn't get the authentication result", "authentication_failed"],
    ["Could not decrypt the value for key 'k'", "store_error"],
  ])("maps %p to %s, without attaching the original message", async (message, reason) => {
    secure.getItemAsync.mockRejectedValue(new Error(message));
    const error = await expoDeviceKeyStore.get("secret-key-name", { requireAuthentication: true }).catch((e: Error) => e);
    expect((error as Error & { reason: string }).reason).toBe(reason);
    expect((error as Error).message).not.toContain("secret-key-name");
  });

  it("maps failures on write and delete too", async () => {
    secure.setItemAsync.mockRejectedValue(new Error("Authentication was cancelled"));
    await expect(expoDeviceKeyStore.set("k", "v", { requireAuthentication: true })).rejects.toThrow("authentication_cancelled");
    secure.deleteItemAsync.mockRejectedValue("boom");
    await expect(expoDeviceKeyStore.remove("k")).rejects.toThrow("store_error");
  });

  it("deletes on this device's keychain", async () => {
    secure.deleteItemAsync.mockResolvedValue(undefined);
    await expoDeviceKeyStore.remove("k");
    expect(secure.deleteItemAsync).toHaveBeenCalledWith("k", { keychainAccessible: 6 });
  });
});

describe("fingerprintAvailability", () => {
  it.each([
    [false, 3, { available: false, reason: "no_hardware" }],
    [true, 3, { available: true }],
    [true, 2, { available: false, reason: "not_strong_enough" }],
    [true, 1, { available: false, reason: "not_enrolled" }],
    [true, 0, { available: false, reason: "not_enrolled" }],
  ])("hardware=%p level=%p -> %p", async (hw, level, expected) => {
    local.hasHardwareAsync.mockResolvedValue(hw as boolean);
    local.getEnrolledLevelAsync.mockResolvedValue(level as number);
    await expect(fingerprintAvailability()).resolves.toEqual(expected);
  });
});
