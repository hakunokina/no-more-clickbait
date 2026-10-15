/**
 * Where secrets (future API keys etc.) live. Secrets are NEVER read
 * from environment variables or plain-text config in this project:
 * they are stored through the OS-backed encryption Electron exposes
 * as `safeStorage` (DPAPI on Windows, Keychain on macOS).
 *
 * Phase 1 (user's own logged-in CLI) needs no stored secret at all;
 * this interface exists so later providers have exactly one door.
 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
