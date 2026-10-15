import { messages } from "./i18n.js";
import { isRunActive, type DesktopStatus } from "./status.js";

/**
 * The monitor's buttons. One primary action in every state (owner's
 * rule: two buttons doing the same thing is one too many); "Collect new
 * timeline" stays reachable as a small secondary link whenever the
 * primary action is something else and nothing is running.
 *
 * - `cancel`: stops the run, or the collection (via the extension);
 * - `build`: builds the pending collection;
 * - `rebuild`: runs the cancelled run's session again (no new collection);
 * - `retry`: the same after an error.
 */
export type MonitorAction = "collect" | "cancel" | "build" | "rebuild" | "retry";

export interface MonitorActions {
  primary: MonitorAction;
  label: string;
  disabled: boolean;
  /** Show the secondary "Collect new timeline" link. */
  collectLink: boolean;
}

export function monitorActions(status: DesktopStatus): MonitorActions {
  const { run, collection, pending } = status;
  const m = messages(status.lang);
  if (isRunActive(run.stage)) {
    return { primary: "cancel", label: m.cancelRun, disabled: false, collectLink: false };
  }
  if (collection.state === "cancelling") {
    return { primary: "cancel", label: m.cancelling, disabled: true, collectLink: false };
  }
  if (collection.state === "requested" || collection.state === "collecting") {
    return {
      primary: "cancel",
      label: m.cancelCollection,
      disabled: false,
      collectLink: false,
    };
  }
  if (pending) {
    return {
      primary: "build",
      label: pending.mode === "B" ? m.buildAnyway : m.buildTimeline,
      disabled: false,
      collectLink: true,
    };
  }
  if (run.sessionId !== null && run.stage === "error") {
    return {
      primary: "retry",
      label: m.retrySame,
      disabled: false,
      collectLink: true,
    };
  }
  if (run.sessionId !== null && run.stage === "cancelled") {
    const posts = run.counts.postsIn;
    return {
      primary: "rebuild",
      label: posts === null ? m.rebuildSame : m.rebuildFrom(posts),
      disabled: false,
      collectLink: true,
    };
  }
  return {
    primary: "collect",
    label: m.collectNew,
    disabled: !status.link.listening,
    collectLink: false,
  };
}
