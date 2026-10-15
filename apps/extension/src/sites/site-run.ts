import type { FeedBatch, SiteCollectOutcome, SiteRule } from "@nmc/core";
import {
  collectSite,
  type CollectContext,
  type CollectDeps,
  type RequestBuffer,
  type SiteCollectResult,
} from "./site-collect.js";
import { recordCollect, stateOf, type SiteState } from "./site-store.js";

/**
 * Custom sites in a collection (leader decision #777): when the desktop
 * asks for a collection (Mode B) or the user's own scrolling reaches the
 * X target (Mode A), every enabled and permitted site is collected in
 * parallel with X. Each site has its own time limit; one site's failure
 * never fails the others or the X collection. Items go to the open host
 * session as `feed-batch` (never touching the X counters); every site's
 * outcome rides on `collection-complete`.
 */

export const SITE_TIMEOUT_MS = 90_000;
/** Items per `feed-batch` message (the schema allows 500). */
export const FEED_BATCH_SIZE = 200;

export interface SiteRunDeps {
  collect: CollectDeps;
  sendBatch(batch: FeedBatch): boolean;
  /**
   * Folds the collect into the site's freshest stored state (not the copy
   * read when the run started: the user may toggle or revoke meanwhile).
   */
  updateState(id: string, change: (current: SiteState) => SiteState): Promise<SiteState>;
  /** Puts "more" items back when their collect timed out (they were never sent). */
  restoreRequestBuffer?(siteId: string, buffer: RequestBuffer): Promise<void>;
  now(): string;
  timeoutMs?: number;
}

/** Rules a collection includes: enabled and permitted. */
export function collectableRules(
  rules: readonly SiteRule[],
  states: Readonly<Record<string, SiteState>>,
): SiteRule[] {
  return rules.filter((rule) => {
    const state = states[rule.id];
    return state?.enabled !== false && state?.permissionGranted === true;
  });
}

export function contextFor(state: SiteState): CollectContext {
  return {
    pageNoteAccepted: state.pageNoteAccepted === true,
    staticKnownGood: state.staticKnownGood === true,
  };
}

/** Collects one site, records its state and sends its items; never throws. */
export async function runOneSite(
  rule: SiteRule,
  state: SiteState,
  deps: SiteRunDeps,
): Promise<{ outcome: SiteCollectOutcome; state: SiteState; result?: SiteCollectResult }> {
  const timeoutMs = deps.timeoutMs ?? SITE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  // A timed-out collect keeps running unseen: its "more" items must not
  // vanish with it — what it took goes back, and it takes nothing after.
  let abandoned = false;
  const taken: RequestBuffer[] = [];
  const giveBack = async (buffer: RequestBuffer): Promise<void> => {
    await deps.restoreRequestBuffer?.(rule.id, buffer).catch(() => undefined);
  };
  const collect: CollectDeps = {
    ...deps.collect,
    async takeRequestBuffer(siteId) {
      if (abandoned) return null;
      const buffer = await deps.collect.takeRequestBuffer(siteId);
      if (buffer && abandoned) await giveBack(buffer);
      else if (buffer) taken.push(buffer);
      return buffer;
    },
  };
  let result: SiteCollectResult | "timeout";
  try {
    result = await Promise.race([collectSite(rule, collect, contextFor(state)), timeout]);
  } catch (error) {
    result = { method: "static", items: [], verdict: "fetch-error", message: String(error) };
  } finally {
    clearTimeout(timer);
  }
  const now = deps.now();
  if (result === "timeout") {
    abandoned = true;
    for (const buffer of taken) await giveBack(buffer);
    const next = await saveCollect(rule.id, state, deps, (current) =>
      recordCollect(current, "fetch-error", 0, now, { message: "timed out" }),
    );
    return {
      outcome: {
        siteId: rule.id,
        status: "timeout",
        itemCount: 0,
        message: `no answer in ${Math.round(timeoutMs / 1000)} s`,
      },
      state: next,
    };
  }

  let sent = 0;
  for (let i = 0; i < result.items.length; i += FEED_BATCH_SIZE) {
    const items = result.items.slice(i, i + FEED_BATCH_SIZE);
    if (deps.sendBatch({ siteId: rule.id, capturedAt: now, items })) sent += items.length;
  }
  const done = result;
  const next = await saveCollect(rule.id, state, deps, (current) => {
    const recorded = recordCollect(current, done.verdict, done.items.length, now, {
      method: done.method,
      ...(done.message ? { message: done.message } : {}),
    });
    return done.staticWorked ? { ...recorded, staticKnownGood: true } : recorded;
  });
  return { outcome: outcomeOf(rule.id, result, sent), state: next, result };
}

/** Stores the collect; if storage fails, the run still answers with the folded state. */
async function saveCollect(
  id: string,
  state: SiteState,
  deps: SiteRunDeps,
  change: (current: SiteState) => SiteState,
): Promise<SiteState> {
  return deps.updateState(id, change).catch(() => change(state));
}

function outcomeOf(
  siteId: string,
  result: SiteCollectResult,
  sent: number,
): SiteCollectOutcome {
  const outcome: SiteCollectOutcome = {
    siteId,
    method: result.method,
    itemCount: sent,
    status:
      result.items.length > 0
        ? sent < result.items.length
          ? "error"
          : "ok"
        : result.verdict === "fetch-error"
          ? "error"
          : result.verdict === "page-note"
            ? "skipped"
            : "empty",
  };
  const message =
    sent < result.items.length
      ? "the desktop link was not open; items not delivered"
      : (result.message ?? (result.items.length === 0 ? result.verdict : undefined));
  if (message) outcome.message = message.slice(0, 300);
  return outcome;
}

/** Every collectable site in parallel; outcomes in rule order. */
export async function runSites(
  rules: readonly SiteRule[],
  states: Readonly<Record<string, SiteState>>,
  deps: SiteRunDeps,
): Promise<SiteCollectOutcome[]> {
  const runs = collectableRules(rules, states).map((rule) =>
    runOneSite(rule, stateOf(states as Record<string, SiteState>, rule.id), deps).then(
      (run) => run.outcome,
    ),
  );
  return Promise.all(runs);
}
