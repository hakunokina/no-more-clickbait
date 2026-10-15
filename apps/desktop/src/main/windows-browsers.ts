import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { browserFamilyOfExe, type BrowserFamily } from "@nmc/native-host";

/**
 * Which Chromium browsers this Windows machine has, and which one is the
 * system default — read from the registry, never written. Measured on
 * Windows 11 (2026-10-15):
 * - `UrlAssociations\https\UserChoiceLatest\ProgId` (a subkey, its
 *   `ProgId` value) supersedes the classic `UserChoice` `ProgId`; the
 *   classic key can have no values at all, so try Latest first.
 * - Installed browsers register under `Clients\StartMenuInternet`
 *   (HKLM for machine installs, HKCU for per-user ones like Vivaldi).
 *   App Paths misses most of them, so it is not used.
 * Everything goes through a small reader interface so tests fake the
 * registry; the real one shells out to `reg.exe query`.
 */

export type RegistryHive = "HKCU" | "HKLM";

export interface RegistryReader {
  /** One string value (`null` name = the key's default value), or null. */
  readString(hive: RegistryHive, key: string, valueName: string | null): Promise<string | null>;
  /** Names of the key's subkeys (last path segment only). */
  listSubkeys(hive: RegistryHive, key: string): Promise<string[]>;
}

const HTTPS_ASSOCIATIONS =
  "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https";
const START_MENU_INTERNET = "SOFTWARE\\Clients\\StartMenuInternet";

/** The ProgId of the user's default https handler (e.g. "BraveOHTML"), or null. */
export async function defaultBrowserProgId(reader: RegistryReader): Promise<string | null> {
  const latest = await reader.readString(
    "HKCU",
    `${HTTPS_ASSOCIATIONS}\\UserChoiceLatest\\ProgId`,
    "ProgId",
  );
  if (latest) return latest;
  return reader.readString("HKCU", `${HTTPS_ASSOCIATIONS}\\UserChoice`, "ProgId");
}

/** ProgId prefixes of the Chromium families (Firefox etc. map to null). */
const PROG_ID_FAMILIES: Readonly<Record<string, BrowserFamily>> = {
  brave: "brave", // BraveHTML, BraveOHTML (Brave Origin)
  chrome: "chrome", // ChromeHTML
  msedge: "edge", // MSEdgeHTM
  vivaldi: "vivaldi", // VivaldiHTM.<hash>
  opera: "opera", // OperaStable, OperaGXStable
};

export function browserFamilyOfProgId(progId: string): BrowserFamily | null {
  const lower = progId.toLowerCase();
  for (const [prefix, family] of Object.entries(PROG_ID_FAMILIES)) {
    if (lower.startsWith(prefix)) return family;
  }
  return null;
}

/** The system default browser as a Chromium family (null: not one of them / unknown). */
export async function defaultBrowserFamily(
  reader: RegistryReader,
): Promise<BrowserFamily | null> {
  const progId = await defaultBrowserProgId(reader);
  return progId ? browserFamilyOfProgId(progId) : null;
}

export interface InstalledBrowser {
  family: BrowserFamily;
  exePath: string;
}

/** The executable out of a `shell\open\command` like `"C:\..\brave.exe" --flag %1`. */
export function parseOpenCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : null;
  }
  const exe = /^(.+?\.exe)\b/i.exec(trimmed);
  return exe ? exe[1]! : null;
}

/**
 * Chromium browsers registered in StartMenuInternet, HKCU first (a
 * per-user install shadows the machine one of the same family).
 */
export async function installedBrowsers(reader: RegistryReader): Promise<InstalledBrowser[]> {
  const byFamily = new Map<BrowserFamily, InstalledBrowser>();
  for (const hive of ["HKCU", "HKLM"] as const) {
    for (const client of await reader.listSubkeys(hive, START_MENU_INTERNET)) {
      const command = await reader.readString(
        hive,
        `${START_MENU_INTERNET}\\${client}\\shell\\open\\command`,
        null,
      );
      const exePath = command ? parseOpenCommand(command) : null;
      const family = exePath ? browserFamilyOfExe(exePath) : null;
      if (exePath && family && !byFamily.has(family)) byFamily.set(family, { family, exePath });
    }
  }
  return [...byFamily.values()];
}

// --- reg.exe backing -------------------------------------------------

/** Runs `reg.exe` with an argument array (no shell, no path conversion). */
export type RegRunner = (args: string[]) => Promise<string | null>;

const runReg: RegRunner = (args) =>
  new Promise((resolve) => {
    execFile("reg.exe", args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });

/**
 * The value out of `reg query ... /v name` output:
 * `    ProgId    REG_SZ    BraveOHTML`. `(Default)` when name is null.
 */
export function parseRegValue(output: string, valueName: string | null): string | null {
  const wanted = (valueName ?? "(Default)").toLowerCase();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line);
    if (match && match[1]!.toLowerCase() === wanted) return match[3]!.trim() || null;
  }
  return null;
}

/** Subkey names out of `reg query <key>` output (full key paths, one per line). */
export function parseRegSubkeys(output: string, keyPath: string): string[] {
  const prefix = `${keyPath}\\`.toLowerCase();
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(prefix)) continue;
    const rest = trimmed.slice(prefix.length);
    if (rest && !rest.includes("\\")) names.push(rest);
  }
  return names;
}

const HIVE_ROOTS: Readonly<Record<RegistryHive, string>> = {
  HKCU: "HKEY_CURRENT_USER",
  HKLM: "HKEY_LOCAL_MACHINE",
};

export function regExeReader(run: RegRunner = runReg): RegistryReader {
  return {
    async readString(hive, key, valueName) {
      const path = `${hive}\\${key}`;
      const args =
        valueName === null ? ["query", path, "/ve"] : ["query", path, "/v", valueName];
      const output = await run(args);
      return output ? parseRegValue(output, valueName) : null;
    },
    async listSubkeys(hive, key) {
      const output = await run(["query", `${hive}\\${key}`]);
      return output ? parseRegSubkeys(output, `${HIVE_ROOTS[hive]}\\${key}`) : [];
    },
  };
}

// --- launching & waiting ----------------------------------------------

/** Starts a process detached; injectable so tests never open a browser. */
export type ProcessLauncher = (exePath: string) => void;

export const launchDetached: ProcessLauncher = (exePath) => {
  // spawn reports a missing file only through its async `error` event:
  // checked up front, a stale registry path fails at once instead of
  // after the whole connection wait.
  if (!existsSync(exePath)) throw new Error(`not found: ${exePath}`);
  const child: ChildProcess = spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", () => undefined);
  child.unref();
};

/**
 * Polls until `isConnected` or the timeout runs out. The extension
 * connects when its service worker starts in the launched browser.
 */
export async function waitForConnection(
  isConnected: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isConnected()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
