import type { ReaderApi } from "../preload/reader-bridge.js";
import { messages, say, type DesktopMessages } from "../shared/i18n.js";
import { isRunActive, type DesktopStatus, type RunStage } from "../shared/status.js";
import { localizePage } from "./localize.js";

/**
 * The reading window's own page: preparing (the pipeline's steps, as in
 * docs/design/timeline-mockup.md), collecting, error, cancelled and
 * empty states, in the windows' language (status.lang). Built with DOM
 * APIs only (no innerHTML): status carries counts and fixed messages,
 * but nothing here ever interprets text as markup.
 */

// Not a global augmentation: the monitor page declares the wider DesktopApi.
const nmc = (window as unknown as { nmc: ReaderApi }).nmc;

const view = document.getElementById("view") as HTMLElement;

type Child = Node | string;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function button(label: string, action: () => Promise<unknown>, primary = false): HTMLElement {
  const node = h("button", { type: "button", ...(primary ? { class: "primary" } : {}) }, label);
  node.addEventListener("click", () => {
    (node as HTMLButtonElement).disabled = true;
    void action().finally(() => ((node as HTMLButtonElement).disabled = false));
  });
  return node;
}

const collectButton = (m: DesktopMessages, primary = true): HTMLElement =>
  button(m.collectNew, () => nmc.startCollection(), primary);

type StepState = "done" | "current" | "wait";

function step(
  m: DesktopMessages,
  state: StepState,
  label: string,
  detail?: string,
): HTMLElement {
  const marker =
    state === "done"
      ? h("span", { class: "st-done", "aria-hidden": "true" }, "✓")
      : state === "current"
        ? h("span", { class: "spinner", "aria-hidden": "true" })
        : h("span", { class: "st-wait", "aria-hidden": "true" }, "–");
  const prefix =
    state === "done" ? m.stepDone : state === "current" ? m.stepCurrent : m.stepWaiting;
  const body = h("span", {}, h("span", { class: "vh" }, prefix), label);
  if (detail) body.append(h("small", {}, detail));
  return h("li", state === "current" ? { "aria-current": "step" } : {}, marker, body);
}

const ORDER: RunStage[] = ["checking", "filtering", "scoring", "verifying", "rendering"];

function stateOf(stage: RunStage, at: RunStage): StepState {
  const now = ORDER.indexOf(stage);
  const mine = ORDER.indexOf(at);
  return now > mine ? "done" : now === mine ? "current" : "wait";
}

function preparing(status: DesktopStatus, m: DesktopMessages): HTMLElement[] {
  const { stage, counts } = status.run;
  const judged =
    counts.afterHardFilter !== null && counts.mediaOnly !== null
      ? counts.afterHardFilter - counts.mediaOnly
      : null;
  const verifyDetail =
    stage === "verifying" || (stage === "rendering" && counts.verifyTotal > 0)
      ? m.claims(counts.verifyDone, counts.verifyTotal)
      : undefined;
  const steps = h(
    "ol",
    { class: "steps" },
    step(
      m,
      "done",
      m.prepCollected,
      counts.postsIn !== null ? m.posts(counts.postsIn) : undefined,
    ),
    step(
      m,
      stage === "checking" || stage === "filtering" ? "current" : "done",
      m.prepSetAside,
      judged !== null ? m.toJudge(judged) : undefined,
    ),
    step(m, stateOf(stage, "scoring"), m.prepScoring, m.prepScoringDetail),
    step(m, stateOf(stage, "verifying"), m.prepVerifying, verifyDetail),
    step(m, stateOf(stage, "rendering"), m.prepRendering),
  );
  const skeleton = h("div", { "aria-hidden": "true" });
  for (let i = 0; i < 3; i += 1) {
    skeleton.append(
      h(
        "div",
        { class: "skeleton" },
        h("i"),
        h("div", {}, h("i", { style: "width:40%" }), h("i"), h("i", { style: "width:85%" })),
      ),
    );
  }
  return [
    h("h1", {}, m.preparingTitle),
    h("p", {}, m.preparingLead),
    steps,
    h(
      "div",
      { class: "btn-row" },
      button(m.cancel, () => nmc.cancelRun()),
    ),
    skeleton,
  ];
}

function render(status: DesktopStatus): void {
  const { run, collection, lang } = status;
  const m = messages(lang);
  localizePage(document, lang, m.readerTitle);
  const note = say(lang, collection.message);
  let content: HTMLElement[];
  if (isRunActive(run.stage)) {
    content = preparing(status, m);
  } else if (collection.state === "requested" || collection.state === "collecting") {
    content = [
      h("h1", {}, m.collectingTitle),
      h("p", {}, collection.target ? m.collectingTarget(collection.target) : m.collectingAny),
    ];
    if (collection.count !== null) {
      content.push(h("p", { role: "status" }, m.soFar(collection.count, collection.target)));
    }
  } else if (status.pending) {
    content = [
      h("h1", {}, m.pendingTitle(status.pending.uniquePostCount)),
      h("p", {}, status.pending.mode === "A" ? m.pendingLeadA : m.pendingLeadB),
      ...(note ? [h("p", { class: "muted" }, note)] : []),
      h(
        "div",
        { class: "btn-row" },
        button(m.buildTimeline, () => nmc.buildTimeline(), true),
        collectButton(m, false),
      ),
    ];
  } else if (run.stage === "error" && run.error) {
    const detail = h(
      "details",
      {},
      h("summary", {}, m.technicalDetail),
      h("pre", {}, run.error.detail ?? run.error.kind),
    );
    content = [
      h("div", { class: "icon", "aria-hidden": "true" }, "⚠"),
      h("h1", {}, m.notPrepared),
      h("p", {}, say(lang, run.error.note)),
      h("p", { class: "muted" }, m.keptPosts),
      detail,
      h(
        "div",
        { class: "btn-row" },
        button(m.tryAgain, () => nmc.retryRun(), true),
        collectButton(m, false),
      ),
    ];
  } else if (run.stage === "cancelled") {
    content = [
      h("h1", {}, m.cancelledTitle),
      h("p", {}, m.cancelledLead),
      h(
        "div",
        { class: "btn-row" },
        button(m.tryAgain, () => nmc.retryRun(), true),
        collectButton(m, false),
      ),
    ];
  } else if (run.stage === "ready" && run.timelineGone) {
    content = [
      h("h1", {}, m.goneTitle),
      h("p", {}, m.goneLead),
      h("div", { class: "btn-row" }, collectButton(m)),
    ];
  } else if (run.stage === "ready" && run.hasTimeline) {
    content = [
      h("h1", {}, m.readyTitle),
      h("p", {}, m.readyCount(run.counts.selected ?? 0)),
      ...(note ? [h("p", { class: "muted" }, note)] : []),
      h(
        "div",
        { class: "btn-row" },
        button(m.openTimeline, () => nmc.openReader(), true),
        collectButton(m, false),
      ),
    ];
  } else {
    content = [h("h1", {}, m.emptyTitle), h("p", {}, m.emptyLead)];
    if (collection.state === "refused" && note) {
      content.push(h("p", { class: "muted", role: "alert" }, note));
    }
    content.push(h("div", { class: "btn-row" }, collectButton(m)));
  }
  const focused = document.activeElement?.textContent ?? null;
  view.replaceChildren(...content);
  // Keep keyboard focus on the same control across re-renders.
  if (focused) {
    for (const candidate of view.querySelectorAll("button")) {
      if (candidate.textContent === focused) {
        candidate.focus();
        break;
      }
    }
  }
}

nmc.onStatus(render);
void nmc.getStatus().then(render);
