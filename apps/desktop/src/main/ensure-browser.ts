import { browserLabel, type CollectBrowserResolution } from "./browser-choice.js";
import type { InstalledBrowser } from "./windows-browsers.js";

/**
 * Makes sure the chosen collecting browser is up and its extension
 * linked before a collection starts: already connected → nothing to do;
 * otherwise the browser is started (no page is opened) and the
 * extension's link is awaited. Pure orchestration over injected pieces;
 * the wait itself is windows-browsers' waitForConnection.
 */

export type EnsureBrowserResult =
  { ok: true; launched: boolean } | { ok: false; reason: string };

export interface EnsureBrowserDeps {
  resolution: CollectBrowserResolution;
  /** A host from this browser is linked right now. */
  isConnected(browser: InstalledBrowser): boolean;
  launch(exePath: string): void;
  waitForConnection(isConnected: () => boolean): Promise<boolean>;
}

export async function ensureCollectBrowser(
  deps: EnsureBrowserDeps,
): Promise<EnsureBrowserResult> {
  if (!deps.resolution.ok) return { ok: false, reason: deps.resolution.reason };
  const browser = deps.resolution.browser;
  if (deps.isConnected(browser)) return { ok: true, launched: false };

  const label = browserLabel(browser.family);
  try {
    deps.launch(browser.exePath);
  } catch {
    return { ok: false, reason: `${label} could not be started (${browser.exePath}).` };
  }
  const connected = await deps.waitForConnection(() => deps.isConnected(browser));
  return connected
    ? { ok: true, launched: true }
    : {
        ok: false,
        reason:
          `${label} was opened, but the extension did not connect in time. ` +
          `Is the No More Clickbait extension installed in ${label}? ` +
          `Load it there (and register the native host for ${label}), then try again.`,
      };
}
