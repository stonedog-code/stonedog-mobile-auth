/**
 * Expo adapters for the on-device key, a separate entry point
 * (`@stonedogcode/mobile-auth/expo-device-key`). It needs the optional peers
 * `expo-secure-store` and `expo-local-authentication`. The core never imports
 * them.
 */
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import type { DeviceKeyStore } from "./device-key.js";
import { MobileAuthError } from "./errors.js";

/**
 * Map an expo-secure-store failure to a reason code. Matched on the message
 * because the native module raises one exception class for all of them.
 * The original error is deliberately not attached: it can name the key.
 */
function reasonFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel/i.test(message)) return "authentication_cancelled";
  if (/no hardware|not currently enrolled|no biometrics|requires Android API/i.test(message)) {
    return "biometrics_unavailable";
  }
  if (/authenticat/i.test(message)) return "authentication_failed";
  return "store_error";
}

/**
 * `DeviceKeyStore` over `expo-secure-store`. Values that require
 * authentication are bound to STRONG biometrics by the Android Keystore and,
 * on iOS, kept on this device only.
 */
export const expoDeviceKeyStore: DeviceKeyStore = {
  async set(name, value, options) {
    try {
      await SecureStore.setItemAsync(name, value, {
        requireAuthentication: options.requireAuthentication,
        ...(options.prompt ? { authenticationPrompt: options.prompt } : {}),
        keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
      });
    } catch (error) {
      throw new MobileAuthError(reasonFor(error));
    }
  },
  async get(name, options) {
    try {
      return await SecureStore.getItemAsync(name, {
        requireAuthentication: options.requireAuthentication,
        ...(options.prompt ? { authenticationPrompt: options.prompt } : {}),
        keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
      });
    } catch (error) {
      throw new MobileAuthError(reasonFor(error));
    }
  },
  async remove(name) {
    try {
      await SecureStore.deleteItemAsync(name, { keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY });
    } catch (error) {
      throw new MobileAuthError(reasonFor(error));
    }
  },
};

export type FingerprintAvailability =
  | { available: true }
  | { available: false; reason: "no_hardware" | "not_enrolled" | "not_strong_enough" };

/**
 * Can this phone hold a fingerprint-unlocked key? The Keystore binding
 * expo-secure-store uses requires a STRONG biometric, so a phone with only a
 * weak sensor (some face unlock) or only a PIN is reported as unavailable, and
 * the app should not offer the set-up.
 */
export async function fingerprintAvailability(): Promise<FingerprintAvailability> {
  if (!(await LocalAuthentication.hasHardwareAsync())) return { available: false, reason: "no_hardware" };
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG) return { available: true };
  if (level === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK) {
    return { available: false, reason: "not_strong_enough" };
  }
  return { available: false, reason: "not_enrolled" };
}
