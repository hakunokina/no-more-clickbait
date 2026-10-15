import { execFile } from "node:child_process";
import { basename } from "node:path";
import { z } from "zod";

/**
 * Which browser launched this host process. The desktop app routes
 * "Collect" to the browser the user picked, so every host tells it
 * where it runs (in the link handshake).
 *
 * Why the process tree and not the registry key or the arguments:
 * - Chromium passes the host only the caller's origin
 *   (`chrome-extension://<id>/`, identical in every browser for our
 *   pinned-key extension) and `--parent-window` (0 from a service worker).
 * - Browsers share registry keys: Edge falls back to Chrome's (and
 *   Chromium's) NativeMessagingHosts key when its own is missing
 *   (Microsoft's native-messaging docs), Brave and Vivaldi read Chrome's
 *   too. A per-browser manifest therefore does not prove the browser.
 * - The parent chain does. Measured on Windows 11 with Brave:
 *   `node.exe ← cmd.exe ← brave.exe` (Chromium starts the host's .cmd
 *   launcher through cmd.exe). The browser is the first ancestor that is
 *   not a launcher shell.
 */

export const BrowserFamilySchema = z.enum(["brave", "chrome", "edge", "vivaldi", "other"]);
export type BrowserFamily = z.infer<typeof BrowserFamilySchema>;

export const BrowserIdentitySchema = z.object({
  family: BrowserFamilySchema,
  /** The browser's executable, when the OS reported it (tells two Brave installs apart). */
  exePath: z.string().min(1).max(1024).nullable(),
});
export type BrowserIdentity = z.infer<typeof BrowserIdentitySchema>;

export const UNKNOWN_BROWSER: BrowserIdentity = { family: "other", exePath: null };

const EXE_FAMILIES: Readonly<Record<string, BrowserFamily>> = {
  "brave.exe": "brave",
  "chrome.exe": "chrome",
  "msedge.exe": "edge",
  "vivaldi.exe": "vivaldi",
};

/** Programs between the browser and the host: never the browser itself. */
const LAUNCHERS: ReadonlySet<string> = new Set([
  "cmd.exe",
  "conhost.exe",
  "node.exe",
  "powershell.exe",
  "pwsh.exe",
]);

/** The supported browser an executable belongs to (by file name), or null. */
export function browserFamilyOfExe(pathOrName: string): BrowserFamily | null {
  return EXE_FAMILIES[basename(pathOrName.replace(/\\/g, "/")).toLowerCase()] ?? null;
}

export interface ProcessInfo {
  name: string;
  exePath: string | null;
}

/**
 * Picks the browser from the host's ancestors (parent first): launcher
 * shells are skipped; the first other process decides.
 */
export function identifyFromAncestors(ancestors: readonly ProcessInfo[]): BrowserIdentity {
  for (const process of ancestors) {
    const name = process.name.toLowerCase();
    if (LAUNCHERS.has(name)) continue;
    const family = browserFamilyOfExe(name);
    return family ? { family, exePath: process.exePath } : UNKNOWN_BROWSER;
  }
  return UNKNOWN_BROWSER;
}

const AncestorsSchema = z.array(
  z.object({ name: z.string(), path: z.string().nullable().optional() }),
);

/**
 * The process `pid` and its ancestors (up to `depth`), read with
 * PowerShell's CIM query (wmic is gone from current Windows 11).
 * Read-only; about half a second, once per host process.
 */
export function windowsAncestors(pid: number, depth = 4): Promise<ProcessInfo[]> {
  const script =
    `$p=${Math.trunc(pid)};$o=@();` +
    `for($i=0;$i -lt ${depth} -and $p;$i++){` +
    `$c=Get-CimInstance Win32_Process -Filter "ProcessId=$p";if(-not $c){break};` +
    `$o+=[pscustomobject]@{name=$c.Name;path=$c.ExecutablePath};$p=$c.ParentProcessId};` +
    `ConvertTo-Json -Compress -InputObject @($o)`;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve([]);
        try {
          const parsed = AncestorsSchema.safeParse(JSON.parse(stdout));
          resolve(
            parsed.success
              ? parsed.data.map((item) => ({ name: item.name, exePath: item.path ?? null }))
              : [],
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/** The browser that started this host; `other` when it cannot be told. */
export async function identifyBrowser(
  parentPid: number = process.ppid,
  ancestors: (pid: number) => Promise<ProcessInfo[]> = windowsAncestors,
  platform: NodeJS.Platform = process.platform,
): Promise<BrowserIdentity> {
  if (platform !== "win32") return UNKNOWN_BROWSER;
  return identifyFromAncestors(await ancestors(parentPid).catch(() => []));
}
