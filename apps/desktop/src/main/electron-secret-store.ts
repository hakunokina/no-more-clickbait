import { app, safeStorage } from "electron";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SecretStore } from "./secret-store.js";

/**
 * safeStorage-backed SecretStore: values are encrypted by the OS and
 * kept as opaque blobs under userData/secrets. Plain text never
 * touches the disk; if OS encryption is unavailable we refuse rather
 * than silently downgrading to plain text.
 */
export class ElectronSecretStore implements SecretStore {
  #dir(): string {
    return join(app.getPath("userData"), "secrets");
  }

  #pathFor(key: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error(`invalid secret key: ${key}`);
    return join(this.#dir(), `${key}.bin`);
  }

  async get(key: string): Promise<string | null> {
    let blob: Buffer;
    try {
      blob = await readFile(this.#pathFor(key));
    } catch {
      return null;
    }
    return safeStorage.decryptString(blob);
  }

  async set(key: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS-backed encryption (safeStorage) is unavailable; refusing to store a secret.",
      );
    }
    await mkdir(this.#dir(), { recursive: true });
    await writeFile(this.#pathFor(key), safeStorage.encryptString(value));
  }

  async delete(key: string): Promise<void> {
    await rm(this.#pathFor(key), { force: true });
  }
}
