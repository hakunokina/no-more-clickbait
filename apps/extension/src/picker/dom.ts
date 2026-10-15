/**
 * Tiny DOM builders for the picker and the Sites section. Everything is
 * built with `createElement` + `textContent` (never innerHTML with data):
 * rule names, selectors and page text are untrusted. Inline styles are
 * set through CSSOM (`style.setProperty`), which a page's strict
 * `style-src` CSP does not block, unlike `style` attributes.
 */

export type Child = Node | string | null | undefined | false;

export interface Attrs {
  [name: string]: string | number | boolean | null | undefined;
}

export function h(
  doc: Document,
  tag: string,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElement {
  const el = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "class") el.className = String(value);
    else if (name === "text") el.textContent = String(value);
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === "string"
        ? (parent.ownerDocument ?? (parent as Document)).createTextNode(child)
        : child,
    );
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Icon paths (24×24, stroked), the design's set. */
export const ICONS = {
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  alert: ["M12 4 2.8 19.5h18.4z", "M12 10v4M12 17v.01"],
  question: ["M9.5 9.5a2.6 2.6 0 0 1 5 .8c0 1.8-2.5 2.2-2.5 3.7M12 17v.01", "circle:12,12,9"],
  minus: ["M8 12h8", "circle:12,12,9"],
  sun: [
    "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    "circle:12,12,4",
  ],
  moon: ["M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"],
  monitor: ["M8 20h8M12 16v4", "rect:3,4,18,12,2"],
  close: ["M6 6l12 12M18 6 6 18"],
  external: ["M14 5h5v5M19 5l-8 8M18 14v5H5V6h5"],
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"],
  trash: ["M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"],
  download: ["M12 4v11M7 10l5 5 5-5M5 20h14"],
  up: ["M12 19V5M6 11l6-6 6 6"],
  down: ["M12 5v14M6 13l6 6 6-6"],
  left: ["M15 5l-7 7 7 7"],
  right: ["M9 5l7 7-7 7"],
  sparkle: [
    "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
    "M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  ],
  pointer: ["M5 3l14 7-6 2-2 6z"],
  collapse: ["M6 9l6 6 6-6"],
  dock: ["M3 15h8v5", "rect:3,4,18,16,2"],
  globe: ["M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18", "circle:12,12,9"],
  plus: ["M12 5v14M5 12h14"],
  lock: ["M8 11V8a4 4 0 0 1 8 0v3", "rect:5,11,14,9,2"],
  rss: ["M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14", "circle:6,18,1.5"],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(doc: Document, name: IconName, flip = false): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (flip) svg.style.setProperty("transform", "scaleX(-1)");
  for (const part of ICONS[name]) {
    if (part.startsWith("circle:")) {
      const [cx, cy, r] = part.slice(7).split(",");
      const circle = doc.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", cx ?? "0");
      circle.setAttribute("cy", cy ?? "0");
      circle.setAttribute("r", r ?? "0");
      svg.appendChild(circle);
    } else if (part.startsWith("rect:")) {
      const [x, y, w, hgt, rx] = part.slice(5).split(",");
      const rect = doc.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", x ?? "0");
      rect.setAttribute("y", y ?? "0");
      rect.setAttribute("width", w ?? "0");
      rect.setAttribute("height", hgt ?? "0");
      rect.setAttribute("rx", rx ?? "0");
      svg.appendChild(rect);
    } else {
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", part);
      svg.appendChild(path);
    }
  }
  return svg;
}

/** "3 hours ago"-style relative time in the UI language; absolute after a day. */
export function relativeTime(iso: string, nowMs: number, lang: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.round((nowMs - time) / 60_000);
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" });
    if (Math.abs(minutes) < 60) return rtf.format(-minutes, "minute");
    if (Math.abs(minutes) < 1440) return rtf.format(-Math.round(minutes / 60), "hour");
  } catch {
    // Unknown locale: the absolute date below.
  }
  return new Date(time).toLocaleDateString(lang, { day: "numeric", month: "short" });
}

/** "today 14:20" / "15 October 14:20" for status lines. */
export function whenText(iso: string, nowMs: number, lang: string, todayWord: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date(nowMs).toDateString()
    ? `${todayWord} ${time}`
    : `${date.toLocaleDateString(lang, { day: "numeric", month: "long" })} ${time}`;
}
