import { INTL_LOCALES, type UiLang } from "@nmc/core";
import type { DesktopApi } from "../preload/preload.js";
import {
  describeLink,
  describeRun,
  describeUnfinished,
  formatCost,
  formatCount,
  formatDuration,
} from "../shared/format.js";
import { messages, say } from "../shared/i18n.js";
import { isRunActive, type DesktopStatus } from "../shared/status.js";
import { monitorActions, type MonitorAction } from "../shared/actions.js";
import { localizePage } from "./localize.js";

declare global {
  interface Window {
    nmc: DesktopApi;
  }
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function text(id: string, value: string): void {
  el(id).textContent = value;
}

let current: DesktopStatus | null = null;
let primaryAction: MonitorAction = "collect";
/** The page's static words are in this language. */
let shownLang: UiLang | null = null;
/** The last CLI check, re-worded when the language changes. */
let llmLine: ((lang: UiLang) => string) | null = null;

const ACTIONS: Record<MonitorAction, () => Promise<unknown>> = {
  collect: () => window.nmc.startCollection(),
  cancel: () => window.nmc.cancelRun(),
  build: () => window.nmc.buildTimeline(),
  rebuild: () => window.nmc.retryRun(),
  retry: () => window.nmc.retryRun(),
};

function render(status: DesktopStatus): void {
  current = status;
  const { run, lang } = status;
  const m = messages(lang);
  if (shownLang !== lang) {
    shownLang = lang;
    localizePage(document, lang);
    if (llmLine) text("llm-status", llmLine(lang));
  }
  const active = isRunActive(run.stage);
  text("stage", describeRun(status));
  text("link-status", describeLink(status));
  text("collection-note", say(lang, status.collection.message));
  text("unfinished-note", describeUnfinished(status));

  const pending = active ? null : status.pending;
  text(
    "pending-note",
    pending === null
      ? ""
      : pending.mode === "A"
        ? m.pendingModeA(pending.uniquePostCount)
        : m.pendingModeB(pending.reason, pending.uniquePostCount),
  );

  const error = el("run-error");
  error.hidden = run.error === null;
  text("run-error-message", run.error ? say(lang, run.error.note) : "");
  text("run-error-detail", run.error?.detail ?? "");

  const actions = monitorActions(status);
  primaryAction = actions.primary;
  const primary = el<HTMLButtonElement>("primary");
  primary.textContent = actions.label;
  primary.disabled = actions.disabled;
  const collectLink = el<HTMLButtonElement>("collect-link");
  collectLink.hidden = !actions.collectLink;
  collectLink.disabled = !status.link.listening;

  const counts = run.counts;
  const { collection } = status;
  const count = (value: number | null) => formatCount(value, lang);
  const collecting =
    !active &&
    (collection.state === "collecting" || collection.state === "cancelling") &&
    collection.count !== null;
  text(
    "posts-collected",
    collecting
      ? `${count(collection.count)} / ${count(collection.target)}`
      : count(counts.afterHardFilter ?? counts.postsIn),
  );
  text("posts-filtered", count(counts.filteredOut));
  text(
    "posts-verified",
    counts.verifyTotal > 0 ? `${counts.verifyDone} / ${counts.verifyTotal}` : count(null),
  );
  text(
    "posts-kept",
    counts.selected === null ? "—" : `${count(counts.selected)} / ${count(counts.postsIn)}`,
  );
  const usage = run.usage;
  const used = usage.llmCalls > 0;
  text("tokens-in", used ? count(usage.inputTokens) : "—");
  text("tokens-cache", used ? count(usage.cacheTokens) : "—");
  text("tokens-out", used ? count(usage.outputTokens) : "—");
  text("tokens-thinking", used ? count(usage.thinkingTokens) : "—");
  text("cost", formatCost(usage.costUsd, lang));
  const stages = Object.entries(run.stageDurationsMs)
    .filter(([stage]) => stage === "scorer" || stage === "verifier")
    .map(([stage, ms]) =>
      stage === "scorer"
        ? m.stageScore(formatDuration(ms, lang))
        : m.stageVerify(formatDuration(ms, lang)),
    );
  text("stage-times", stages.length > 0 ? stages.join(" · ") : "—");
  text("collection-span", formatDuration(run.collectionSpanMs, lang));
  text(
    "last-run",
    run.endedAt
      ? new Date(run.endedAt).toLocaleString(INTL_LOCALES[lang])
      : run.startedAt
        ? m.running
        : m.never,
  );
  tick();
}

/** Live run time while a run is in flight. */
function tick(): void {
  const run = current?.run;
  if (!current || !run?.startedAt) return text("run-time", "—");
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  text("run-time", formatDuration(end - Date.parse(run.startedAt), current.lang));
}
setInterval(tick, 1000);

function lang(): UiLang {
  return current?.lang ?? "en";
}

function guarded(button: HTMLButtonElement, action: () => Promise<unknown>): void {
  button.addEventListener("click", () => {
    button.disabled = true;
    void action()
      .catch((error: unknown) => {
        text("collection-note", messages(lang()).failed(String(error)));
      })
      .finally(() => {
        if (current) render(current);
        else button.disabled = false;
      });
  });
}

guarded(el<HTMLButtonElement>("primary"), () => ACTIONS[primaryAction]());
guarded(el<HTMLButtonElement>("collect-link"), () => window.nmc.startCollection());
el("open-reader").addEventListener("click", () => void window.nmc.openReader());
el("open-settings").addEventListener("click", () => void window.nmc.openSettings());

window.nmc.onStatus(render);
// Without a status the page still shows, in English.
void window.nmc.getStatus().then(render, () => localizePage(document, lang()));

const button = el<HTMLButtonElement>("check-llm");
const status = el("llm-status");

function showLlm(line: (lang: UiLang) => string, className: string): void {
  llmLine = line;
  status.textContent = line(lang());
  status.className = className;
}

button.addEventListener("click", () => {
  button.disabled = true;
  showLlm((l) => messages(l).llmChecking, "");
  window.nmc
    .checkLlmStatus()
    .then((availability) => {
      if (availability.ok) {
        showLlm((l) => messages(l).llmReady(availability.version), "ok");
      } else {
        const { reason, detail } = availability;
        showLlm(
          (l) =>
            reason === "not-found"
              ? messages(l).llmNotFound
              : reason === "not-authenticated"
                ? messages(l).llmNotAuthenticated
                : messages(l).llmFailed(detail),
          "bad",
        );
      }
    })
    .catch((error: unknown) => {
      showLlm((l) => messages(l).llmFailed(String(error)), "bad");
    })
    .finally(() => {
      button.disabled = false;
    });
});
