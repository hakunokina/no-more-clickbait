import {
  SiteRuleSchema,
  parseSiteRule,
  serializeSiteRule,
  type SiteRule,
  type SiteRuleInput,
} from "@nmc/core";
import { withKeyLock } from "./key-lock.js";
import {
  LEGACY_SITE_STATES_KEY,
  SITE_RULES_KEY,
  siteStateKey,
  siteStatesIn,
} from "./storage-keys.js";

/**
 * Custom site rules + their runtime state in `chrome.storage.local`.
 * Rules are exported (JSON); states (health counters, permission flags)
 * never leave the device. Import is validated by core's `parseSiteRule`:
 * a rule is data, never code, so the worst an import can do is pick the
 * wrong elements (design: docs/design/rule-picker.md).
 */

export { SITE_RULES_KEY };

/** Minimal `chrome.storage` area surface (fakeable in tests); `null` reads the whole area. */
export interface StorageArea {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/**
 * What the last collect said about the rule. `fetch-error` (network/HTTP)
 * is kept apart from rule health: a 503 must not count towards "broken".
 * `visible-tab`: nothing came without a visible page; `page-note`: the
 * page method waits for its one-time note in Options; `json-unsupported`:
 * the "more" response is JSON, which rules cannot read yet.
 */
export type CollectVerdict =
  | "ok"
  | "few-items"
  | "low-coverage"
  | "broken"
  | "fetch-error"
  | "visible-tab"
  | "page-note"
  | "json-unsupported";

export interface SiteState {
  enabled: boolean;
  /** The per-site host permission is currently granted. */
  permissionGranted: boolean;
  lastFetchedAt?: string;
  lastItemCount?: number;
  lastStatus?: CollectVerdict;
  /** The method that produced the last result ("rss", "static", …). */
  lastMethod?: string;
  /** Plain detail of the last failure (HTTP status, invalid selector…). */
  lastMessage?: string;
  /** Consecutive zero-item rule verdicts (fetch errors excluded). */
  consecutiveZero?: number;
  lastSuccessAt?: string;
  lastSuccessCount?: number;
  /** A slow median of successful counts: "usually N". */
  typicalCount?: number;
  /** Items the rule found when it was saved/imported ("found N on save"). */
  savedItemCount?: number;
  /** Static fetch has produced items for this rule (save probe or a collect). */
  staticKnownGood?: boolean;
  /** The user accepted the one-time note about opening the page in a hidden window. */
  pageNoteAccepted?: boolean;
  /** Last time the page's own "more" response was captured while the user browsed. */
  lastBrowseAt?: string;
}

export function defaultSiteState(): SiteState {
  return { enabled: true, permissionGranted: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Valid stored rules, by name; an entry that no longer validates is skipped. */
export async function loadSiteRules(area: StorageArea): Promise<SiteRule[]> {
  const stored = (await area.get([SITE_RULES_KEY]))[SITE_RULES_KEY];
  if (!isRecord(stored)) return [];
  const rules: SiteRule[] = [];
  for (const value of Object.values(stored)) {
    const parsed = SiteRuleSchema.safeParse(value);
    if (parsed.success) rules.push(parsed.data);
  }
  return rules.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveSiteRule(area: StorageArea, rule: SiteRuleInput): Promise<SiteRule> {
  const parsed = SiteRuleSchema.parse(rule);
  const stored = (await area.get([SITE_RULES_KEY]))[SITE_RULES_KEY];
  const all: Record<string, unknown> = isRecord(stored) ? { ...stored } : {};
  all[parsed.id] = parsed;
  await area.set({ [SITE_RULES_KEY]: all });
  return parsed;
}

export async function deleteSiteRule(area: StorageArea, id: string): Promise<void> {
  const stored = (await area.get([SITE_RULES_KEY]))[SITE_RULES_KEY];
  if (!isRecord(stored) || !(id in stored)) return;
  const all = { ...stored };
  delete all[id];
  await area.set({ [SITE_RULES_KEY]: all });
}

function asSiteState(value: unknown): SiteState | undefined {
  return isRecord(value) && typeof value["enabled"] === "boolean"
    ? ({ permissionGranted: false, ...value } as SiteState)
    : undefined;
}

/** Every stored site state (one key per site; see `SITE_STATE_PREFIX`). */
export async function loadSiteStates(area: StorageArea): Promise<Record<string, SiteState>> {
  const states: Record<string, SiteState> = {};
  for (const [id, value] of Object.entries(siteStatesIn(await area.get(null)))) {
    const state = asSiteState(value);
    if (state) states[id] = state;
  }
  return states;
}

export function stateOf(states: Record<string, SiteState>, id: string): SiteState {
  return states[id] ?? defaultSiteState();
}

/**
 * Read-modify-write of one site's state on its freshest stored value
 * (never on a copy read before a long collect), one step at a time per
 * site within this context.
 */
export function mutateSiteState(
  area: StorageArea,
  id: string,
  change: (current: SiteState) => SiteState,
): Promise<SiteState> {
  const key = siteStateKey(id);
  return withKeyLock(key, async () => {
    const current = asSiteState((await area.get([key]))[key]) ?? defaultSiteState();
    const next = change(current);
    await area.set({ [key]: next });
    return next;
  });
}

export function updateSiteState(
  area: StorageArea,
  id: string,
  patch: Partial<SiteState>,
): Promise<SiteState> {
  return mutateSiteState(area, id, (current) => ({ ...current, ...patch }));
}

/** Replaces one state as a whole (undo of a delete puts the old one back). */
export async function putSiteState(
  area: StorageArea,
  id: string,
  state: SiteState,
): Promise<void> {
  await mutateSiteState(area, id, () => state);
}

export function removeSiteState(area: StorageArea, id: string): Promise<void> {
  const key = siteStateKey(id);
  return withKeyLock(key, () => area.remove([key]));
}

/**
 * Moves states from the pre-#2023 shared map to per-site keys (a state
 * already under its own key wins), then drops the map. Idempotent.
 */
export async function migrateLegacySiteStates(area: StorageArea): Promise<void> {
  const legacy = (await area.get([LEGACY_SITE_STATES_KEY]))[LEGACY_SITE_STATES_KEY];
  if (legacy === undefined) return;
  if (isRecord(legacy)) {
    for (const [id, value] of Object.entries(legacy)) {
      const state = asSiteState(value);
      const key = siteStateKey(id);
      if (!state) continue;
      await withKeyLock(key, async () => {
        if ((await area.get([key]))[key] === undefined) await area.set({ [key]: state });
      });
    }
  }
  await area.remove([LEGACY_SITE_STATES_KEY]);
}

/** Export: the rule as pretty JSON (state stays local). */
export function exportSiteRule(rule: SiteRule): string {
  return serializeSiteRule(rule);
}

/** File name offered for an exported rule: "nmc-rule-news.example-world.json". */
export function exportFileName(rule: Pick<SiteRule, "id">): string {
  const slug = rule.id
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `nmc-rule-${slug || "site"}.json`;
}

export type ImportResult =
  { ok: true; rule: SiteRule } | { ok: false; errors: string[]; duplicateOf?: string };

/** Import: validated by core; a rule for an address that already has one is refused. */
export function importSiteRule(
  text: string,
  existing: ReadonlyArray<Pick<SiteRule, "id" | "url" | "name">>,
): ImportResult {
  const parsed = parseSiteRule(text);
  if (!parsed.ok) return parsed;
  const same = existing.find(
    (rule) => rule.id === parsed.rule.id || sameAddress(rule.url, parsed.rule.url),
  );
  if (same) return { ok: false, errors: [], duplicateOf: same.name };
  return parsed;
}

/** Two rule addresses are the same page: case-insensitive host, trailing "/" ignored. */
export function sameAddress(a: string, b: string): boolean {
  const norm = (url: string): string => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
    } catch {
      return url;
    }
  };
  return norm(a) === norm(b);
}

/** What a Sites row shows: settings first, then the last collect's verdict. */
export type RowStatus =
  | { kind: "off" }
  | { kind: "permission" }
  | { kind: "new"; savedItemCount: number }
  | { kind: "pending" }
  | { kind: "ok"; at: string; items: number }
  | { kind: "few-items"; at: string; items: number; typical?: number; minItems: number }
  | { kind: "low-coverage"; at: string; items: number }
  | { kind: "broken"; fails: number; lastSuccessAt?: string; lastSuccessCount?: number }
  | { kind: "fetch-error"; at: string; message?: string }
  | { kind: "visible-tab"; at: string }
  | { kind: "page-note" }
  | { kind: "json-unsupported"; at: string };

/** Three zero-item collects in a row read as "broken" (design: "Son 3 çekimde 0 öğe"). */
export const BROKEN_AFTER_ZERO = 3;

export function rowStatus(rule: Pick<SiteRule, "health">, state: SiteState): RowStatus {
  if (!state.enabled) return { kind: "off" };
  if (!state.permissionGranted) return { kind: "permission" };
  const at = state.lastFetchedAt ?? "";
  const last: CollectVerdict | undefined = state.lastStatus;
  switch (last) {
    case undefined:
      return state.savedItemCount !== undefined
        ? { kind: "new", savedItemCount: state.savedItemCount }
        : { kind: "pending" };
    case "ok":
      return { kind: "ok", at, items: state.lastItemCount ?? 0 };
    case "few-items":
      return {
        kind: "few-items",
        at,
        items: state.lastItemCount ?? 0,
        minItems: rule.health.minItems,
        ...(state.typicalCount !== undefined ? { typical: state.typicalCount } : {}),
      };
    case "low-coverage":
      return { kind: "low-coverage", at, items: state.lastItemCount ?? 0 };
    case "broken":
      return {
        kind: "broken",
        fails: Math.max(1, state.consecutiveZero ?? 1),
        ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
        ...(state.lastSuccessCount !== undefined
          ? { lastSuccessCount: state.lastSuccessCount }
          : {}),
      };
    case "fetch-error":
      return {
        kind: "fetch-error",
        at,
        ...(state.lastMessage ? { message: state.lastMessage } : {}),
      };
    case "visible-tab":
      return { kind: "visible-tab", at };
    case "page-note":
      return { kind: "page-note" };
    case "json-unsupported":
      return { kind: "json-unsupported", at };
  }
}

/**
 * Folds one collect into the state. Zero-item rule verdicts accumulate
 * (`BROKEN_AFTER_ZERO` in a row is "broken"); fetch errors and the
 * method-level verdicts (visible tab, page note, JSON) leave the health
 * counters alone; a success refreshes `typicalCount` as a slow median.
 */
export function recordCollect(
  state: SiteState,
  verdict: CollectVerdict,
  itemCount: number,
  nowIso: string,
  detail: { method?: string; message?: string } = {},
): SiteState {
  const base: SiteState = { ...state, lastFetchedAt: nowIso, lastStatus: verdict };
  delete base.lastMessage;
  delete base.lastMethod;
  if (detail.method) base.lastMethod = detail.method;
  if (detail.message) base.lastMessage = detail.message;
  if (
    verdict === "fetch-error" ||
    verdict === "visible-tab" ||
    verdict === "page-note" ||
    verdict === "json-unsupported"
  ) {
    return base;
  }
  const consecutiveZero = itemCount === 0 ? (state.consecutiveZero ?? 0) + 1 : 0;
  const status: CollectVerdict =
    itemCount === 0 && (verdict === "broken" || consecutiveZero >= BROKEN_AFTER_ZERO)
      ? "broken"
      : verdict === "broken" && itemCount > 0
        ? "few-items"
        : verdict;
  const next: SiteState = {
    ...base,
    lastStatus: status,
    lastItemCount: itemCount,
    consecutiveZero,
  };
  if (itemCount > 0) {
    next.lastSuccessAt = nowIso;
    next.lastSuccessCount = itemCount;
  }
  if (status === "ok") {
    next.typicalCount =
      state.typicalCount === undefined
        ? itemCount
        : Math.round(state.typicalCount + (itemCount - state.typicalCount) / 4);
  }
  return next;
}
