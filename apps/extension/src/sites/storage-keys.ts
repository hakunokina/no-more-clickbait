/** chrome.storage keys of the Sites feature (zod-free, for content scripts). */

/** local: `{ [ruleId]: SiteRule }`. Exportable data. */
export const SITE_RULES_KEY = "nmc.siteRules";
/** local: `{ [ruleId]: SiteState }`. Health and permission state; never exported. */
export const SITE_STATES_KEY = "nmc.siteStates";
/** session: `{ [ruleId]: { items, lastAt } }`, the captured "more" items until a collect takes them. */
export const SITE_REQUEST_BUFFER_KEY = "nmc.siteRequestBuffer";
/** session: the rule id Options should highlight after the picker saved it. */
export const SITE_NEW_RULE_KEY = "nmc.siteNewRule";
/** session: tab ids the picker was opened in (only they may save through it). */
export const SITE_PICKER_TABS_KEY = "nmc.sitePickerTabs";
