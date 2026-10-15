import type { SiteRule } from "@nmc/core";
import { originPattern } from "./site-permissions.js";
import type { SiteState } from "./site-store.js";

/**
 * Registration of the "more" capture scripts (site-hook.ts in the MAIN
 * world + site-relay.ts beside it). Leader decision #779: registered
 * only for sites whose rule is enabled, has an HTML `request` pattern
 * and whose permission is granted — re-synced whenever rules, states or
 * permissions change, so revoking or deleting unregisters them.
 */

export const HOOK_SCRIPT_ID = "nmc-site-hook";
export const RELAY_SCRIPT_ID = "nmc-site-relay";

/** The `chrome.scripting` surface used here (fakeable in tests). */
export interface ScriptingApi {
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<{ id: string }[]>;
  registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
}

/** Origins the hook should run on, sorted (stable for comparison). */
export function hookOrigins(
  rules: ReadonlyArray<Pick<SiteRule, "id" | "url" | "collect">>,
  states: Readonly<Record<string, SiteState>>,
): string[] {
  const origins = new Set<string>();
  for (const rule of rules) {
    const state = states[rule.id];
    if (!state?.enabled || !state.permissionGranted) continue;
    if (rule.collect.request?.format !== "html") continue;
    const origin = originPattern(rule.url);
    if (origin) origins.add(origin);
  }
  return [...origins].sort();
}

/** Re-registers both scripts for exactly `origins` (none: both removed). */
export async function syncHookRegistrations(
  api: ScriptingApi,
  origins: string[],
): Promise<void> {
  const ids = [HOOK_SCRIPT_ID, RELAY_SCRIPT_ID];
  const registered = await api.getRegisteredContentScripts({ ids });
  if (registered.length > 0) {
    await api.unregisterContentScripts({ ids: registered.map((script) => script.id) });
  }
  if (origins.length === 0) return;
  await api.registerContentScripts([
    {
      id: HOOK_SCRIPT_ID,
      matches: origins,
      js: ["site-hook.js"],
      world: "MAIN",
      runAt: "document_start",
      persistAcrossSessions: true,
    },
    {
      id: RELAY_SCRIPT_ID,
      matches: origins,
      js: ["site-relay.js"],
      runAt: "document_start",
      persistAcrossSessions: true,
    },
  ]);
}
