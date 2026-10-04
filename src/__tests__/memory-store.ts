import type { DeviceKeyStore } from "../device-key.js";
import { MobileAuthError } from "../errors.js";

/** An in-memory DeviceKeyStore that records how each value was protected. */
export function memoryStore() {
  const values = new Map<string, string>();
  const protectedNames = new Set<string>();
  const reads: Array<{ name: string; requireAuthentication: boolean; prompt?: string }> = [];
  let failNextAuth: string | null = null;
  const store: DeviceKeyStore = {
    async set(name, value, options) {
      values.set(name, value);
      if (options.requireAuthentication) protectedNames.add(name);
      else protectedNames.delete(name);
    },
    async get(name, options) {
      reads.push({ name, requireAuthentication: options.requireAuthentication, ...(options.prompt ? { prompt: options.prompt } : {}) });
      if (protectedNames.has(name) && !options.requireAuthentication) {
        throw new Error("test store: a protected value was read without authentication");
      }
      if (options.requireAuthentication && failNextAuth) {
        const reason = failNextAuth;
        failNextAuth = null;
        throw new MobileAuthError(reason);
      }
      return values.get(name) ?? null;
    },
    async remove(name) {
      values.delete(name);
      protectedNames.delete(name);
    },
  };
  return {
    store,
    values,
    protectedNames,
    reads,
    failNextAuthWith(reason: string) {
      failNextAuth = reason;
    },
  };
}
