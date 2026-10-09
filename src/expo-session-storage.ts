/**
 * The Expo adapter for session storage, a separate entry point
 * (`@stonedogcode/mobile-auth/expo-session-storage`). It needs the optional
 * peer `expo-secure-store`. The core never imports it.
 *
 * `expo-secure-store` only: the Android Keystore and the iOS keychain. There is
 * no AsyncStorage path and no fallback to plain storage. If the keystore
 * refuses, the call fails with `store_error`, and the app is signed out rather
 * than holding a token somewhere weaker.
 *
 * Tokens are written WITHOUT `requireAuthentication`: a refresh runs in the
 * background, on a cadence nobody sees, and must not raise a fingerprint
 * prompt. The fingerprint protects the device key (`./expo-device-key`), which
 * is what signs a person in; the tokens are what that sign-in produced.
 */
import * as SecureStore from "expo-secure-store";
import { MobileAuthError } from "./errors.js";
import type { SessionStorage } from "./session.js";

export interface ExpoSessionStorageOptions {
  /**
   * The keychain service. Leave unset to use the app's default, which is where
   * an app that stored tokens with plain `SecureStore.setItemAsync(key, value)`
   * already has them.
   */
  keychainService?: string;
  /** One of `SecureStore`'s `keychainAccessible` constants (iOS). */
  keychainAccessible?: SecureStore.KeychainAccessibilityConstant;
}

/**
 * `SessionStorage` over `expo-secure-store`. Failures become
 * `MobileAuthError("store_error")`; the native error is never attached,
 * because its message can name the key.
 */
export function createExpoSessionStorage(options: ExpoSessionStorageOptions = {}): SessionStorage {
  const opts: SecureStore.SecureStoreOptions = {};
  if (options.keychainService !== undefined) opts.keychainService = options.keychainService;
  if (options.keychainAccessible !== undefined) opts.keychainAccessible = options.keychainAccessible;
  // With no options, call exactly as `SecureStore.setItemAsync(key, value)`
  // does, so existing entries are found where they were written.
  const extra: [SecureStore.SecureStoreOptions] | [] = Object.keys(opts).length > 0 ? [opts] : [];

  return {
    async get(key) {
      try {
        return await SecureStore.getItemAsync(key, ...extra);
      } catch {
        throw new MobileAuthError("store_error");
      }
    },
    async set(key, value) {
      try {
        await SecureStore.setItemAsync(key, value, ...extra);
      } catch {
        throw new MobileAuthError("store_error");
      }
    },
    async remove(key) {
      try {
        await SecureStore.deleteItemAsync(key, ...extra);
      } catch {
        throw new MobileAuthError("store_error");
      }
    },
  };
}

/** The default: the app's default keychain service, no extra options. */
export const expoSessionStorage: SessionStorage = createExpoSessionStorage();
