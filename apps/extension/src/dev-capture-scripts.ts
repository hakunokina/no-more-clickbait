import { SETTINGS_STORAGE_KEY } from "./settings-key.js";

/**
 * The Reddit and Instagram MAIN-world response listeners wrap the page's
 * `fetch` and `XMLHttpRequest`. They exist for developer capture only, so
 * they are registered only while the tick is on — otherwise every
 * Reddit/Instagram page would carry non-native `fetch`/XHR (visible to
 * the site's integrity checks) for a feature the user never turned on.
 * The isolated relays stay in the manifest: they touch no page global,
 * and their match patterns are what lets these scripts inject. A tab
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

/** The `chrome.scripting` surface used here (fakeable in tests). */
export interface ScriptingApi {
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<{ id: string }[]>;
  registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
}

/** Registers both scripts when `enabled`, none otherwise; touches only these ids. */
export async function syncDevCaptureScripts(
  api: ScriptingApi,
  enabled: boolean,
): Promise<void> {
  const registered = await api.getRegisteredContentScripts({ ids: IDS });
  if (enabled && registered.length === IDS.length) return;
  if (registered.length > 0) {
    await api.unregisterContentScripts({ ids: registered.map((script) => script.id) });
  }
  if (enabled) await api.registerContentScripts(DEV_CAPTURE_SCRIPTS);
}

function devCaptureFlag(settings: unknown): boolean {
  return (settings as Record<string, unknown> | undefined)?.["devCaptureEnabled"] === true;
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
        const stored = await storage.local.get(SETTINGS_STORAGE_KEY);
        await syncDevCaptureScripts(api, devCaptureFlag(stored[SETTINGS_STORAGE_KEY]));
      })
      .catch((error: unknown) => {
        console.error(`[nmc] developer capture scripts not synced: ${String(error)}`);
      });
    return work;
  };
  storage.onChanged.addListener((changes, areaName) => {
    const change = changes[SETTINGS_STORAGE_KEY];
    if (areaName !== "local" || !change) return;
    if (devCaptureFlag(change.oldValue) !== devCaptureFlag(change.newValue)) void sync();
  });
  void sync();
  return sync;
}
