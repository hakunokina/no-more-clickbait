/** chrome.storage keys of the Sites feature (zod-free, for content scripts). */

/** local: `{ [ruleId]: SiteRule }`. Exportable data. */
export const SITE_RULES_KEY = "nmc.siteRules";
/**
 * local: one `SiteState` per rule under `nmc.siteState.<ruleId>`; health and
 * permission state, never exported. One key per site, not one shared map:
 * two writers (parallel collects, the worker and Options) changing two
 * different sites never read-modify-write the same value.
 */
export const SITE_STATE_PREFIX = "nmc.siteState.";
/** local: the pre-#2023 shared map of states; moved to per-site keys on worker start. */
export const LEGACY_SITE_STATES_KEY = "nmc.siteStates";
/** session: `{ items, lastAt }` per rule under `nmc.siteRequestBuffer.<ruleId>`, the captured "more" items until a collect takes them. */
export const SITE_REQUEST_BUFFER_PREFIX = "nmc.siteRequestBuffer.";
/** session: the rule id Options should highlight after the picker saved it. */
export const SITE_NEW_RULE_KEY = "nmc.siteNewRule";
/** session: tab ids the picker was opened in (only they may save through it). */
export const SITE_PICKER_TABS_KEY = "nmc.sitePickerTabs";

export function siteStateKey(ruleId: string): string {
  return SITE_STATE_PREFIX + ruleId;
}

export function requestBufferKey(ruleId: string): string {
  return SITE_REQUEST_BUFFER_PREFIX + ruleId;
}

/** The raw per-site states in a whole-area read, by rule id. */
export function siteStatesIn(stored: Record<string, unknown>): Record<string, unknown> {
  const states: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(SITE_STATE_PREFIX)) states[key.slice(SITE_STATE_PREFIX.length)] = value;
  }
  return states;
}

/** A storage change touches the rules or any site's state. */
export function touchesSites(changedKeys: string[]): boolean {
  return changedKeys.some((key) => key === SITE_RULES_KEY || key.startsWith(SITE_STATE_PREFIX));
}
