import type { DesktopStatus } from "./status.js";

/** Display helpers shared by the monitor and the reading window. */

export function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

export function formatCost(usd: number | null): string {
  return usd === null ? "—" : `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** One status line for the monitor (English, like the rest of the window). */
export function describeRun(status: DesktopStatus): string {
  const { run, collection } = status;
  switch (run.stage) {
    case "checking":
      return "Checking the claude CLI…";
    case "filtering":
      return "Filtering ads and repeats…";
    case "scoring":
      return `Scoring ${formatCount(run.counts.afterHardFilter)} posts…`;
    case "verifying":
      return `Verifying claims ${run.counts.verifyDone}/${run.counts.verifyTotal}…`;
    case "rendering":
      return "Writing the timeline…";
    case "ready":
      return `Ready — ${formatCount(run.counts.selected)} posts`;
    case "error":
      return "The timeline could not be prepared";
    case "cancelled":
      return "Run cancelled";
    case "idle":
      if (collection.state === "requested") return "Asking the extension to collect…";
      if (collection.state === "collecting") {
        if (collection.count !== null && collection.target) {
          return `Collecting in the browser… ${formatCount(collection.count)} / ${formatCount(collection.target)} posts`;
        }
        return collection.target
          ? `Collecting ${collection.target} posts in the browser…`
          : "Collecting posts in the browser…";
      }
      return "Idle";
  }
}

export function describeLink(status: DesktopStatus): string {
  const { link } = status;
  if (link.error) return link.error;
  if (!link.listening) return "Opening the browser link…";
  if (link.hosts === 0)
    return "Browser extension not connected (open Brave/Chrome with the extension).";
  return link.hosts === 1
    ? "Browser extension connected."
    : `${link.hosts} browsers connected.`;
}

const STOP_REASONS: Record<string, string> = {
  "target-reached": "target reached",
  timeout: "time limit reached",
  stalled: "no new posts for about 20 s of scrolling",
  "not-logged-in": "not logged in to X in this browser",
  "error-page": "X showed an error page",
  "navigated-away": "the tab left x.com/home",
  "rate-limited": "X rate-limited the timeline",
  "page-unresponsive": "the page stopped answering scroll steps",
  "tab-closed": "the collection tab was closed",
  cancelled: "stopped by you",
  "settings-changed": "the extension's settings changed during the run",
  "failed-to-open": "the collection tab or window could not be opened",
};

/** Why a collection ended, in words (unknown reasons as they came). */
export function describeStopReason(reason: string): string {
  return STOP_REASONS[reason] ?? reason;
}

/** Monitor note on sessions whose collection never completed; empty when none. */
export function describeUnfinished(status: DesktopStatus): string {
  const { count, newestAt } = status.unfinished;
  if (count === 0) return "";
  const when = newestAt ? ` (latest started ${new Date(newestAt).toLocaleString()})` : "";
  return count === 1
    ? `1 earlier collection never finished${when}. Its posts stay on disk; it is not built.`
    : `${count} earlier collections never finished${when}. Their posts stay on disk; they are not built.`;
}
