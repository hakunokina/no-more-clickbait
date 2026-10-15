import type { DesktopApi } from "../preload/preload.js";
import {
  describeLink,
  describeRun,
  describeStopReason,
  describeUnfinished,
  formatCost,
  formatCount,
  formatDuration,
} from "../shared/format.js";
import { isRunActive, type DesktopStatus } from "../shared/status.js";

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

function render(status: DesktopStatus): void {
  current = status;
  const { run } = status;
  const active = isRunActive(run.stage);
  text("stage", describeRun(status));
  text("link-status", describeLink(status));
  text("collection-note", status.collection.message ?? "");
  text("unfinished-note", describeUnfinished(status));

  const pending = status.pending;
  el("pending").hidden = pending === null || active;
  text(
    "pending-note",
    pending === null
      ? ""
      : pending.mode === "A"
        ? `${pending.uniquePostCount} posts collected while you browsed. Build the timeline? (Uses your claude CLI.)`
        : `The collection stopped early (${describeStopReason(pending.reason)}) with ${pending.uniquePostCount} posts. Build the timeline anyway? (Uses your claude CLI.)`,
  );
  text("build", pending?.mode === "B" ? "Build timeline anyway" : "Build timeline");

  const error = el("run-error");
  error.hidden = run.error === null;
  text("run-error-message", run.error?.message ?? "");
  text("run-error-detail", run.error?.detail ?? "");

  el<HTMLButtonElement>("collect").disabled = active || !status.link.listening;
  el<HTMLButtonElement>("cancel").disabled = !active;
  el<HTMLButtonElement>("retry").disabled =
    active || run.sessionId === null || !(run.stage === "error" || run.stage === "cancelled");

  const counts = run.counts;
  const { collection } = status;
  const collecting = !active && collection.state === "collecting" && collection.count !== null;
  text(
    "posts-collected",
    collecting
      ? `${formatCount(collection.count)} / ${formatCount(collection.target)}`
      : formatCount(counts.afterHardFilter ?? counts.postsIn),
  );
  text("posts-filtered", formatCount(counts.filteredOut));
  text(
    "posts-verified",
    counts.verifyTotal > 0 ? `${counts.verifyDone} / ${counts.verifyTotal}` : formatCount(null),
  );
  text(
    "posts-kept",
    counts.selected === null
      ? "—"
      : `${formatCount(counts.selected)} / ${formatCount(counts.postsIn)}`,
  );
  const usage = run.usage;
  const used = usage.llmCalls > 0;
  text("tokens-in", used ? formatCount(usage.inputTokens) : "—");
  text("tokens-cache", used ? formatCount(usage.cacheTokens) : "—");
  text("tokens-out", used ? formatCount(usage.outputTokens) : "—");
  text("tokens-thinking", used ? formatCount(usage.thinkingTokens) : "—");
  text("cost", formatCost(usage.costUsd));
  const stages = Object.entries(run.stageDurationsMs)
    .filter(([stage]) => stage === "scorer" || stage === "verifier")
    .map(([stage, ms]) => `${stage === "scorer" ? "score" : "verify"} ${formatDuration(ms)}`);
  text("stage-times", stages.length > 0 ? stages.join(" · ") : "—");
  text("collection-span", formatDuration(run.collectionSpanMs));
  text(
    "last-run",
    run.endedAt ? new Date(run.endedAt).toLocaleString() : run.startedAt ? "Running…" : "Never",
  );
  tick();
}

/** Live run time while a run is in flight. */
function tick(): void {
  const run = current?.run;
  if (!run?.startedAt) return text("run-time", "—");
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  text("run-time", formatDuration(end - Date.parse(run.startedAt)));
}
setInterval(tick, 1000);

function guarded(button: HTMLButtonElement, action: () => Promise<unknown>): void {
  button.addEventListener("click", () => {
    button.disabled = true;
    void action()
      .catch((error: unknown) => {
        text("collection-note", `Failed: ${String(error)}`);
      })
      .finally(() => {
        if (current) render(current);
        else button.disabled = false;
      });
  });
}

guarded(el<HTMLButtonElement>("build"), () => window.nmc.buildTimeline());
guarded(el<HTMLButtonElement>("collect"), () => window.nmc.startCollection());
guarded(el<HTMLButtonElement>("cancel"), () => window.nmc.cancelRun());
guarded(el<HTMLButtonElement>("retry"), () => window.nmc.retryRun());
el("open-reader").addEventListener("click", () => void window.nmc.openReader());
el("open-settings").addEventListener("click", () => void window.nmc.openSettings());

window.nmc.onStatus(render);
void window.nmc.getStatus().then(render);

const button = document.querySelector<HTMLButtonElement>("#check-llm");
const status = document.querySelector<HTMLElement>("#llm-status");

button?.addEventListener("click", () => {
  if (!status || !button) return;
  button.disabled = true;
  status.textContent = "Checking…";
  status.className = "";
  window.nmc
    .checkLlmStatus()
    .then((availability) => {
      if (availability.ok) {
        status.textContent = `Ready — claude CLI ${availability.version}`;
        status.className = "ok";
      } else {
        status.textContent =
          availability.reason === "not-found"
            ? "claude CLI not found on PATH. Install it and log in, then check again."
            : availability.reason === "not-authenticated"
              ? "claude CLI is installed but not logged in. Log in with the CLI first."
              : `CLI check failed: ${availability.detail}`;
        status.className = "bad";
      }
    })
    .catch((error: unknown) => {
      status.textContent = `CLI check failed: ${String(error)}`;
      status.className = "bad";
    })
    .finally(() => {
      button.disabled = false;
    });
});
