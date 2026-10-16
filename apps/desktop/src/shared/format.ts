import { INTL_LOCALES, type UiLang } from "@nmc/core";
import { messages, say } from "./i18n.js";
import type { DesktopStatus } from "./status.js";

/** Display helpers shared by the monitor and the reading window. */

export function formatCount(value: number | null, lang: UiLang): string {
  return value === null ? "—" : value.toLocaleString(INTL_LOCALES[lang]);
}

export function formatCost(usd: number | null, lang: UiLang): string {
  if (usd === null) return "—";
  const digits = usd < 1 ? 3 : 2;
  return new Intl.NumberFormat(INTL_LOCALES[lang], {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(usd);
}

export function formatDuration(ms: number | null, lang: UiLang): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const m = messages(lang);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return m.seconds(seconds);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? m.minutes(minutes) : m.minutesSeconds(minutes, rest);
}

/** One status line for the monitor. */
export function describeRun(status: DesktopStatus): string {
  const { run, collection } = status;
  const m = messages(status.lang);
  switch (run.stage) {
    case "checking":
      return m.runChecking;
    case "filtering":
      return m.runFiltering;
    case "scoring":
      return m.runScoring(run.counts.afterHardFilter);
    case "verifying":
      return m.runVerifying(run.counts.verifyDone, run.counts.verifyTotal);
    case "rendering":
      return m.runRendering;
    case "ready":
      return m.runReady(run.counts.selected);
    case "error":
      return m.runError;
    case "cancelled":
      return m.runCancelled;
    case "idle":
      if (collection.state === "requested") return m.collectRequested;
      if (collection.state === "cancelling") return m.collectCancelling;
      if (collection.state === "collecting") {
        // Several feeds: each one's count (custom sites alone: nothing to count).
        if (collection.sources && collection.sources.length > 0) {
          return m.collectProgressFeeds(collection.sources, collection.target);
        }
        if (collection.count !== null && collection.target) {
          return m.collectProgress(collection.count, collection.target);
        }
        return collection.target ? m.collectTarget(collection.target) : m.collectAny;
      }
      return m.idle;
  }
}

export function describeLink(status: DesktopStatus): string {
  const { link } = status;
  const m = messages(status.lang);
  if (link.error) return say(status.lang, link.error);
  if (!link.listening) return m.linkOpening;
  if (link.hosts === 0) return m.linkNoBrowser;
  return link.hosts === 1 ? m.linkOne : m.linkMany(link.hosts);
}

/** Monitor note on Mode B sessions whose collection never completed; empty when none. */
export function describeUnfinished(status: DesktopStatus): string {
  const { count, newestAt } = status.unfinished;
  return count === 0 ? "" : messages(status.lang).unfinished(count, newestAt);
}
