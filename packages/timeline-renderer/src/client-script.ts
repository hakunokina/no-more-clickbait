import type { UiLang } from "@nmc/core";
import { RENDER_MESSAGES, type ScriptMessages } from "./messages.js";

/** A fixed UI string as a JS string literal. */
const q = (text: string): string => JSON.stringify(text);

/**
 * The page's only script: lightbox, theme, J/K, "read more", the
 * verification/why/alt panels, video and GIF controls, the progress
 * counter. Static per language: it reads everything from the DOM, only
 * the page's own fixed words are written in and no feed data ever is,
 * so its CSP hash is fixed. No inline handlers.
 */
function timelineScript(s: ScriptMessages): string {
  return `"use strict";
(() => {
  const doc = document;
  const root = doc.documentElement;
  const posts = Array.from(doc.querySelectorAll(".post"));
  const done = doc.getElementById("done");
  const topbar = doc.querySelector(".topbar");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  /* Progress: "3 / 10", then ${q(s.done)} once the Done screen is in view. */
  const progressNow = doc.getElementById("progress-now");
  const progressOf = doc.getElementById("progress-of");
  const progressBar = doc.getElementById("progress-bar");
  function updateProgress() {
    const total = posts.length;
    if (!total || !progressNow) return;
    const line = topbar.getBoundingClientRect().bottom + 40;
    let idx = 0;
    posts.forEach((p, k) => { if (p.getBoundingClientRect().top < line) idx = k + 1; });
    const finished = !!done && done.getBoundingClientRect().top < innerHeight * 0.8;
    const now = finished ? total : Math.max(1, idx);
    progressNow.textContent = finished ? ${q(s.done)} : String(now);
    progressOf.hidden = finished;
    progressBar.style.width = (now / total) * 100 + "%";
  }
  let raf = 0;
  addEventListener("scroll", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updateProgress); }, { passive: true });
  addEventListener("resize", updateProgress);
  updateProgress();

  /* Theme: system → light → dark (remembered per viewer when storage works). */
  const THEME_KEY = "nmc-theme";
  const MODES = ["system", "light", "dark"];
  const LABELS = { system: ${q(s.system)}, light: ${q(s.light)}, dark: ${q(s.dark)} };
  const themeBtn = doc.getElementById("theme-btn");
  let mode = "system";
  try { const saved = localStorage.getItem(THEME_KEY); if (MODES.includes(saved)) mode = saved; } catch (_) { /* no storage */ }
  function applyTheme() {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    themeBtn.dataset.mode = mode;
    themeBtn.setAttribute("aria-label", ${q(s.theme)} + LABELS[mode] + ${q(s.switchTo)} + LABELS[next]);
    themeBtn.title = ${q(s.theme)} + LABELS[mode];
  }
  themeBtn.addEventListener("click", () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    try { localStorage.setItem(THEME_KEY, mode); } catch (_) { /* no storage */ }
    applyTheme();
  });
  applyTheme();

  /* Lightbox: the post's photos, uncropped, ←/→ and Esc. */
  const lb = doc.getElementById("lightbox");
  const lbImg = doc.getElementById("lb-img");
  const lbCap = doc.getElementById("lb-cap");
  const lbCount = doc.getElementById("lb-count");
  const lbPrev = doc.getElementById("lb-prev");
  const lbNext = doc.getElementById("lb-next");
  let lbSet = [];
  let lbIdx = 0;
  let lbOpener = null;
  function lbShow() {
    const it = lbSet[lbIdx];
    lbImg.src = it.src;
    lbImg.alt = it.alt;
    lbCap.textContent = it.alt;
    lbCap.hidden = !it.alt;
    lbCount.textContent = lbSet.length > 1 ? (lbIdx + 1) + " / " + lbSet.length : "";
    lbPrev.hidden = lbNext.hidden = lbSet.length < 2;
  }
  function lbOpen(btn) {
    const imgs = Array.from(btn.closest(".media").querySelectorAll(".media__zoom img"));
    lbSet = imgs.map((img) => ({ src: img.src, alt: img.alt }));
    lbIdx = Math.max(0, imgs.indexOf(btn.querySelector("img")));
    lbOpener = btn;
    lbShow();
    lb.showModal();
  }
  function lbStep(d) { lbIdx = (lbIdx + d + lbSet.length) % lbSet.length; lbShow(); }
  lbPrev.addEventListener("click", () => lbStep(-1));
  lbNext.addEventListener("click", () => lbStep(1));
  doc.getElementById("lb-close").addEventListener("click", () => lb.close());
  lb.addEventListener("keydown", (e) => {
    if (lbSet.length < 2) return;
    if (e.key === "ArrowLeft") lbStep(-1);
    if (e.key === "ArrowRight") lbStep(1);
  });
  lb.addEventListener("click", (e) => { if (e.target === lb || e.target.classList.contains("lightbox__img")) lb.close(); });
  lb.addEventListener("close", () => { lbImg.removeAttribute("src"); if (lbOpener) lbOpener.focus(); });

  /* GIFs loop while on screen, unless motion is reduced or the reader paused them. */
  function gifSet(box, playing) {
    const video = box.querySelector("video");
    box.dataset.playing = String(playing);
    box.querySelector(".gif__toggle").setAttribute("aria-pressed", String(playing));
    if (!playing) { video.pause(); return; }
    const started = video.play();
    if (started) started.catch(() => gifSet(box, false));
  }
  if ("IntersectionObserver" in window) {
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const box = entry.target;
        if (entry.isIntersecting) {
          if (!reduceMotion.matches && box.dataset.user !== "paused") gifSet(box, true);
        } else if (box.dataset.playing === "true") {
          gifSet(box, false);
        }
      }
    }, { threshold: 0.5 });
    doc.querySelectorAll(".gif").forEach((box) => seen.observe(box));
  }

  function toggle(btn) {
    const panel = doc.getElementById(btn.getAttribute("aria-controls"));
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    return { panel, open };
  }

  doc.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const more = t.closest("[data-more]");
    if (more) {
      const { panel, open } = toggle(more);
      panel.classList.toggle("is-clamped", !open);
      more.textContent = open ? ${q(s.showLess)} : ${q(s.readMore)};
      return;
    }
    const disclosure = t.closest(".verify__toggle, .why-btn, [data-alt]");
    if (disclosure) { const { panel, open } = toggle(disclosure); panel.hidden = !open; return; }
    const zoom = t.closest(".media__zoom");
    if (zoom) { lbOpen(zoom); return; }
    const play = t.closest("button.video__play");
    if (play) {
      const box = play.closest(".video");
      const video = box.querySelector("video");
      box.dataset.state = "playing";
      video.controls = true;
      const started = video.play();
      if (started) started.catch(() => {});
      video.focus();
      return;
    }
    const gifBtn = t.closest(".gif__toggle");
    if (gifBtn) {
      const box = gifBtn.closest(".gif");
      const playing = box.dataset.playing !== "true";
      box.dataset.user = playing ? "" : "paused";
      gifSet(box, playing);
    }
  });

  /* J/K: post to post; after the last post, the Done screen. */
  doc.addEventListener("keydown", (e) => {
    if (lb.open || e.ctrlKey || e.metaKey || e.altKey) return;
    const active = doc.activeElement;
    if (active && (/^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(active.tagName) || active.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k !== "j" && k !== "k") return;
    const items = posts.concat(done ? [done] : []);
    if (!items.length) return;
    const cur = items.findIndex((el) => el.contains(active));
    const next = cur === -1 ? 0 : Math.min(items.length - 1, Math.max(0, cur + (k === "j" ? 1 : -1)));
    items[next].focus({ preventScroll: true });
    items[next].scrollIntoView({ block: "start" });
    e.preventDefault();
  });
})();
`;
}

