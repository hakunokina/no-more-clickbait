import {
  ModeBRunSummarySchema,
  type ModeBPacing,
  type ModeBRunSummary,
  type ModeBStrategy,
} from "@nmc/core";
import { t, type MessageKey } from "./i18n.js";
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

const STRATEGY_LABEL: Record<ModeBStrategy, MessageKey> = {
  "minimized-window": "strategyMinimized",
  "background-tab": "strategyBackgroundTab",
  "offscreen-window": "strategyOffscreen",
};

const PACING_LABEL: Record<ModeBPacing, MessageKey> = {
  normal: "pacingNormal",
  fast: "pacingFast",
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
  return t(
    "modeBLastRun",
    run.uniquePostCount,
    run.target,
    t(STRATEGY_LABEL[run.strategy]),
    describeStopReason(run.stopReason),
    run.error === undefined ? "" : ` (${run.error})`,
  );
}

/** Label/value rows for the options page's last-run summary. */
export function lastRunRows(run: ModeBRunSummary): [string, string][] {
  const lang = t("langCode");
  const rows: [string, string][] = [[t("rowResult"), describeStopReason(run.stopReason)]];
  if (run.error !== undefined) rows.push([t("rowError"), `${run.stopReason}: ${run.error}`]);
  rows.push(
    [t("rowSurface"), t(STRATEGY_LABEL[run.strategy])],
    [t("rowPacing"), run.pacing === undefined ? "—" : t(PACING_LABEL[run.pacing])],
    [
      t("rowDistinct"),
      t(
        "rowDistinctValue",
        run.uniquePostCount,
        run.target,
        t(run.counter === "host" ? "counterHost" : "counterExtension"),
      ),
    ],
    [
      t("rowDuration"),
      t(
        "rowDurationValue",
        (run.durationMs / 1000).toLocaleString(lang, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }),
      ),
    ],
    [t("rowScrolls"), t("rowScrollsValue", run.scrollCount, run.scrollMovedCount)],
    [
      t("rowScrollsPerMinute"),
      run.scrollsPerMinute === undefined ? "—" : String(run.scrollsPerMinute),
    ],
    [t("rowHiddenSteps"), String(run.hiddenStepCount)],
    [
      t("rowResponses"),
      run.responseCount === 0 && run.stopReason !== "failed-to-open"
        ? t("rowResponsesNone")
        : String(run.responseCount),
    ],
    [
      t("rowNewResponseSteps"),
      run.stepsWithNewResponse === undefined ? "—" : String(run.stepsWithNewResponse),
    ],
    [t("rowEnded"), new Date(run.endedAt).toLocaleString(lang)],
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
      button.textContent = t("modeBStop");
      status.textContent = t("modeBCollecting", current.count, current.target);
    } else {
      button.textContent = t("modeBCollect", settings.collectTarget);
      status.textContent = !settings.modeBEnabled
        ? t("modeBOff")
        : last.success
          ? lastRunLine(last.data)
          : t("modeBNoRun");
    }
    if (lastRun) {
      if (last.success) renderRows(lastRun, lastRunRows(last.data));
      else lastRun.replaceChildren();
    }
  };

  const refresh = (): void => {
    void render().catch(() => {
      status.textContent = t("modeBStateFailed");
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
      else status.textContent = t("modeBNeedsAlarms");
    });
  });
  chrome.storage.onChanged.addListener(refresh);
  refresh();
}
