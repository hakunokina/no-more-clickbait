import type { ExtractStats } from "./extract.js";
import { RULE_FIELD_NAMES, type RuleFieldName, type SiteRule } from "./site-rule.js";

/**
 * One fetch's verdict on a rule. Only about what the rule extracted: a
 * network/HTTP failure is not a rule failure and must not reach here
 * (the caller records "could not fetch" separately).
 */
export type RuleHealthStatus = "ok" | "few-items" | "low-coverage" | "broken";

export interface RuleHealth {
  status: RuleHealthStatus;
  /** One plain sentence for the rule's row. */
  reason: string;
  /** Configured fields found in fewer items than `health.minCoverage`. */
  lowFields: RuleFieldName[];
}

/**
 * broken: the item selector is invalid or kept nothing, or no item has
 * a title or a text; few-items: below `health.minItems`; low-coverage:
 * a configured field is missing from too many items. The worst one
 * wins; `lowFields` is filled whenever items exist.
 */
export function assessRuleHealth(
  stats: ExtractStats,
  rule: Pick<SiteRule, "item" | "fields" | "health">,
): RuleHealth {
  if (rule.item && stats.invalidSelectors.includes(rule.item.selector)) {
    return broken(`The card selector "${rule.item.selector}" is not valid on this page.`);
  }
  if (stats.matched === 0) return broken("The card selector matched nothing on the page.");
  if (stats.items === 0) {
    const why =
      stats.excluded === stats.matched
        ? `all ${stats.matched} cards were excluded`
        : `${stats.matched} cards matched but none had a title or text`;
    return broken(`No items: ${why}.`);
  }
  if (stats.coverage.title === 0 && stats.coverage.text === 0) {
    return broken("No item has a title or a text.");
  }

  const configured = RULE_FIELD_NAMES.filter((name) => rule.fields?.[name]);
  const lowFields = configured.filter(
    (name) => stats.coverage[name] / stats.items < rule.health.minCoverage,
  );
  if (stats.items < rule.health.minItems) {
    const noun = stats.items === 1 ? "item" : "items";
    return {
      status: "few-items",
      reason: `Only ${stats.items} ${noun} (expected at least ${rule.health.minItems}).`,
      lowFields,
    };
  }
  if (lowFields.length > 0) {
    const detail = lowFields
      .map((name) => `${name} ${stats.coverage[name]}/${stats.items}`)
      .join(", ");
    return { status: "low-coverage", reason: `Fields often missing: ${detail}.`, lowFields };
  }
  return { status: "ok", reason: `${stats.items} items.`, lowFields: [] };
}

function broken(reason: string): RuleHealth {
  return { status: "broken", reason, lowFields: [] };
}
