import { ModeBRunSummarySchema, type ModeBRunSummary, type ModeBStrategy } from "@nmc/core";
import type { ModeBCommandMessage } from "./messages.js";
import {
  describeStopReason,
  MODE_B_LAST_RUN_KEY,
  MODE_B_PERMISSIONS,
  MODE_B_RUN_KEY,
} from "./mode-b.js";
import { loadSettings } from "./settings.js";

/**
 * The "Collect feed (N)" control shared by the popup and the options
 * page. The worker owns the run; these pages only send start/stop and
 * render what it keeps in storage (session: the run in progress,
 * local: the last finished run).
 */

export const STRATEGY_LABEL: Record<ModeBStrategy, string> = {
  "minimized-window": "minimized window",
  "background-tab": "background tab",
  "offscreen-window": "off-screen window",
};

export interface ModeBControls {
  button: HTMLButtonElement;
  status: HTMLElement;
  /** Options page only: the last run's numbers. */
  lastRun?: HTMLElement | null;
}

/** Must be called inside the click/submit handler, before any await (user gesture). */
export function requestModeBPermissions(): Promise<boolean> {
  return chrome.permissions.request({ permissions: MODE_B_PERMISSIONS }).catch(() => false);
}

function send(command: ModeBCommandMessage["command"]): void {
  const message: ModeBCommandMessage = { kind: "mode-b-command", command };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function runningCount(value: unknown): { count: number; target: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const count = v["uniquePostCount"];
  const target = v["target"];
  return typeof count === "number" && typeof target === "number" ? { count, target } : null;
}

export function lastRunLine(run: ModeBRunSummary): string {
  return (
    `Last run: ${run.uniquePostCount} / ${run.target} posts via ` +
    `${STRATEGY_LABEL[run.strategy]} — ${describeStopReason(run.stopReason)}.`
  );
}

/** Label/value rows for the options page's last-run summary. */
export function lastRunRows(run: ModeBRunSummary): [string, string][] {
  return [
    ["Result", describeStopReason(run.stopReason)],
    ["Hidden surface", STRATEGY_LABEL[run.strategy]],
    [
      "Distinct posts",
      `${run.uniquePostCount} of ${run.target} (counted by the ${run.counter})`,
    ],
    ["Duration", `${(run.durationMs / 1000).toFixed(1)} s`],
    ["Scroll steps", `${run.scrollCount} (position moved in ${run.scrollMovedCount})`],
    ["Steps while page hidden", String(run.hiddenStepCount)],
    ["Timeline responses", String(run.responseCount)],
    ["Ended", new Date(run.endedAt).toLocaleString()],
  ];
}

function renderRows(target: HTMLElement, rows: [string, string][]): void {
  target.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

export function bindModeBControls({ button, status, lastRun }: ModeBControls): void {
  let running = false;

  const render = async (): Promise<void> => {
    const settings = await loadSettings();
    const current = runningCount(
      (await chrome.storage.session.get(MODE_B_RUN_KEY))[MODE_B_RUN_KEY],
    );
    const last = ModeBRunSummarySchema.safeParse(
      (await chrome.storage.local.get(MODE_B_LAST_RUN_KEY))[MODE_B_LAST_RUN_KEY],
    );
    running = current !== null;
    button.disabled = !settings.modeBEnabled && !running;
    if (running && current) {
      button.textContent = "Stop collecting";
      status.textContent = `Collecting in the background… ${current.count} / ${current.target} distinct posts.`;
    } else {
      button.textContent = `Collect feed (${settings.modeBTarget})`;
      status.textContent = !settings.modeBEnabled
        ? "Mode B is off — turn it on in Options to collect automatically."
        : last.success
          ? lastRunLine(last.data)
          : "No run yet.";
    }
    if (lastRun) {
      if (last.success) renderRows(lastRun, lastRunRows(last.data));
      else lastRun.replaceChildren();
    }
  };

  const refresh = (): void => {
    void render().catch(() => {
      status.textContent = "Could not read the Mode B state.";
    });
  };

  button.addEventListener("click", () => {
    if (running) {
      send("stop");
      return;
    }
    const permission = requestModeBPermissions();
    void permission.then((granted) => {
      if (granted) send("start");
      else status.textContent = "Mode B needs the “alarms” permission to run.";
    });
  });
  chrome.storage.onChanged.addListener(refresh);
  refresh();
}
