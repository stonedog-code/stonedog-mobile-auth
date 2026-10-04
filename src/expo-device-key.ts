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

const AUTH_FAILURE = "Could not Authenticate the user:";

/**
 * Map an expo-secure-store failure to a reason code.
 *
 * Only an AUTHENTICATION failure is classified, and only by the text after
 * its fixed prefix. Other native errors (decrypt, write, delete) embed the
 * key NAME in their message, so scanning the whole message could read a name
 * that happens to contain "cancel" as a cancelled prompt, and hide a real
 * storage failure behind it. Those are always `store_error`. The original
 * error is never attached, for the same reason: it can name the key.
 */
function reasonFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const at = message.indexOf(AUTH_FAILURE);
  if (at === -1) return "store_error";
  const detail = message.slice(at + AUTH_FAILURE.length);
  if (/cancel/i.test(detail)) return "authentication_cancelled";
  if (/no hardware|not currently enrolled|no biometrics|requires Android API|unsupported|security update|status unknown/i.test(detail)) {
    return "biometrics_unavailable";
  }
  return "authentication_failed";
}

/**
 * Two dedicated keychain services, never the app's default.
 *
 * When Android invalidates a biometric-bound key, expo-secure-store deletes it
 * and then removes EVERY entry under that key's keychain service. On the
 * default service, that would wipe unrelated authenticated items the app keeps.
 * And the public key is kept on a SEPARATE service, so it survives the
 * private key's invalidation: that surviving public half is how the core
 * reports `key_invalidated` instead of `key_missing`.
 */
const PROTECTED_SERVICE = "stonedog.device-key.protected";
const PUBLIC_SERVICE = "stonedog.device-key.public";

function storeOptions(requireAuthentication: boolean, prompt?: string) {
  return {
    requireAuthentication,
    ...(prompt ? { authenticationPrompt: prompt } : {}),
    keychainService: requireAuthentication ? PROTECTED_SERVICE : PUBLIC_SERVICE,
    keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  };
}

/**
 * `DeviceKeyStore` over `expo-secure-store`. Values that require
 * authentication are bound to STRONG biometrics by the Android Keystore and,
 * on iOS, kept on this device only.
 *
 * Note: neither platform enforces `requireAuthentication` on a READ. The
 * protection is a property of how the item was WRITTEN, which is why
 * `createDeviceKey` always writes the private key with it.
 */
export const expoDeviceKeyStore: DeviceKeyStore = {
  async set(name, value, options) {
    try {
      await SecureStore.setItemAsync(name, value, storeOptions(options.requireAuthentication, options.prompt));
    } catch (error) {
      throw new MobileAuthError(reasonFor(error));
    }
  },
  async get(name, options) {
    try {
      return await SecureStore.getItemAsync(name, storeOptions(options.requireAuthentication, options.prompt));
    } catch (error) {
      throw new MobileAuthError(reasonFor(error));
    }
  },
  async remove(name) {
    // The store doesn't say which service a name lives on, so remove it from
    // both. Deleting an absent entry is not an error.
    try {
      await SecureStore.deleteItemAsync(name, storeOptions(true));
      await SecureStore.deleteItemAsync(name, storeOptions(false));
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
