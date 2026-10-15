import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BrowserFamilySchema,
  desktopDataDir,
  type BrowserFamily,
  type BrowserIdentity,
} from "@nmc/native-host";
import type { BrowserChoice } from "../shared/settings-status.js";
import type { InstalledBrowser } from "./windows-browsers.js";

export type { BrowserChoice };

/**
 * The user's "Browser for collecting" choice: the system default (the
 * default choice) or one family. Kept in the desktop app's own file —
 * settings.json belongs to the host, and this choice never travels to
 * the extension.
 */

export function browserChoicePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(desktopDataDir(env), "browser-choice.json");
}

export function parseBrowserChoice(raw: unknown): BrowserChoice {
  if (typeof raw === "object" && raw !== null && "choice" in raw) {
    const { choice } = raw as { choice: unknown };
    if (choice === "default") return "default";
    const family = BrowserFamilySchema.safeParse(choice);
    if (family.success && family.data !== "other") return family.data;
  }
  return "default";
}

export async function loadBrowserChoice(
  path: string = browserChoicePath(),
): Promise<BrowserChoice> {
  try {
    return parseBrowserChoice(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return "default";
  }
}

export async function saveBrowserChoice(
  choice: BrowserChoice,
  path: string = browserChoicePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ choice }, null, 2)}\n`, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export type CollectBrowserResolution =
  | { ok: true; browser: InstalledBrowser }
  /** The choice leads nowhere usable; the reason is user-facing English. */
  | { ok: false; reason: string };

const LABELS: Partial<Record<BrowserFamily, string>> = {
  brave: "Brave",
  chrome: "Chrome",
  edge: "Microsoft Edge",
  vivaldi: "Vivaldi",
  opera: "Opera",
};

export function browserLabel(family: BrowserFamily): string {
  return LABELS[family] ?? "your browser";
}

/**
 * Which installed browser a collection goes to. "default" resolves to
 * the system default when it is a supported Chromium browser.
 */
export function resolveCollectBrowser(
  choice: BrowserChoice,
  systemDefault: BrowserFamily | null,
  installed: readonly InstalledBrowser[],
): CollectBrowserResolution {
  if (choice === "default") {
    if (!systemDefault) {
      return {
        ok: false,
        reason:
          "Your default browser is not a supported Chromium browser. Pick a browser for collecting in Settings.",
      };
    }
    const found = installed.find((browser) => browser.family === systemDefault);
    return found
      ? { ok: true, browser: found }
      : {
          ok: false,
          reason: `${browserLabel(systemDefault)} is your default browser but was not found on this PC. Pick a browser for collecting in Settings.`,
        };
  }
  const found = installed.find((browser) => browser.family === choice);
  return found
    ? { ok: true, browser: found }
    : { ok: false, reason: `${browserLabel(choice)} is not installed on this PC.` };
}

/**
 * Does a connected host belong to the chosen browser? An exact
 * executable match wins; a host that could not report its path is
 * matched by family. Two installs of one family stay told apart by path.
 */
export function hostMatchesBrowser(identity: BrowserIdentity, browser: InstalledBrowser): boolean {
  if (identity.family !== browser.family) return false;
  if (!identity.exePath) return true;
  return identity.exePath.toLowerCase() === browser.exePath.toLowerCase();
}
