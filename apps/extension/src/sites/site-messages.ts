import type { SiteRule, SiteRuleInput } from "@nmc/core";
import type { CollectVerdict } from "./site-store.js";

/**
 * Messages from the Options page and the in-page picker to the worker
 * (site-worker.ts), which owns tabs, injection, the offscreen document
 * and the desktop link. Every sender is checked there: extension pages
 * only, except the picker's own messages, which must come from the tab
 * the worker opened it in.
 */

/** What the picker opens for: a new rule, or re-picking a saved one. */
export interface PickerTarget {
  url: string;
  pattern: string;
  /** The saved rule's id when re-picking. */
  repickOf?: string;
}

/** Options → worker: open the page and the picker on it. */
export interface SitePickerOpenMessage {
  kind: "site-picker-open";
  target: PickerTarget;
}

/** Worker → picker (after injection): what to pick, and the saved rule when re-picking. */
export interface SitePickerInitMessage {
  kind: "site-picker-init";
  target: PickerTarget;
  rule?: SiteRule;
}

/** Picker → worker: validate, store, test once statically; answers `SitePickerSaveAnswer`. */
export interface SitePickerSaveMessage {
  kind: "site-picker-save";
  rule: SiteRuleInput;
  /** Items the preview found on the live page. */
  foundCount: number;
}

export type SitePickerSaveAnswer =
  { ok: true; id: string; staticWorked: boolean } | { ok: false; message: string };

/** Picker/Options → worker: run a rule once without delivering items; answers `SiteProbeAnswer`. */
export interface SiteProbeMessage {
  kind: "site-probe";
  rule: SiteRuleInput;
}

export interface SiteProbeAnswer {
  ok: boolean;
  count: number;
  verdict?: CollectVerdict;
  method?: string;
  staticWorked?: boolean;
  message?: string;
}

/** Picker → worker: put the response hook into this tab (MAIN world) to detect "more". */
export interface SitePickerHookMessage {
  kind: "site-picker-hook";
}

/** Picker → worker: show the Options page (highlighting the saved rule), the picker closes. */
export interface SiteOpenOptionsMessage {
  kind: "site-open-options";
}

/** Options → worker: collect one site now in a visible tab ("Collect on the page"). */
export interface SiteCollectVisibleMessage {
  kind: "site-collect-visible";
  id: string;
}

export type SiteWorkerMessage =
  | SitePickerOpenMessage
  | SitePickerSaveMessage
  | SiteProbeMessage
  | SitePickerHookMessage
  | SiteOpenOptionsMessage
  | SiteCollectVisibleMessage;

const KINDS: ReadonlySet<string> = new Set([
  "site-picker-open",
  "site-picker-save",
  "site-probe",
  "site-picker-hook",
  "site-open-options",
  "site-collect-visible",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function isTarget(value: unknown): value is PickerTarget {
  const v = record(value);
  return (
    typeof v?.["url"] === "string" &&
    typeof v["pattern"] === "string" &&
    (v["repickOf"] === undefined || typeof v["repickOf"] === "string")
  );
}

/** Shape check only; rules are validated with core's schema by the worker. */
export function isSiteWorkerMessage(value: unknown): value is SiteWorkerMessage {
  const v = record(value);
  const kind = v?.["kind"];
  if (typeof kind !== "string" || !KINDS.has(kind)) return false;
  switch (kind) {
    case "site-picker-open":
      return isTarget(v?.["target"]);
    case "site-picker-save":
      return record(v?.["rule"]) !== null && typeof v?.["foundCount"] === "number";
    case "site-probe":
      return record(v?.["rule"]) !== null;
    case "site-collect-visible":
      return typeof v?.["id"] === "string";
    default:
      return true;
  }
}

export function isSitePickerInitMessage(value: unknown): value is SitePickerInitMessage {
  const v = record(value);
  return v?.["kind"] === "site-picker-init" && isTarget(v["target"]);
}
