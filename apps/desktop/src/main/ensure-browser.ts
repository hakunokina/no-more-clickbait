import type { BrowserFamily } from "@nmc/native-host";
import { browserLabel, type CollectBrowserResolution } from "./browser-choice.js";
import type { InstalledBrowser } from "./windows-browsers.js";

/**
 * Makes sure the chosen collecting browser is up and its extension
 * linked before a collection starts: already connected → nothing to do;
 * otherwise the browser is started (no page is opened) and the
 * extension's link is awaited. A choice that resolves to no supported
 * browser (e.g. the system default is Firefox) does not block a
 * collection when some extension is linked: it runs there (the link's
 * any-host send) and `notice` says so. Pure orchestration over injected
 * pieces; the wait itself is windows-browsers' waitForConnection.
 */

export type EnsureBrowserResult =
  { ok: true; launched: boolean; notice?: string } | { ok: false; reason: string };

export interface EnsureBrowserDeps {
  resolution: CollectBrowserResolution;
  /** A host from this browser is linked right now. */
  isConnected(browser: InstalledBrowser): boolean;
  launch(exePath: string): void;
  waitForConnection(isConnected: () => boolean): Promise<boolean>;
  /** The browser of the linked host an any-host send reaches; null when none is linked. */
  anyConnected?(): BrowserFamily | null;
}

export async function ensureCollectBrowser(
  deps: EnsureBrowserDeps,
): Promise<EnsureBrowserResult> {
  if (!deps.resolution.ok) {
    const fallback = deps.anyConnected?.() ?? null;
    if (fallback === null) return { ok: false, reason: deps.resolution.reason };
    const used = fallback === "other" ? "browser" : browserLabel(fallback);
    return {
      ok: true,
      launched: false,
      notice: `${deps.resolution.reason} Collecting in the connected ${used} instead.`,
    };
  }
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
