import {
  CollectSourceSchema,
  enabledCollectSources,
  ModeBRunSummarySchema,
  type ModeBPacing,
  type ModeBRunSummary,
  type ModeBStrategy,
  type CollectSource,
  type Settings,
} from "@nmc/core";
import { COLLECTION_PROGRESS_KEY, readProgress } from "./collection-progress.js";
import { t, type MessageKey } from "./i18n.js";
import type { CollectionFinishMessage, ModeBCommandMessage } from "./messages.js";
import {
  describeStopReason,
  legsText,
  MODE_B_LAST_RUN_KEY,
  MODE_B_PERMISSIONS,
  MODE_B_RUN_KEY,
  sourceName,
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

/** Sends a command; resolves to the worker's answer (a start says when nothing could run). */
function send(command: ModeBCommandMessage["command"]): Promise<unknown> {
  const message: ModeBCommandMessage = { kind: "mode-b-command", command };
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

function runningCount(
  value: unknown,
): { count: number; target: number; source: CollectSource | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const count = v["uniquePostCount"];
  const target = v["target"];
  const source = CollectSourceSchema.safeParse(v["source"] ?? "x");
  return typeof count === "number" && typeof target === "number"
    ? { count, target, source: source.success ? source.data : null }
    : null;
}

/** True when a collection scrolls a feed other than X (each feed then has its own line). */
function severalFeeds(settings: Settings): boolean {
  return enabledCollectSources(settings).some((source) => source !== "x");
}

export function lastRunLine(run: ModeBRunSummary): string {
  if (run.legs !== undefined) return t("modeBLastRunLegs", legsText(run.legs));
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
  const rows: [string, string][] = [
    [t("rowResult"), describeStopReason(run.stopReason, run.source)],
  ];
  if (run.legs !== undefined) rows.push([t("rowFeeds"), legsText(run.legs)]);
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
      status.textContent =
        current.source !== null && (current.source !== "x" || severalFeeds(settings))
          ? t(
              "modeBCollectingSource",
              sourceName(current.source),
              current.count,
              current.target,
            )
          : t("modeBCollecting", current.count, current.target);
    } else {
      button.textContent = t("modeBCollect", settings.collectTarget);
      status.textContent = !settings.modeBEnabled
        ? t("modeBOff")
        : enabledCollectSources(settings).length === 0
          ? t("collectSitesOnly")
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
    void permission.then(async (granted) => {
      if (!granted) {
        status.textContent = t("modeBNeedsAlarms");
        return;
      }
      if ((await send("start")) === "no-sources") status.textContent = t("collectNoSources");
    });
  });
  chrome.storage.onChanged.addListener(refresh);
  refresh();
}

export interface CollectionProgressControls {
  /** "Collected so far: X 120 / 250 · Instagram 40 / 250 ✓" (empty before any post). */
  line: HTMLElement;
  /** "Finish now": ends the user's own collection short of its target. */
  finish: HTMLButtonElement;
  finishHint: HTMLElement;
}

/** The current collection's count per feed, from the worker's record. */
export function progressLine(settings: Settings, stored: unknown): string {
  const progress = readProgress(stored);
  const sources = enabledCollectSources(settings);
  if (!sources.some((source) => (progress[source]?.count ?? 0) > 0)) return "";
  const parts = sources.map((source) =>
    t(
      progress[source]?.closed ? "progressSourceDone" : "progressSource",
      sourceName(source),
      progress[source]?.count ?? 0,
      settings.collectTarget,
    ),
  );
  return t("collectProgressLabel", parts.join(" · "));
}

/**
 * The popup's per-feed count of the collection in progress and its
 * "Finish now" (shown once a post was counted and no Mode B run is
 * going — a run has its own Stop).
 */
export function bindCollectionProgress({
  line,
  finish,
  finishHint,
}: CollectionProgressControls): void {
  const render = async (): Promise<void> => {
    const settings = await loadSettings();
    const stored = (await chrome.storage.session.get(COLLECTION_PROGRESS_KEY))[
      COLLECTION_PROGRESS_KEY
    ];
    const running = (await chrome.storage.session.get(MODE_B_RUN_KEY))[MODE_B_RUN_KEY];
    const text = progressLine(settings, stored);
    line.textContent = text;
    const offered = text !== "" && running === undefined;
    finish.hidden = !offered;
    finishHint.hidden = !offered;
  };
  const refresh = (): void => {
    void render().catch(() => {
      line.textContent = "";
    });
  };
  finish.addEventListener("click", () => {
    finish.disabled = true;
    const message: CollectionFinishMessage = { kind: "collection-finish" };
    void chrome.runtime
      .sendMessage(message)
      .catch(() => undefined)
      .finally(() => {
        finish.disabled = false;
      });
  });
  chrome.storage.onChanged.addListener(refresh);
  refresh();
}
