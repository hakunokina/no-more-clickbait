import { INTL_LOCALES, type UiLang } from "@nmc/core";
import type { DesktopApi } from "../preload/preload.js";
import {
  describeUnfinished,
  formatCost,
  formatCount,
  formatDuration,
} from "../shared/format.js";
import { messages, say } from "../shared/i18n.js";
import type { DesktopStatus } from "../shared/status.js";
import { monitorActions, type MonitorAction } from "../shared/actions.js";
import { localizePage } from "./localize.js";
import {
  monitorView,
  type MonitorView,
  type PillView,
  type SiteRowView,
  type Tone,
} from "./monitor-view.js";

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

const SVG = "http://www.w3.org/2000/svg";

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

const TONE_ICONS: Readonly<Record<Tone, string | null>> = {
  plain: null,
  ok: "check",
  warn: "warn",
  bad: "x",
};

/** Colours a line by tone and shows the tone's icon (its first svg). */
function toneLine(line: HTMLElement, tone: Tone): void {
  line.classList.remove("ok", "warn", "bad");
  if (tone !== "plain") line.classList.add(tone);
  const mark = line.querySelector("svg");
  const name = TONE_ICONS[tone];
  if (!mark) return;
  mark.toggleAttribute("hidden", name === null);
  if (name) mark.querySelector("use")?.setAttribute("href", `#i-${name}`);
}

const PILL_ICONS: Readonly<Record<PillView["state"], string>> = {
  done: "check",
  now: "dot",
  next: "ring",
  warn: "warn",
};

const SITE_ICONS: Readonly<Record<SiteRowView["state"], string>> = {
  ...PILL_ICONS,
  bad: "x",
};

/** The site list's open state last set from the view; the user's toggle stands until it changes. */
let sitesOpen: boolean | null = null;

function renderSites(view: MonitorView["sites"]): void {
  const box = el<HTMLDetailsElement>("sites");
  box.hidden = view === null;
  if (!view) {
    sitesOpen = null;
    return;
  }
  if (sitesOpen !== view.open) box.open = sitesOpen = view.open;
  text("sites-title", view.title);
  el("sites-mark").toggleAttribute("hidden", !view.problem);
  el("sites-list").replaceChildren(
    ...view.rows.map((row) => {
      const item = document.createElement("li");
      item.className = row.state;
      const spoken = document.createElement("span");
      spoken.className = "sr-only";
      spoken.textContent = row.spoken;
      const name = document.createElement("span");
      name.className = "sites__name";
      name.textContent = row.name;
      const state = document.createElement("span");
      state.className = "sites__state";
      state.textContent = row.status;
      item.append(
        icon(SITE_ICONS[row.state]),
        ...(row.spoken ? [spoken] : []),
        name,
        " ",
        state,
      );
      return item;
    }),
  );
}

function renderView(view: MonitorView): void {
  const ring = el("ring");
  ring.hidden = view.ring === null;
  if (view.ring) {
    ring.classList.toggle("ring--quiet", view.ring.kind === "icon");
    if (view.ring.kind === "icon") {
      el("ring-icon").setAttribute("href", `#i-${view.ring.icon}`);
    } else {
      const filled = view.ring.percent;
      el("ring-bar").setAttribute("stroke-dasharray", `${filled} 100`);
      // A round cap on an empty arc would still draw a dot.
      el("ring-bar").toggleAttribute("hidden", filled <= 0);
      text("ring-value", view.ring.value);
      text("ring-caption", view.ring.caption);
    }
    const label = view.ring.kind === "progress" ? view.ring.label : null;
    if (label) {
      ring.setAttribute("role", "img");
      ring.setAttribute("aria-label", label);
      ring.removeAttribute("aria-hidden");
    } else {
      ring.removeAttribute("role");
      ring.removeAttribute("aria-label");
      ring.setAttribute("aria-hidden", "true");
    }
  }

  text("stage-text", view.title);
  toneLine(el("stage"), view.tone);

  const pills = el("pills");
  pills.hidden = view.pills.length === 0;
  pills.replaceChildren(
    ...view.pills.map((pill) => {
      const item = document.createElement("li");
      item.className = pill.state;
      const spoken = document.createElement("span");
      spoken.className = "sr-only";
      spoken.textContent = pill.spoken;
      item.append(icon(PILL_ICONS[pill.state]), spoken, pill.text);
      return item;
    }),
  );
  renderSites(view.sites);
  text("lead", view.lead);

  el("tagline").hidden = !view.tagline;
  const summary = el("summary");
  summary.hidden = view.summary.length === 0;
  summary.replaceChildren(
    ...view.summary.map(({ label, value }) => {
      const pair = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      pair.append(term, " ", detail);
      return pair;
    }),
  );

  text("link-status", view.link.text);
  toneLine(el("link-line"), view.link.tone);
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
  open: () => window.nmc.openReader(),
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
  renderView(monitorView(status));
  text("collection-note", say(lang, status.collection.message));
  text("unfinished-note", describeUnfinished(status));

  const error = el("run-error");
  error.hidden = run.error === null;
  text("run-error-message", run.error ? say(lang, run.error.note) : "");
  text("run-error-detail", run.error?.detail ?? "");

  const actions = monitorActions(status);
  primaryAction = actions.primary;
  const primary = el<HTMLButtonElement>("primary");
  text("primary-label", actions.label);
  primary.disabled = actions.disabled;
  // Cancelling is offered, not urged: only the other actions are filled.
  primary.classList.toggle("btn--primary", actions.primary !== "cancel");
  el("primary-mark").toggleAttribute("hidden", actions.primary !== "open");
  // One button per action: the corner one steps aside while reading is the primary.
  el("open-reader").hidden = actions.primary === "open";
  const collectLink = el<HTMLButtonElement>("collect-link");
  collectLink.hidden = !actions.collectLink;
  collectLink.disabled = !status.link.listening;

  const count = (value: number | null) => formatCount(value, lang);
  el("usage").hidden = run.startedAt === null;
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

function showLlm(line: (lang: UiLang) => string, tone: Tone): void {
  llmLine = line;
  status.textContent = line(lang());
  toneLine(el("llm-line"), tone);
}

button.addEventListener("click", () => {
  button.disabled = true;
  showLlm((l) => messages(l).llmChecking, "plain");
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
