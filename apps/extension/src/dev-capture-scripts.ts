import { SETTINGS_STORAGE_KEY } from "./settings-key.js";

/**
 * The Reddit and Instagram MAIN-world response listeners wrap the page's
 * `fetch` and `XMLHttpRequest`. They are registered only while something
 * reads them — developer capture (both), or Instagram as a collection
 * source (Instagram's) — otherwise every Reddit/Instagram page would
 * carry non-native `fetch`/XHR (visible to the site's integrity checks)
 * for a feature the user never turned on.
 * The isolated relays stay in the manifest: they touch no page global.
 * A registered script injects only where the extension has host
 * permission — a manifest content_scripts match does not count — so
 * both sites are in `host_permissions` (the install warning already
 * names them; the worker makes no request to them). A tab
 * already open when the tick changes keeps its state until reloaded.
 * X's listener (injected.js) is the product's own path and stays static.
 */

export const DEV_CAPTURE_SCRIPTS: chrome.scripting.RegisteredContentScript[] = [
  {
    id: "nmc-reddit-injected",
    matches: ["https://www.reddit.com/*"],
    js: ["reddit-injected.js"],
    world: "MAIN",
    runAt: "document_start",
    persistAcrossSessions: true,
  },
  {
    id: "nmc-instagram-injected",
    matches: ["https://www.instagram.com/*"],
    js: ["instagram-injected.js"],
    world: "MAIN",
    runAt: "document_start",
    persistAcrossSessions: true,
  },
];

const IDS = DEV_CAPTURE_SCRIPTS.map((script) => script.id);
const INSTAGRAM_ID = "nmc-instagram-injected";

/** The `chrome.scripting` surface used here (fakeable in tests). */
export interface ScriptingApi {
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<{ id: string }[]>;
  registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
}

/**
 * Registers both scripts when developer capture is `enabled`, Instagram's
 * alone while Instagram is a collection source, none otherwise; touches
 * only these ids.
 */
export async function syncDevCaptureScripts(
  api: ScriptingApi,
  enabled: boolean,
  instagramSource = false,
): Promise<void> {
  const wanted = DEV_CAPTURE_SCRIPTS.filter(
    (script) => enabled || (instagramSource && script.id === INSTAGRAM_ID),
  );
  const registered = await api.getRegisteredContentScripts({ ids: IDS });
  const same =
    registered.length === wanted.length &&
    wanted.every((script) => registered.some((r) => r.id === script.id));
  if (same) return;
  if (registered.length > 0) {
    await api.unregisterContentScripts({ ids: registered.map((script) => script.id) });
  }
  if (wanted.length > 0) await api.registerContentScripts(wanted);
}

function flag(settings: unknown, key: "devCaptureEnabled" | "collectFromInstagram"): boolean {
  return (settings as Record<string, unknown> | undefined)?.[key] === true;
}

/**
 * Keeps the registrations in step with the stored tick: once now (a
 * restarted worker, an update) and on every change. Syncs run one at a
 * time, each reading the setting afresh, so a quick on/off/on settles
 * on the last value instead of racing on duplicate ids.
 */
export function installDevCaptureScripts(
  api: ScriptingApi,
  storage: Pick<typeof chrome.storage, "local" | "onChanged">,
): () => Promise<void> {
  let work: Promise<void> = Promise.resolve();
  const sync = (): Promise<void> => {
    work = work
      .then(async () => {
        const settings = (await storage.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY];
        await syncDevCaptureScripts(
          api,
          flag(settings, "devCaptureEnabled"),
          flag(settings, "collectFromInstagram"),
        );
      })
      .catch((error: unknown) => {
        console.error(`[nmc] developer capture scripts not synced: ${String(error)}`);
      });
    return work;
  };
  storage.onChanged.addListener((changes, areaName) => {
    const change = changes[SETTINGS_STORAGE_KEY];
    if (areaName !== "local" || !change) return;
    const changed = (["devCaptureEnabled", "collectFromInstagram"] as const).some(
      (key) => flag(change.oldValue, key) !== flag(change.newValue, key),
    );
    if (changed) void sync();
  });
  void sync();
  return sync;
}
