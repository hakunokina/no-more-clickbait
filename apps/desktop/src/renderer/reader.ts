import type { DesktopApi } from "../preload/preload.js";
import { isRunActive, type DesktopStatus, type RunStage } from "../shared/status.js";

/**
 * The reading window's own page: preparing (the pipeline's steps, as in
 * docs/design/timeline-mockup.md), collecting, error, cancelled and
 * empty states. Turkish, like the reading window. Built with DOM APIs
 * only (no innerHTML): status carries counts and fixed messages, but
 * nothing here ever interprets text as markup.
 */

declare global {
  interface Window {
    nmc: DesktopApi;
  }
}

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

const collectButton = (primary = true): HTMLElement =>
  button("Yeni akış topla", () => window.nmc.startCollection(), primary);

type StepState = "done" | "current" | "wait";

function step(state: StepState, label: string, detail?: string): HTMLElement {
  const marker =
    state === "done"
      ? h("span", { class: "st-done", "aria-hidden": "true" }, "✓")
      : state === "current"
        ? h("span", { class: "spinner", "aria-hidden": "true" })
        : h("span", { class: "st-wait", "aria-hidden": "true" }, "–");
  const prefix = state === "done" ? "Tamam: " : state === "current" ? "Sürüyor: " : "Sırada: ";
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

function preparing(status: DesktopStatus): HTMLElement[] {
  const { stage, counts } = status.run;
  const judged =
    counts.afterHardFilter !== null && counts.mediaOnly !== null
      ? counts.afterHardFilter - counts.mediaOnly
      : null;
  const verifyDetail =
    stage === "verifying" || (stage === "rendering" && counts.verifyTotal > 0)
      ? `${counts.verifyDone} / ${counts.verifyTotal} iddia`
      : undefined;
  const steps = h(
    "ol",
    { class: "steps" },
    step("done", "Toplandı", counts.postsIn !== null ? `${counts.postsIn} gönderi` : undefined),
    step(
      stage === "checking" || stage === "filtering" ? "current" : "done",
      "Reklam, tekrar ve yalnız-medya ayrıldı",
      judged !== null ? `${judged} gönderi değerlendirilecek` : undefined,
    ),
    step(stateOf(stage, "scoring"), "Claude okuyor ve puanlıyor", "Tek çağrı · birkaç dakika"),
    step(
      stateOf(stage, "verifying"),
      "Doğrulamaya değer iddialar kontrol ediliyor",
      verifyDetail,
    ),
    step(stateOf(stage, "rendering"), "Akış yazılıyor"),
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
    h("h1", {}, "Akış hazırlanıyor"),
    h("p", {}, "Bu pencereyi kapatabilirsin; hazır olunca tepsiden haber verilir."),
    steps,
    h(
      "div",
      { class: "btn-row" },
      button("İptal", () => window.nmc.cancelRun()),
    ),
    skeleton,
  ];
}

function render(status: DesktopStatus): void {
  const { run, collection } = status;
  let content: HTMLElement[];
  if (isRunActive(run.stage)) {
    content = preparing(status);
  } else if (collection.state === "requested" || collection.state === "collecting") {
    content = [
      h("h1", {}, "Gönderiler toplanıyor"),
      h(
        "p",
        {},
        collection.target
          ? `Eklenti X akışından ${collection.target} gönderi topluyor. Bitince akış kendiliğinden hazırlanır.`
          : "Eklenti X akışından gönderi topluyor. Bitince akış kendiliğinden hazırlanır.",
      ),
    ];
  } else if (status.pending) {
    content = [
      h("h1", {}, `${status.pending.uniquePostCount} gönderi toplandı`),
      h(
        "p",
        {},
        "X'te gezinirken toplanan gönderilerden akışı oluşturalım mı? Claude puanlar ve doğrular; birkaç dakika sürer.",
      ),
      h(
        "div",
        { class: "btn-row" },
        button("Akışı oluştur", () => window.nmc.buildTimeline(), true),
        collectButton(false),
      ),
    ];
  } else if (run.stage === "error" && run.error) {
    const detail = h(
      "details",
      {},
      h("summary", {}, "Teknik ayrıntı"),
      h("pre", {}, run.error.detail ?? run.error.kind),
    );
    content = [
      h("div", { class: "icon", "aria-hidden": "true" }, "⚠"),
      h("h1", {}, "Akış hazırlanamadı"),
      h("p", {}, run.error.message),
      h(
        "p",
        { class: "muted" },
        "Toplanan gönderiler duruyor; yeniden denemek için yeniden toplamak gerekmez.",
      ),
      detail,
      h(
        "div",
        { class: "btn-row" },
        button("Tekrar dene", () => window.nmc.retryRun(), true),
        collectButton(false),
      ),
    ];
  } else if (run.stage === "cancelled") {
    content = [
      h("h1", {}, "İptal edildi"),
      h("p", {}, "Toplanan gönderiler duruyor."),
      h(
        "div",
        { class: "btn-row" },
        button("Tekrar dene", () => window.nmc.retryRun(), true),
        collectButton(false),
      ),
    ];
  } else if (run.stage === "ready" && run.hasTimeline) {
    content = [
      h("h1", {}, "Akış hazır"),
      h("p", {}, `${run.counts.selected ?? 0} gönderi.`),
      h(
        "div",
        { class: "btn-row" },
        button("Akışı aç", () => window.nmc.openReader(), true),
        collectButton(false),
      ),
    ];
  } else {
    content = [
      h("h1", {}, "Henüz akış yok"),
      h(
        "p",
        {},
        "Yeni bir akış için eklenti X akışından gönderi toplar; sonra Claude puanlar ve doğrular.",
      ),
    ];
    if (collection.state === "refused" && collection.message) {
      content.push(h("p", { class: "muted", role: "alert" }, collection.message));
    }
    content.push(h("div", { class: "btn-row" }, collectButton()));
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

window.nmc.onStatus(render);
void window.nmc.getStatus().then(render);
