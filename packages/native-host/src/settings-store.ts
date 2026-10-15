import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  isNewerStamp,
  ManagedSettingsSchema,
  UNSTAMPED,
  type ManagedSettings,
  type SettingsStamp,
} from "@nmc/core";
import { loadSettings } from "@nmc/core/settings-file";

/**
 * Where the desktop pipeline reads the user's settings:
 * `%LOCALAPPDATA%\NoMoreClickbait\settings.json` (next to the host
 * manifest install-host.ps1 writes). Read it with
 * `@nmc/core/settings-file`'s `loadSettings`.
 */
export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env["LOCALAPPDATA"];
  return localAppData
    ? join(localAppData, "NoMoreClickbait", "settings.json")
    : join(homedir(), ".local", "share", "NoMoreClickbait", "settings.json");
}

/**
 * On Windows a rename over a file another process has open (the desktop
 * reading it) fails briefly with EPERM/EACCES/EBUSY; retry a few times.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** What settings.json holds after a save attempt. */
export interface SettingsFileState {
  /** False when the file already held a later save, which was kept. */
  written: boolean;
  settings: ManagedSettings;
  stamp: SettingsStamp;
}

/**
 * Saves the managed settings with their stamp, unless the file already
 * holds a later save (last writer wins: the extension and the desktop
 * app can both change settings). Unstamped settings count as older than
 * any stamped save. Written atomically: a temp file in the same folder,
 * then renamed over the target, so a reader never sees a half-written
 * file. UTF-8 without BOM. Only validated managed fields are written.
 */
export async function saveSettingsFile(
  settings: ManagedSettings,
  stamp: SettingsStamp | undefined,
  path: string = defaultSettingsPath(),
): Promise<SettingsFileState> {
  const valid = ManagedSettingsSchema.parse(settings);
  const incoming = stamp ?? UNSTAMPED;
  const current = await loadSettings(path);
  const currentStamp = current.stamp ?? UNSTAMPED;
  if (current.found && isNewerStamp(currentStamp, incoming)) {
    return {
      written: false,
      settings: ManagedSettingsSchema.parse(current.settings),
      stamp: currentStamp,
    };
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}-${Date.now()}.tmp`;
  try {
    const content = stamp ? { ...valid, ...stamp } : valid;
    await writeFile(temp, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { written: true, settings: valid, stamp: incoming };
}
