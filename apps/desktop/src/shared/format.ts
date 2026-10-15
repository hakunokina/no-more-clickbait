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