/**
 * Appended to the timeline script only on a page with Instagram or
 * generic cards (an X-only page keeps its exact script and hash): the
 * Instagram carousel and the fallback for Instagram media that does not
 * load (signed CDN links expire). Static per language, like it.
 */
function cardsScript(s: ScriptMessages): string {
  return `"use strict";
(() => {
  const doc = document;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  /* Carousel: arrow buttons, swipe/trackpad scrolling, hidden slides inert. */
  function carSync(car, idx, announce) {
    const slides = car.querySelectorAll(".car__slide");
    const n = slides.length;
    idx = Math.max(0, Math.min(n - 1, idx));
    const changed = Number(car.dataset.idx) !== idx;
    car.dataset.idx = String(idx);
    slides.forEach((s, k) => { s.inert = k !== idx; });
    car.querySelector(".car__count").textContent = (idx + 1) + "/" + n;
    const dots = car.nextElementSibling;
    if (dots && dots.classList.contains("car__dots")) {
      dots.querySelectorAll("i").forEach((d, k) => d.toggleAttribute("data-on", k === idx));
    }
    const prev = car.querySelector(".car__prev");
    const next = car.querySelector(".car__next");
    const focused = doc.activeElement;
    prev.hidden = idx === 0;
    next.hidden = idx === n - 1;
    // An arrow hidden at the end hands its focus to the other one.
    if (focused === prev && prev.hidden) next.focus();
    if (focused === next && next.hidden) prev.focus();
    if (announce && changed) car.querySelector("[data-car-live]").textContent = ${q(s.image)} + (idx + 1) + " / " + n;
  }
  function carGo(car, delta) {
    const track = car.querySelector(".car__track");
    const idx = Number(car.dataset.idx) + delta;
    track.scrollTo({ left: idx * track.clientWidth, behavior: reduceMotion.matches ? "auto" : "smooth" });
    carSync(car, idx, true);
  }
  doc.addEventListener("click", (e) => {
    const step = e.target instanceof Element ? e.target.closest("[data-car-step]") : null;
    if (step) carGo(step.closest("[data-car]"), Number(step.dataset.carStep));
  });
  const settle = new WeakMap();
  doc.addEventListener("scroll", (e) => {
    const track = e.target;
    if (!(track instanceof Element) || !track.classList.contains("car__track")) return;
    clearTimeout(settle.get(track));
    settle.set(track, setTimeout(() => {
      carSync(track.closest("[data-car]"), Math.round(track.scrollLeft / track.clientWidth), false);
    }, 90));
  }, true);
  addEventListener("resize", () => {
    doc.querySelectorAll("[data-car]").forEach((car) => {
      const track = car.querySelector(".car__track");
      track.scrollLeft = Number(car.dataset.idx) * track.clientWidth;
    });
  });

  /* Instagram media that fails to load: the frame stays (no layout shift, the n/N count holds) with its alt text. */
  function broken(img) {
    const frame = img.closest(".ig__frame");
    if (frame) { frame.dataset.broken = ""; return; }
    const fallback = img.nextElementSibling;
    if (img.classList.contains("avatar") && fallback && fallback.classList.contains("avatar")) {
      img.hidden = true;
      fallback.hidden = false;
    }
  }
  const watched = ".ig__frame img, img.avatar[data-fallback]";
  doc.addEventListener("error", (e) => {
    if (e.target instanceof HTMLImageElement && e.target.matches(watched)) broken(e.target);
  }, true);
  doc.querySelectorAll(watched).forEach((img) => { if (img.complete && !img.naturalWidth) broken(img); });
})();
`;
}

/**
 * Only on a page that shows generic cards' images: one the app could not
 * fetch (or refused) leaves no frame behind, the card reads on without it.
 */
export const GENERIC_IMAGE_SCRIPT = `"use strict";
(() => {
  const doc = document;
  function gone(img) {
    const box = img.closest(".gen__thumb, .gen__media");
    if (!box) return;
    const body = box.closest(".gen__body");
    if (body) body.classList.remove("gen__body--thumb");
    box.remove();
  }
  const watched = ".gen__thumb img, .gen__media img";
  doc.addEventListener("error", (e) => {
    if (e.target instanceof HTMLImageElement && e.target.matches(watched)) gone(e.target);
  }, true);
  doc.querySelectorAll(watched).forEach((img) => { if (img.complete && !img.naturalWidth) gone(img); });
})();
`;

export const TIMELINE_SCRIPTS: Readonly<Record<UiLang, string>> = {
  en: timelineScript(RENDER_MESSAGES.en.script),
  tr: timelineScript(RENDER_MESSAGES.tr.script),
};

export const CARDS_SCRIPTS: Readonly<Record<UiLang, string>> = {
  en: cardsScript(RENDER_MESSAGES.en.script),
  tr: cardsScript(RENDER_MESSAGES.tr.script),
};
