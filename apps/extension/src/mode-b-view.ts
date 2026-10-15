import {
  ModeBPacingSchema,
  ModeBRunSummarySchema,
  type ModeBPacing,
  type ModeBRunSummary,
  type ModeBStrategy,
} from "@nmc/core";
import type { ModeBCommandMessage } from "./messages.js";
import {
  describeStopReason,
  loadModeBPacing,
  MODE_B_LAST_RUN_KEY,
  MODE_B_PACING_KEY,
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
  "offscreen-window": "small window in the screen corner (visible)",
};

export const PACING_LABEL: Record<ModeBPacing, string> = {
  response: "wait for X to answer each scroll",
  fixed: "fixed fast timer (0.36–0.70 s)",
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
    `${STRATEGY_LABEL[run.strategy]} — ${describeStopReason(run.stopReason)}` +
    `${run.error === undefined ? "" : ` (${run.error})`}.`
  );
}

/** Label/value rows for the options page's last-run summary. */
export function lastRunRows(run: ModeBRunSummary): [string, string][] {
  const rows: [string, string][] = [["Result", describeStopReason(run.stopReason)]];
  if (run.error !== undefined) rows.push(["Error", `${run.stopReason}: ${run.error}`]);
  rows.push(
    ["Hidden surface", STRATEGY_LABEL[run.strategy]],
    ["Pacing", run.pacing === undefined ? "—" : PACING_LABEL[run.pacing]],
    [
      "Distinct posts",
      `${run.uniquePostCount} of ${run.target} (counted by the ${run.counter})`,
    ],
    ["Duration", `${(run.durationMs / 1000).toFixed(1)} s`],
    ["Scroll steps", `${run.scrollCount} (position moved in ${run.scrollMovedCount})`],
    [
      "Scrolls per minute",
      run.scrollsPerMinute === undefined ? "—" : String(run.scrollsPerMinute),
    ],
    ["Steps while page hidden", String(run.hiddenStepCount)],
    [
      "Timeline responses",
      run.responseCount === 0 && run.stopReason !== "failed-to-open"
        ? "0 — X never loaded the timeline in the run's tab"
        : String(run.responseCount),
    ],
    [
      "Steps that brought a new response (after the first)",
      run.stepsWithNewResponse === undefined ? "—" : String(run.stepsWithNewResponse),
    ],
    [
      "Mean wait for X's response",
      run.avgResponseLatencyMs === undefined ? "—" : `${run.avgResponseLatencyMs} ms`,
    ],
    ["Ended", new Date(run.endedAt).toLocaleString()],
  );
  return rows;
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

function bindPacing(select: HTMLSelectElement): void {
  void loadModeBPacing().then((pacing) => {
    select.value = pacing;
  });
  select.addEventListener("change", () => {
    const pacing = ModeBPacingSchema.safeParse(select.value);
    if (pacing.success) {
      void chrome.storage.local
        .set({ [MODE_B_PACING_KEY]: pacing.data })
        .catch(() => undefined);
    }
  });
}

export function bindModeBControls({ button, status, lastRun }: ModeBControls): void {
  let running = false;
  // Options page only: the pacing choice (saved on change, no Save needed).
  const pacing = document.querySelector<HTMLSelectElement>("#mode-b-pacing");
  if (pacing) bindPacing(pacing);

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
      button.textContent = `Collect feed (${settings.collectTarget})`;
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
