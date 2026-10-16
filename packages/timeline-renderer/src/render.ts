import { createHash } from "node:crypto";
import {
  isGenericItem,
  isInstagramPost,
  feedSourceLabel,
  INTL_LOCALES,
  isXCard,
  platformOf,
  scoreOutOfTen,
  type FunnelCounts,
  type GenericItem,
  type InstagramMedia,
  type InstagramPost,
  type Post,
  type PostMedia,
  type TimelineCard,
  type TimelineDoc,
  type UiLang,
  type VerificationResult,
  type XTimelineCard,
} from "@nmc/core";
import { CARDS_SCRIPTS, TIMELINE_SCRIPTS } from "./client-script.js";
import { RENDER_MESSAGES, type RenderMessages } from "./messages.js";
import { CARDS_CSS, TIMELINE_CSS } from "./styles.js";

/**
 * TimelineDoc → one self-contained HTML page (the approved mockups,
 * docs/design/timeline-mockup.html and, for Instagram and generic cards,
 * timeline-cards-mockup.html, without their developer strips).
 *
 * Feed content is untrusted: every string is HTML-escaped, every URL is
 * parsed and allow-listed (media only from X's and Instagram's CDNs,
 * links https only), the CSP admits nothing but those CDNs and the
 * page's own style/script by hash, and there are no inline handlers or
 * style attributes. Generic (Reddit, custom site) images are not shown
 * at all: the page would have to admit every site's host.
 *
 * The page's own words are English or Turkish (`lang`); the Turkish
 * page is the mockups' original copy.
 */

export interface RenderOptions {
  /** IANA time zone for absolute dates (default: the process's). */
  timeZone?: string;
  /** The page's language: words, dates and numbers (default English). */
  lang?: UiLang;
  /**
   * Render the "Collect new timeline" / "Try again" buttons
   * (`data-action="collect" | "retry"`) for a host page that handles
   * them (the desktop window). A plain file has nothing to call, so off
   * by default.
   */
  actions?: boolean;
}

const IMAGE_HOSTS = new Set(["pbs.twimg.com"]);
const VIDEO_HOSTS = new Set(["video.twimg.com"]);
const POST_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "www.x.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);
/** Instagram serves media from per-region hosts under these two domains. */
const IG_MEDIA_DOMAINS = [".cdninstagram.com", ".fbcdn.net"];
const IG_POST_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const IG_HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const HANDLE = /^[A-Za-z0-9_]{1,50}$/;
const STATUS_ID = /^\d{1,30}$/;
/** X marks text it cannot classify with these; they are not languages. */
const NON_LANGUAGES = new Set(["und", "zxx", "qme", "qam", "qct", "qht", "qst", "art"]);
const LONG_TEXT = 600;

function sha256(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

function buildCsp(css: string, script: string, instagram: boolean): string {
  const ig = instagram ? IG_MEDIA_DOMAINS.map((d) => ` https://*${d}`).join("") : "";
  return [
    "default-src 'none'",
    `img-src https://pbs.twimg.com${ig} data:`,
    `media-src https://video.twimg.com${ig}`,
    `style-src ${sha256(css)}`,
    `script-src ${sha256(script)}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The CSP of a page with X cards only (the X CDNs), per language (its script's hash). */
export const TIMELINE_CSPS: Readonly<Record<UiLang, string>> = {
  en: buildCsp(TIMELINE_CSS, TIMELINE_SCRIPTS.en, false),
  tr: buildCsp(TIMELINE_CSS, TIMELINE_SCRIPTS.tr, false),
};

/**
 * The page's style, script and CSP. An X-only page gets exactly the
 * X-era assets; Instagram/generic cards add their CSS and script, and
 * Instagram cards add Instagram's CDNs to the CSP.
 */
function pageAssets(
  cards: readonly TimelineCard[],
  lang: UiLang,
): {
  css: string;
  script: string;
  csp: string;
} {
  if (cards.every(isXCard)) {
    return { css: TIMELINE_CSS, script: TIMELINE_SCRIPTS[lang], csp: TIMELINE_CSPS[lang] };
  }
  const css = TIMELINE_CSS + CARDS_CSS;
  const script = TIMELINE_SCRIPTS[lang] + CARDS_SCRIPTS[lang];
  const instagram = cards.some((card) => isInstagramPost(card.post));
  return { css, script, csp: buildCsp(css, script, instagram) };
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for element content and double-quoted attributes. */
export function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** https URL (no credentials), optionally limited to `hosts`; else undefined. */
export function safeUrl(raw: string | undefined, hosts?: ReadonlySet<string>): URL | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  if (hosts && !hosts.has(url.hostname)) return undefined;
  return url;
}

/** An https URL on one of Instagram's media CDNs; else undefined. */
export function igMediaUrl(raw: string | undefined): URL | undefined {
  const url = safeUrl(raw);
  return url && IG_MEDIA_DOMAINS.some((domain) => url.hostname.endsWith(domain))
    ? url
    : undefined;
}

/* ── Icons (decorative, aria-hidden) ─────────────────────────── */

const ICON = {
  reply: '<path d="M4 5h16v11H10l-4 4v-4H4z"/>',
  repost: '<path d="M7 17V8h11M15 5l3 3-3 3M17 7v9H6M9 19l-3-3 3-3"/>',
  like: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
  views: '<path d="M5 19v-7M12 19V5M19 19v-10"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 17v.01"/>',
  question:
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 0 1 5 .8c0 1.8-2.5 2.2-2.5 3.7M12 17v.01"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  camera:
    '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5v.01"/>',
  reel: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 8h18M8 3l3 5M14 3l3 5"/><path d="M10 11.5v5l4.5-2.5z"/>',
  plays: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
} as const;
type IconName = keyof typeof ICON;

function icon(name: IconName, cls = ""): string {
  return `<svg class="i${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
}

const verifiedBadge = (ctx: Ctx): string =>
  `<svg class="badge-verified" viewBox="0 0 24 24" role="img" aria-label="${ctx.m.verifiedAccount}"><title>${ctx.m.verifiedAccount}</title>` +
  '<path fill="var(--accent)" d="M12 1.8l2.6 1.9 3.2-.2 1 3 2.6 1.9-1 3 1 3-2.6 1.9-1 3-3.2-.2L12 22.2l-2.6-1.9-3.2.2-1-3-2.6-1.9 1-3-1-3 2.6-1.9 1-3 3.2.2z"/>' +
  '<path d="M8 12.3l2.7 2.7L16.2 9.5" fill="none" stroke="var(--on-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ── Formatting ──────────────────────────────────────────────── */

interface Ctx {
  /** The page's words. */
  m: RenderMessages;
  /** Intl locale of the page's language. */
  locale: string;
  /** Reference time for relative dates: the capture (else the doc) time. */
  refMs: number;
  abs: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  clock: Intl.DateTimeFormat;
  title: Intl.DateTimeFormat;
  compact: Intl.NumberFormat;
  actions: boolean;
}

function makeCtx(doc: TimelineDoc, lang: UiLang, opts: RenderOptions): Ctx {
  const tz = opts.timeZone ? { timeZone: opts.timeZone } : {};
  const locale = INTL_LOCALES[lang];
  return {
    m: RENDER_MESSAGES[lang],
    locale,
    refMs: Date.parse(doc.header.capturedAt ?? doc.header.generatedAt),
    abs: new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short", ...tz }),
    day: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...tz }),
    clock: new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      ...tz,
    }),
    title: new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      weekday: "long",
      ...tz,
    }),
    compact: new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }),
    actions: opts.actions ?? false,
  };
}

function relTime(ctx: Ctx, iso: string): string {
  const min = Math.max(0, Math.round((ctx.refMs - Date.parse(iso)) / 60e3));
  if (min < 1) return ctx.m.now;
  if (min < 60) return ctx.m.minutesAgo(min);
  if (min < 24 * 60) return ctx.m.hoursAgo(Math.round(min / 60));
  return ctx.day.format(new Date(iso));
}

function timeTag(ctx: Ctx, iso: string): string {
  return `<time class="post__time" datetime="${esc(iso)}" title="${esc(ctx.abs.format(new Date(iso)))}">${esc(relTime(ctx, iso))}</time>`;
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** 0.91 → "9 / 10": the Settings' 0-10 scale, rounded down (scoreOutOfTen). */
function outOfTen(value: number): string {
  return `${scoreOutOfTen(value)} / 10`;
}

function initials(ctx: Ctx, name: string): string {
  return name
    .replace(/^@/, "")
    .split(/[\s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase(ctx.locale);
}

function hueClass(handle: string): string {
  let hash = 0;
  for (const ch of handle) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `avatar--h${hash % 8}`;
}

function profileUrl(handle: string): string | undefined {
  return HANDLE.test(handle) ? `https://x.com/${handle}` : undefined;
}

/** A valid BCP 47-looking language tag, or undefined for X's non-language codes. */
function langAttr(lang: string | undefined): string {
  if (!lang || NON_LANGUAGES.has(lang) || !/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang))
    return "";
  return ` lang="${esc(lang)}"`;
}

/** Instagram/generic text: its own language when valid, else "und" (unknown). */
function langOrUnd(lang: string | undefined): string {
  return langAttr(lang) || ' lang="und"';
}

/** X serves 48px `_normal` avatars; `_bigger` (73px) keeps 40px sharp on HiDPI. */
function avatarSrc(raw: string | undefined): string | undefined {
  const url = safeUrl(raw, IMAGE_HOSTS);
  if (!url) return undefined;
  url.pathname = url.pathname.replace(/_normal(\.\w+)$/, "_bigger$1");
  return url.href;
}

function avatar(
  ctx: Ctx,
  handle: string,
  name: string,
  avatarUrl: string | undefined,
  small = false,
): string {
  const size = small ? " avatar--sm" : "";
  const src = small ? undefined : avatarSrc(avatarUrl);
  if (src) {
    return `<img class="avatar${size}" src="${esc(src)}" alt="" width="40" height="40" loading="lazy" decoding="async">`;
  }
  return `<span class="avatar${size} ${hueClass(handle)}" aria-hidden="true">${esc(initials(ctx, name))}</span>`;
}

/** Plain text with its https links made clickable; everything else escaped. */
function linkify(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(/https:\/\/[^\s<>"'“”]+/g)) {
    const raw = match[0].replace(/[.,;:!?)\]'"»]+$/, "");
    const start = match.index ?? 0;
    const url = safeUrl(raw);
    if (!url) continue;
    const shown = raw.replace(/^https:\/\//, "");
    out += esc(text.slice(last, start));
    out += `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer" title="${esc(raw)}">${esc(
      shown.length > 40 ? `${shown.slice(0, 39)}…` : shown,
    )}</a>`;
    last = start + raw.length;
  }
  return out + esc(text.slice(last));
}

function externalLink(url: URL, inner: string, cls = ""): string {
  return `<a${cls ? ` class="${cls}"` : ""} href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

/* ── Media ───────────────────────────────────────────────────── */

function dims(m: PostMedia): string {
  return m.width && m.height ? ` width="${m.width}" height="${m.height}"` : "";
}

function nodims(m: PostMedia): string {
  return m.width && m.height ? "" : " media__cell--nodims";
}

/** The "ALT" chip that shows a photo's alt text. */
function altChip(ctx: Ctx, altId: string): string {
  const before = ctx.m.altBefore ? `<span class="sr-only">${ctx.m.altBefore}</span>` : "";
  return `<button class="chip" type="button" aria-expanded="false" aria-controls="${altId}" data-alt>${before}ALT<span class="sr-only">${ctx.m.altAfter}</span></button>`;
}

function renderPhotos(ctx: Ctx, pid: string, photos: PostMedia[]): string {
  // Numbered after the host filter: a dropped photo leaves no gap in "(k/n)".
  const shown = photos.slice(0, 4).flatMap((m) => {
    const src = safeUrl(m.url, IMAGE_HOSTS);
    return src ? [{ m, src }] : [];
  });
  const n = shown.length;
  if (!n) return "";
  const cells = shown.map(({ m, src }, k) => {
    const alt = m.altText?.trim() ?? "";
    const altId = `${pid}-alt-${k + 1}`;
    const position = n > 1 ? ` (${k + 1}/${n})` : "";
    const name = alt ? ctx.m.zoomWithAlt(position) : ctx.m.zoomImage(position);
    return (
      `<div class="media__cell${nodims(m)}">` +
      `<button class="media__zoom" type="button"><img src="${esc(src.href)}" alt="${esc(alt)}"${dims(m)} loading="lazy" decoding="async"><span class="sr-only">${name}</span></button>` +
      (alt
        ? altChip(ctx, altId) + `<p class="alt-pop" id="${altId}" hidden>${esc(alt)}</p>`
        : "") +
      `</div>`
    );
  });
  return `<div class="media media--${n}">${cells.join("")}</div>`;
}

function mp4(m: PostMedia): URL | undefined {
  for (const variant of m.variants ?? []) {
    const url = safeUrl(variant.url, VIDEO_HOSTS);
    if (url) return url;
  }
  return undefined;
}

function renderVideo(ctx: Ctx, m: PostMedia, postUrl: URL | undefined): string {
  const poster = safeUrl(m.url, IMAGE_HOSTS);
  const src = mp4(m);
  const alt = m.altText?.trim() ?? "";
  const length = m.durationMs !== undefined ? duration(m.durationMs) : "";
  const label = `${ctx.m.playVideo}${length ? ctx.m.duration(length) : ""}${alt ? `. ${alt}` : ""}`;
  const chip = length
    ? `<span class="chip chip--dur" aria-hidden="true">${esc(length)}</span>`
    : "";
  if (src) {
    return (
      `<div class="media media--1"><div class="media__cell video${nodims(m)}" data-state="idle">` +
      `<video${dims(m)} preload="none" playsinline${poster ? ` poster="${esc(poster.href)}"` : ""}${alt ? ` aria-label="${esc(alt)}"` : ' aria-label="Video"'}>` +
      `<source src="${esc(src.href)}" type="video/mp4"></video>` +
      `<button class="video__play" type="button" aria-label="${esc(label)}">${icon("play")}</button>${chip}` +
      `</div></div>`
    );
  }
  // No playable rendition on X's video CDN: the poster, and the post on X.
  if (!poster) return "";
  const open = postUrl
    ? `<a class="video__play" href="${esc(postUrl.href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`${label} ${ctx.m.onX}`)}">${icon("play")}</a>`
    : "";
  return (
    `<div class="media media--1"><div class="media__cell video${nodims(m)}">` +
    `<img src="${esc(poster.href)}" alt=""${dims(m)} loading="lazy" decoding="async">${open}${chip}` +
    `</div></div>`
  );
}

/** `gid`: unique per GIF of the post, for the still-frame fallback's ids. */
function renderGif(ctx: Ctx, gid: string, m: PostMedia): string {
  const poster = safeUrl(m.url, IMAGE_HOSTS);
  const src = mp4(m);
  const alt = m.altText?.trim() ?? "";
  if (!src) {
    // No playable rendition: its still frame, as a photo.
    return renderPhotos(ctx, gid, [{ ...m, type: "photo" }]);
  }
  return (
    `<div class="media media--1"><div class="media__cell gif${nodims(m)}" data-playing="false">` +
    `<video${dims(m)} preload="none" muted loop playsinline${poster ? ` poster="${esc(poster.href)}"` : ""} aria-label="${esc(alt ? `GIF: ${alt}` : "GIF")}">` +
    `<source src="${esc(src.href)}" type="video/mp4"></video>` +
    `<span class="chip" aria-hidden="true">GIF</span>` +
    `<button class="gif__toggle" type="button" aria-pressed="false" aria-label="${ctx.m.playGif}">${icon("play", "i-play")}${icon("pause", "i-pause")}</button>` +
    `</div></div>`
  );
}

/** Photos as one grid (≤ 4), then each video/GIF full width, in post order. */
function renderMedia(
  ctx: Ctx,
  pid: string,
  media: PostMedia[],
  postUrl: URL | undefined,
): string {
  const photos = media.filter((m) => m.type === "photo");
  let out = renderPhotos(ctx, pid, photos);
  let gifs = 0;
  for (const m of media) {
    if (m.type === "video") out += renderVideo(ctx, m, postUrl);
    if (m.type === "gif") out += renderGif(ctx, `${pid}-gif${++gifs}`, m);
  }
  return out;
}

function renderLink(m: PostMedia): string {
  const url = safeUrl(m.url);
  if (!url) return "";
  const card = m.card;
  const domain = card?.domain?.trim() || url.hostname.replace(/^www\./, "");
  if (!card?.title) {
    const shown = url.href.replace(/^https:\/\//, "");
    return externalLink(
      url,
      `<span class="linkcard__body"><span class="linkcard__domain">${esc(domain)}</span><span class="linkcard__url">${esc(shown)}</span></span>`,
      "linkcard linkcard--plain",
    );
  }
  const image = safeUrl(card.image?.url, IMAGE_HOSTS);
  return externalLink(
    url,
    (image ? `<img src="${esc(image.href)}" alt="" loading="lazy" decoding="async">` : "") +
      `<span class="linkcard__body"><span class="linkcard__domain">${esc(domain)}</span>` +
      `<span class="linkcard__title">${esc(card.title)}</span>` +
      (card.description ? `<span class="linkcard__desc">${esc(card.description)}</span>` : "") +
      `</span>`,
    "linkcard",
  );
}

function renderQuote(ctx: Ctx, quoted: NonNullable<Post["quoted"]>): string {
  const name = quoted.authorName?.trim() || `@${quoted.authorHandle}`;
  const href =
    HANDLE.test(quoted.authorHandle) && STATUS_ID.test(quoted.id)
      ? `https://x.com/${quoted.authorHandle}/status/${quoted.id}`
      : undefined;
  const visual = (quoted.media ?? []).find((m) => m.type !== "link");
  const thumb = visual ? safeUrl(visual.url, IMAGE_HOSTS) : undefined;
  const inner =
    `<span class="sr-only">${ctx.m.quotedPost}</span>` +
    `<span class="quote__head"><span class="quote__arrow" aria-hidden="true">↳</span>${avatar(ctx, quoted.authorHandle, name, undefined, true)}` +
    `<strong>${esc(name)}</strong>${quoted.authorVerified ? verifiedBadge(ctx) : ""}<span class="post__handle">@${esc(quoted.authorHandle)}</span>` +
    (quoted.publishedAt
      ? `<span class="post__dot" aria-hidden="true">·</span>${timeTag(ctx, quoted.publishedAt)}`
      : "") +
    `</span>` +
    (quoted.text ? `<span class="quote__text">${esc(quoted.text)}</span>` : "") +
    (thumb && visual
      ? `<span class="quote__media"><img src="${esc(thumb.href)}" alt="${esc(visual.altText?.trim() ?? "")}" loading="lazy" decoding="async"></span>`
      : "");
  return href
    ? `<a class="quote" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="quote">${inner}</div>`;
}

/* ── Verification, why, engagement ───────────────────────────── */

const VERDICT = {
  verified: { cls: "ok", icon: "check", label: "verified", lead: "verifiedLead" },
  unverifiable: {
    cls: "info",
    icon: "question",
    label: "unverifiable",
    lead: "unverifiableLead",
  },
} as const satisfies Record<
  string,
  { cls: string; icon: IconName; label: keyof RenderMessages; lead: keyof RenderMessages }
>;

function renderVerify(ctx: Ctx, pid: string, v: VerificationResult | null): string {
  if (!v || v.status === "false_or_disputed") return "";
  const d = VERDICT[v.status];
  const { m } = ctx;
  const panelId = `${pid}-verify`;
  const sources = v.sources
    .map((s) => {
      const url = safeUrl(s.url);
      const title = esc(s.title.trim() || (url?.hostname ?? s.url));
      const host = url ? ` <small>${esc(url.hostname.replace(/^www\./, ""))}</small>` : "";
      return `<li>${url ? externalLink(url, title) : title}${host}</li>`;
    })
    .join("");
  return (
    `<div class="verify verify--${d.cls}">` +
    `<button class="verify__toggle" type="button" aria-expanded="false" aria-controls="${panelId}">` +
    `${icon(d.icon)}<span class="verify__label">${m[d.label]}</span>` +
    `<span class="verify__claim"><span class="sr-only">${m.claim}</span>${esc(v.claim)}</span>${icon("chevron", "verify__chev")}</button>` +
    `<div class="verify__panel" id="${panelId}" hidden>` +
    `<p class="verify__claimfull">“${esc(v.claim)}”</p><p>${m[d.lead]}</p>` +
    (v.summary.trim() ? `<p>${esc(v.summary)}</p>` : "") +
    (sources
      ? `<p><strong>${m.sources}</strong></p><ul class="verify__sources">${sources}</ul>`
      : "") +
    `<p class="verify__meta">${v.failed ? m.checkFailed : m.checkedBy}</p>` +
    `</div></div>`
  );
}

function renderWhy(ctx: Ctx, pid: string, card: TimelineCard, total: number): string {
  const { score, levels } = card;
  const { m } = ctx;
  return (
    `<div class="why" id="${pid}-why" hidden>` +
    (score.reason?.trim() ? `<p>${esc(score.reason)}</p>` : "") +
    `<dl><dt>${m.readValue}</dt><dd>${m.level(levels.readValue)} <small>(${outOfTen(score.readWorthinessScore)})</small></dd>` +
    `<dt>${m.clickbait}</dt><dd>${m.level(levels.clickbait)} <small>(${outOfTen(score.clickbaitScore)})</small></dd>` +
    `<dt>${m.rank}</dt><dd>${card.rank} / ${total}</dd></dl></div>`
  );
}

function renderStats(ctx: Ctx, metrics: Post["metrics"]): string {
  const m = metrics ?? {};
  return statsList(ctx, [
    ["replies", "reply", ctx.m.replies, m.replies],
    ["reposts", "repost", ctx.m.reposts, m.reposts],
    ["likes", "like", ctx.m.likes, m.likes],
    ["views", "views", ctx.m.views, m.views],
  ]);
}

/**
 * "Kaynak: X" / "Kaynak: Instagram" above an X or Instagram card, only
 * in a feed with more than one platform; on X it carries the repost
 * line (one line, not two). Generic cards have their place row instead.
 */
function sourceLine(ctx: Ctx, platform: "x" | "instagram", repostedBy?: string): string {
  const [label, mark] = platform === "x" ? ["X", "X"] : ["Instagram", icon("camera")];
  return (
    `<div class="src"><span class="src__mark" aria-hidden="true">${mark}</span><span><span class="sr-only">${ctx.m.sourcePrefix}</span>${label}</span>` +
    (repostedBy
      ? `<span class="src__sep" aria-hidden="true">·</span>${icon("repost")}<span class="src__repost">${ctx.m.reposted(esc(repostedBy))}</span>`
      : "") +
    `</div>`
  );
}

function renderXCard(ctx: Ctx, card: XTimelineCard, total: number, mixed: boolean): string {
  const { post } = card;
  const pid = `p${card.rank}`;
  const name = post.authorName?.trim() || `@${post.authorHandle}`;
  const profile = profileUrl(post.authorHandle);
  const postUrl = safeUrl(post.url, POST_HOSTS);
  const text = post.text.trim();
  const long = text.length > LONG_TEXT;
  const links = post.media
    .filter((m) => m.type === "link")
    .map(renderLink)
    .join("");
  return (
    `<article class="post" id="${pid}" tabindex="0" aria-posinset="${card.rank}" aria-setsize="${total}" aria-labelledby="${pid}-name"${text ? ` aria-describedby="${pid}-text"` : ""}>` +
    (mixed
      ? sourceLine(ctx, "x", post.repostedBy)
      : post.repostedBy
        ? `<div class="post__repost">${icon("repost")}<span>${ctx.m.reposted(esc(post.repostedBy))}</span></div>`
        : "") +
    `<div class="post__grid">${avatar(ctx, post.authorHandle, name, post.authorAvatarUrl)}<div class="post__main">` +
    `<div class="post__head">` +
    (profile
      ? `<a class="post__name" id="${pid}-name" href="${esc(profile)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`
      : `<span class="post__name" id="${pid}-name">${esc(name)}</span>`) +
    (post.authorVerified ? verifiedBadge(ctx) : "") +
    `<span class="post__handle">@${esc(post.authorHandle)}</span><span class="post__dot" aria-hidden="true">·</span>${timeTag(ctx, post.publishedAt)}` +
    `</div>` +
    (text
      ? `<p class="post__text${long ? " is-clamped" : ""}" id="${pid}-text"${langAttr(post.lang)}>${linkify(text)}</p>`
      : "") +
    (long ? moreButton(ctx, `${pid}-text`) : "") +
    renderMedia(ctx, pid, post.media, postUrl) +
    (post.quoted ? renderQuote(ctx, post.quoted) : "") +
    links +
    renderVerify(ctx, pid, card.verification) +
    cardFoot(ctx, pid, card, total, renderStats(ctx, post.metrics), ctx.m.openOnX, postUrl) +
    `</div></div></article>`
  );
}

/* ── Shared by the Instagram and generic cards ────────────────── */

type Stat = [
  key: string,
  ic: IconName,
  label: string,
  value: number | undefined,
  shown?: string | undefined,
];

function statsList(ctx: Ctx, stats: Stat[]): string {
  return (
    `<ul class="stats" aria-label="${ctx.m.engagement}">` +
    stats
      .map(([key, ic, label, value, shown]) =>
        value === undefined
          ? ""
          : `<li data-k="${key}" title="${label}">${icon(ic)}<span class="sr-only">${label}: </span>${esc(shown ?? ctx.compact.format(value))}</li>`,
      )
      .join("") +
    `</ul>`
  );
}

/** Engagement (`stats`, a stats list), "Why is this here?" and the open-at-source link. */
function cardFoot(
  ctx: Ctx,
  pid: string,
  card: TimelineCard,
  total: number,
  stats: string,
  openLabel: string,
  openUrl: URL | undefined,
): string {
  return (
    `<div class="post__foot">${stats}<div class="post__actions">` +
    `<button class="link-btn why-btn" type="button" aria-expanded="false" aria-controls="${pid}-why">${ctx.m.whyHere}</button>` +
    (openUrl
      ? `<a class="open-x" href="${esc(openUrl.href)}" target="_blank" rel="noopener noreferrer">${openLabel}${icon("external")}<span class="sr-only">${ctx.m.newWindow}</span></a>`
      : "") +
    `</div></div>` +
    renderWhy(ctx, pid, card, total)
  );
}

function moreButton(ctx: Ctx, targetId: string): string {
  return `<button class="link-btn" type="button" data-more aria-expanded="false" aria-controls="${targetId}">${ctx.m.readMore}</button>`;
}

/* ── Instagram card ──────────────────────────────────────────── */

const IG_LONG_CAPTION = 180;

/** Like X's: a 40px picture from the CDN (initials if it fails to load), else initials. */
function igAvatar(ctx: Ctx, post: InstagramPost): string {
  const name = post.authorName?.trim() || post.authorHandle;
  const initialsSpan = (hidden: boolean) =>
    `<span class="avatar ${hueClass(post.authorHandle)}" aria-hidden="true"${hidden ? " hidden" : ""}>${esc(initials(ctx, name))}</span>`;
  const src = igMediaUrl(post.authorAvatarUrl);
  if (!src) return initialsSpan(false);
  return (
    `<img class="avatar" src="${esc(src.href)}" alt="" width="40" height="40" loading="lazy" decoding="async" data-fallback>` +
    initialsSpan(true)
  );
}

/** The first frame's aspect ratio, kept within Instagram's 4:5 … 1.91:1 (1:1 without a size). */
function igRatio(m: InstagramMedia): string {
  const r = m.width && m.height ? Math.min(1.91, Math.max(0.8, m.width / m.height)) : 1;
  // An SVG viewBox holds the frame's height: style attributes are outside the CSP.
  return `<svg class="ig__ratio" viewBox="0 0 1000 ${Math.round(1000 / r)}" aria-hidden="true" focusable="false"></svg>`;
}

function igPhoto(
  ctx: Ctx,
  pid: string,
  m: InstagramMedia,
  src: URL,
  k: number,
  n: number,
  ratio: string,
): string {
  const alt = m.altText?.trim() ?? "";
  const altId = `${pid}-alt-${k + 1}`;
  const position = n > 1 ? ` (${k + 1}/${n})` : "";
  const dims = m.width && m.height ? ` width="${m.width}" height="${m.height}"` : "";
  return (
    `<div class="ig__frame">${ratio}` +
    `<button class="media__zoom" type="button"><img src="${esc(src.href)}" alt="${esc(alt)}"${dims} loading="lazy" decoding="async"><span class="sr-only">${alt ? ctx.m.zoomWithAlt(position) : ctx.m.zoomImage(position)}</span></button>` +
    (alt
      ? altChip(ctx, altId) + `<p class="alt-pop" id="${altId}" hidden>${esc(alt)}</p>`
      : "") +
    `<p class="ig__fallback" aria-hidden="true">${esc(alt ? ctx.m.imageFailedAlt(alt) : ctx.m.imageFailed)}</p>` +
    `</div>`
  );
}

/**
 * A reel or a carousel's video: X's video player in an Instagram frame,
 * idle until asked (no autoplay). Without a playable rendition: the
 * poster and a play link to the post on Instagram.
 */
function igVideo(
  ctx: Ctx,
  m: InstagramMedia,
  postUrl: URL | undefined,
  reel: boolean,
  frame: string,
): string {
  const poster = igMediaUrl(m.url);
  const src = igMediaUrl(m.videoUrl);
  const alt = m.altText?.trim() ?? "";
  const length = m.durationMs !== undefined ? duration(m.durationMs) : "";
  const what = reel ? ctx.m.playReel : ctx.m.playVideo;
  const label = `${what}${length ? ctx.m.duration(length) : ""}${alt ? `. ${alt}` : ""}`;
  const dims = m.width && m.height ? ` width="${m.width}" height="${m.height}"` : "";
  const tag = reel
    ? `<span class="reel__tag" aria-hidden="true">${icon("reel")}Reel</span>`
    : "";
  const chip = length
    ? `<span class="chip chip--dur" aria-hidden="true">${esc(length)}</span>`
    : "";
  const box = reel ? "reel video" : "ig__frame video";
  if (src) {
    return (
      `<div class="${box}" data-state="idle">${frame}` +
      `<video${dims} preload="none" playsinline${poster ? ` poster="${esc(poster.href)}"` : ""} aria-label="${esc(alt || (reel ? "Reel" : "Video"))}">` +
      `<source src="${esc(src.href)}" type="video/mp4"></video>` +
      `${tag}<button class="video__play" type="button" aria-label="${esc(label)}">${icon("play")}</button>${chip}</div>`
    );
  }
  if (!poster) return "";
  const open = postUrl
    ? `<a class="video__play" href="${esc(postUrl.href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`${label} ${ctx.m.onInstagram}`)}">${icon("play")}</a>`
    : "";
  return `<div class="${box}">${frame}<img src="${esc(poster.href)}" alt=""${dims} loading="lazy" decoding="async">${tag}${open}${chip}</div>`;
}

/** A frame Instagram's CDN serves: an image, or a video with a poster or a rendition there. */
function igShown(m: InstagramMedia): boolean {
  return Boolean(
    m.type === "image" ? igMediaUrl(m.url) : igMediaUrl(m.url) || igMediaUrl(m.videoUrl),
  );
}

/** What the card shows: a reel's video alone when it can, else the CDN's frames. */
function igShownMedia(post: InstagramPost): InstagramMedia[] {
  if (post.kind === "reel") {
    const video = post.media.find((m) => m.type === "video");
    if (video && igShown(video)) return [video];
  }
  return post.media.filter(igShown);
}

function igMedia(ctx: Ctx, pid: string, post: InstagramPost, postUrl: URL | undefined): string {
  if (post.kind === "reel") {
    const video = post.media.find((m) => m.type === "video");
    const reel = video ? igVideo(ctx, video, postUrl, true, "") : "";
    if (reel) return `<div class="media ig__media reel-wrap">${reel}</div>`;
  }
  // Frames from Instagram's CDN only, numbered after that filter (like X's photos).
  const frames = post.media.filter(igShown);
  const n = frames.length;
  const first = frames[0];
  if (!first) return "";
  const ratio = igRatio(first);
  const frame = (m: InstagramMedia, k: number) => {
    const src = m.type === "image" ? igMediaUrl(m.url) : undefined;
    return src
      ? igPhoto(ctx, pid, m, src, k, n, ratio)
      : igVideo(ctx, m, postUrl, false, ratio);
  };
  if (n === 1) return `<div class="media ig__media">${frame(first, 0)}</div>`;
  return (
    `<div class="media ig__media car" data-car data-idx="0" role="group" aria-roledescription="carousel" aria-label="${ctx.m.carousel(n)}">` +
    `<span class="car__count" aria-hidden="true">1/${n}</span>` +
    `<div class="car__track">` +
    frames
      .map(
        (m, k) =>
          `<div class="car__slide" role="group" aria-roledescription="slide" aria-label="${k + 1} / ${n}"${k ? " inert" : ""}>${frame(m, k)}</div>`,
      )
      .join("") +
    `</div>` +
    `<button class="car__btn car__prev" type="button" data-car-step="-1" aria-label="${ctx.m.previousImage}" hidden>${icon("left")}</button>` +
    `<button class="car__btn car__next" type="button" data-car-step="1" aria-label="${ctx.m.nextImage}">${icon("right")}</button>` +
    `<span class="sr-only" aria-live="polite" data-car-live></span>` +
    `</div>` +
    `<div class="car__dots" aria-hidden="true">${frames.map((_, k) => `<i${k ? "" : " data-on"}></i>`).join("")}</div>`
  );
}

function renderIgCard(
  ctx: Ctx,
  card: TimelineCard & { post: InstagramPost },
  total: number,
  mixed: boolean,
): string {
  const { post } = card;
  const pid = `p${card.rank}`;
  const handle = post.authorHandle;
  const profile = IG_HANDLE.test(handle) ? `https://www.instagram.com/${handle}/` : undefined;
  const postUrl = safeUrl(post.url, IG_POST_HOSTS);
  const caption = post.caption.trim();
  const long = caption.length > IG_LONG_CAPTION;
  const m = post.metrics ?? {};
  const coauthors = (post.coauthors ?? [])
    .map(({ handle: co }) =>
      IG_HANDLE.test(co)
        ? `${ctx.m.coauthorJoin}<a class="ig__handle" href="https://www.instagram.com/${co}/" target="_blank" rel="noopener noreferrer">${esc(co)}</a>`
        : `${ctx.m.coauthorJoin}<span class="ig__handle">${esc(co)}</span>`,
    )
    .join("");
  // A paid partnership is not an ad (ads never reach the feed): shown, labelled.
  const partner = post.paidPartnership?.partner?.trim();
  const sub = [
    post.paidPartnership
      ? `<span class="ig__paid">${ctx.m.paidPartnership}</span>${partner ? ` · ${esc(partner)}` : ""}`
      : "",
    post.location?.trim() ? esc(post.location.trim()) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    `<article class="post post--ig" id="${pid}" tabindex="0" aria-posinset="${card.rank}" aria-setsize="${total}" aria-labelledby="${pid}-name"${caption ? ` aria-describedby="${pid}-text"` : ""}>` +
    (mixed ? sourceLine(ctx, "instagram") : "") +
    `<div class="ig__head">${igAvatar(ctx, post)}<div class="ig__who"><div class="ig__line">` +
    (profile
      ? `<a class="ig__handle" id="${pid}-name" href="${esc(profile)}" target="_blank" rel="noopener noreferrer">${esc(handle)}</a>`
      : `<span class="ig__handle" id="${pid}-name">${esc(handle)}</span>`) +
    (post.authorVerified ? verifiedBadge(ctx) : "") +
    coauthors +
    `<span class="post__dot" aria-hidden="true">·</span>${timeTag(ctx, post.publishedAt)}` +
    `</div>` +
    (sub ? `<p class="ig__sub">${sub}</p>` : "") +
    `</div></div>` +
    igMedia(ctx, pid, post, postUrl) +
    (caption
      ? `<p class="ig__caption${long ? " is-clamped" : ""}" id="${pid}-text"${langOrUnd(post.lang)}><b>${esc(handle)}</b> ${esc(caption)}</p>`
      : "") +
    (long ? moreButton(ctx, `${pid}-text`) : "") +
    renderVerify(ctx, pid, card.verification) +
    cardFoot(
      ctx,
      pid,
      card,
      total,
      statsList(ctx, [
        ["likes", "like", ctx.m.likes, m.likes],
        ["comments", "reply", ctx.m.comments, m.comments],
        ["views", "plays", ctx.m.plays, m.views],
      ]),
      ctx.m.openOnInstagram,
      postUrl,
    ) +
    `</article>`
  );
}

/* ── Generic card (Reddit + custom sites) ────────────────────── */

const GENERIC_LONG_TEXT = 320;

function isReddit(item: GenericItem): boolean {
  return item.sourceLabel === "reddit";
}

/** A link's host as parsed, not the page's own domain text: where a click goes. */
function genericHost(item: GenericItem, raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "") || item.domain;
  } catch {
    return item.domain;
  }
}

function renderGenericCard(
  ctx: Ctx,
  card: TimelineCard & { post: GenericItem },
  total: number,
): string {
  const { post } = card;
  const pid = `p${card.rank}`;
  const reddit = isReddit(post);
  const url = safeUrl(post.url);
  // The domain row goes where the link goes: the outside target of a Reddit link post.
  const targetRaw = post.linkUrl ?? post.url;
  const target = safeUrl(targetRaw);
  const host = genericHost(post, targetRaw);
  const place = post.community?.trim() || post.domain;
  // Round = a person, square = a site or community.
  const badge = reddit
    ? `<span class="site-badge site-badge--reddit" aria-hidden="true">r/</span>`
    : `<span class="site-badge ${hueClass(host)}" aria-hidden="true">${esc(Array.from(place)[0]?.toLocaleUpperCase(ctx.locale) ?? "")}</span>`;
  const author = post.author?.trim();
  const meta = [
    author ? esc(reddit ? `u/${author}` : author) : "",
    post.publishedAt
      ? `<time datetime="${esc(post.publishedAt)}" title="${esc(ctx.abs.format(new Date(post.publishedAt)))}">${esc(relTime(ctx, post.publishedAt))}</time>`
      : "",
  ].filter(Boolean);
  const title = post.title?.trim() ?? "";
  const text = post.text?.trim() ?? "";
  const long = text.length > GENERIC_LONG_TEXT;
  const titleId = `${pid}-title`;
  const textId = `${pid}-text`;
  // A Reddit self post's domain repeats the place row; every link shows where it goes.
  const domain =
    reddit && post.linkUrl === undefined
      ? ""
      : target
        ? `<a class="gen__domain" href="${esc(target.href)}" target="_blank" rel="noopener noreferrer">${icon("link")}<span>${esc(host)}</span><span class="sr-only">${ctx.m.newWindow}</span></a>`
        : `<span class="gen__domain">${icon("link")}<span>${esc(host)}</span></span>`;
  const lang = langOrUnd(post.lang);
  const flair = post.flair?.trim()
    ? `<span class="flair"><span class="sr-only">${ctx.m.flair}</span>${esc(post.flair.trim())}</span>`
    : "";
  const { score, comments } = post.engagement ?? {};
  return (
    `<article class="post post--gen" id="${pid}" tabindex="0" aria-posinset="${card.rank}" aria-setsize="${total}" aria-labelledby="${title ? titleId : `${pid}-place`}"${text ? ` aria-describedby="${textId}"` : ""}>` +
    `<div class="post__grid">${badge}<div class="post__main">` +
    `<div class="gen__head"><span class="gen__place" id="${pid}-place">${reddit ? `<span class="sr-only">Reddit, </span>` : ""}${esc(place)}</span>` +
    (meta.length
      ? `<span class="gen__dot" aria-hidden="true">·</span><span class="gen__meta">${meta.join(` <span aria-hidden="true">·</span> `)}</span>`
      : "") +
    `</div>` +
    `<div class="gen__body"><div>` +
    (title ? `<p class="gen__title" id="${titleId}"${lang}>${esc(title)}${flair}</p>` : "") +
    (text
      ? `<p class="gen__text${title ? "" : " gen__text--lead"}${long ? " is-clamped" : ""}" id="${textId}"${lang}>${esc(text)}</p>`
      : "") +
    (long ? moreButton(ctx, textId) : "") +
    `</div></div>` +
    domain +
    renderVerify(ctx, pid, card.verification) +
    cardFoot(
      ctx,
      pid,
      card,
      total,
      statsList(ctx, [
        // Reddit's zero and negative scores mean something: shown, with a real minus sign.
        [
          "score",
          "up",
          ctx.m.score,
          score,
          score !== undefined && score < 0 ? `−${ctx.compact.format(-score)}` : undefined,
        ],
        ["comments", "reply", ctx.m.comments, comments],
      ]),
      ctx.m.goToSource,
      url,
    ) +
    `</div></div></article>`
  );
}

/** Each card by its platform; `mixed`: the feed holds more than one. */
function renderCard(ctx: Ctx, card: TimelineCard, total: number, mixed: boolean): string {
  const { post } = card;
  if (isInstagramPost(post)) return renderIgCard(ctx, { ...card, post }, total, mixed);
  if (isGenericItem(post)) return renderGenericCard(ctx, { ...card, post }, total);
  return renderXCard(ctx, { ...card, post }, total, mixed);
}

const SOURCE_NAMES: Record<string, string> = {
  x: "X",
  instagram: "Instagram",
  reddit: "Reddit",
};

/**
 * A source label ("x", "instagram", "reddit", "custom:<rule>") as the
 * reader knows it: a custom site by its host when one of its items is
 * in the feed, else by the rule's name.
 */
function sourceName(label: string, cards: readonly TimelineCard[]): string {
  const known = SOURCE_NAMES[label];
  if (known) return known;
  const host = customHost(label, cards);
  // Two rules on one site: their hosts would read the same, so each keeps its name.
  const shared = cards.some(
    ({ post }) =>
      isGenericItem(post) &&
      post.sourceLabel !== label &&
      !SOURCE_NAMES[post.sourceLabel] &&
      customHost(post.sourceLabel, cards) === host,
  );
  return host && !shared ? host : label.replace(/^custom:/, "");
}

/** A custom source's host, from its first item in the feed. */
function customHost(label: string, cards: readonly TimelineCard[]): string | undefined {
  const item = cards.find(
    ({ post }) => isGenericItem(post) && post.sourceLabel === label,
  )?.post;
  return item && isGenericItem(item) ? genericHost(item, item.url) : undefined;
}

/** "X, Instagram and Reddit" / "X, Instagram ve Reddit". */
function listNames(ctx: Ctx, names: readonly string[]): string {
  return new Intl.ListFormat(ctx.locale, { type: "conjunction" }).format(names);
}

/** The run's sources: the funnel's split when the doc has one, else the shown cards'. */
function sourceLabels(doc: TimelineDoc, cards: readonly TimelineCard[]): string[] {
  if (doc.bySource) return doc.bySource.map((count) => count.label);
  return [...new Set(cards.map(({ post }) => feedSourceLabel(post)))];
}

/** "Instagram (logged out) and blog": the sources that brought nothing this run. */
function missingNames(ctx: Ctx, doc: TimelineDoc, cards: readonly TimelineCard[]): string {
  return listNames(
    ctx,
    (doc.missingSources ?? []).map(
      ({ label, reason }) =>
        `${sourceName(label, cards)}${reason?.trim() ? ` (${reason.trim()})` : ""}`,
    ),
  );
}

/* ── Done, tally, states ─────────────────────────────────────── */

type TallyRow = [op: string, label: string, hint: string, value: number, mod?: string];

/** Scanned − each bucket = Shown; optional buckets only when non-zero. */
function tallyRows(
  ctx: Ctx,
  f: FunnelCounts,
  timelineSize: number,
  scannedHint: string,
): TallyRow[] {
  const { m } = ctx;
  const rows: (TallyRow | false)[] = [
    ["", m.tallyScanned, scannedHint, f.scanned, "sum"],
    ["−", m.tallyAds, "", f.ads],
    ["−", m.tallyRepeats, m.tallyRepeatsHint, f.duplicates],
    (f.notFollowed ?? 0) > 0 && [
      "−",
      m.tallyNotFollowed,
      m.tallyNotFollowedHint,
      f.notFollowed ?? 0,
    ],
    ["−", m.clickbait, m.tallyClickbaitHint, f.clickbait],
    ["−", m.tallyMediaOnly, m.tallyMediaOnlyHint, f.mediaOnly],
    f.scoringFailed > 0 && ["−", m.tallyUnscored, m.tallyUnscoredHint, f.scoringFailed],
    ["−", m.tallyContradicted, m.tallyContradictedHint, f.contradicted],
    ["−", m.tallyBelowFloor, m.tallyBelowFloorHint, f.belowReadFloor],
    f.rankedOut > 0 && ["−", m.tallyRankedOut, m.tallyRankedOutHint(timelineSize), f.rankedOut],
    ["=", m.tallyShown, "", f.shown, "sum total"],
  ];
  return rows.filter((row): row is TallyRow => row !== false);
}

function renderTally(
  ctx: Ctx,
  f: FunnelCounts,
  timelineSize: number,
  scannedHint: string,
): string {
  const rows = tallyRows(ctx, f, timelineSize, scannedHint).map(
    ([op, label, hint, value, mod = ""]) => {
      const cls = mod
        .split(" ")
        .filter(Boolean)
        .map((m) => ` tally__row--${m}`)
        .join("");
      return (
        `<div class="tally__row${cls}"><dt><span class="tally__op" aria-hidden="true">${op}</span>` +
        `<span>${label}${hint ? `<span class="tally__hint">${esc(hint)}</span>` : ""}</span></dt><dd>${value}</dd></div>`
      );
    },
  );
  return `<dl class="tally" aria-label="${ctx.m.breakdown}">${rows.join("")}</dl>`;
}

function collectButton(ctx: Ctx, primary: boolean): string {
  if (!ctx.actions) return "";
  return primary
    ? `<button class="btn btn--primary" type="button" data-action="collect">${icon("refresh")}${ctx.m.collectNew}</button>`
    : `<button class="btn btn--ghost" type="button" data-action="collect">${ctx.m.collectNew}</button>`;
}

/** "X 150 · Instagram 40 · Reddit 40" under Scanned, when more than one source was scanned. */
function scannedHint(ctx: Ctx, doc: TimelineDoc, cards: readonly TimelineCard[]): string {
  const split = doc.bySource ?? [];
  return split.length > 1
    ? split.map((count) => `${sourceName(count.label, cards)} ${count.in}`).join(" · ")
    : ctx.m.scannedFromHome;
}

function renderDone(
  ctx: Ctx,
  doc: TimelineDoc,
  cards: readonly TimelineCard[],
  shown: number,
): string {
  const lead = shown === 0 ? ctx.m.doneNothing : ctx.m.doneAll(shown);
  const captured = doc.header.capturedAt
    ? ctx.m.lastCollected(esc(ctx.clock.format(new Date(doc.header.capturedAt))))
    : "";
  return (
    `<section class="done" id="done" tabindex="-1" aria-labelledby="done-h">` +
    `<div class="done__icon" aria-hidden="true">${icon("check")}</div><h2 id="done-h">${ctx.m.done}</h2>` +
    `<p class="done__lead">${lead}</p>` +
    (doc.funnel
      ? renderTally(ctx, doc.funnel, doc.header.timelineSize, scannedHint(ctx, doc, cards))
      : "") +
    collectButton(ctx, true) +
    `<p class="done__foot">${captured}${ctx.m.doneFoot}</p></section>`
  );
}

function renderError(
  ctx: Ctx,
  doc: TimelineDoc,
  reason: string,
  detail: string | undefined,
): string {
  const scanned = doc.funnel?.scanned;
  const missing = missingNames(ctx, doc, []);
  const details = [detail, missing && ctx.m.missingSources(missing)].filter(Boolean).join("\n");
  const kept = scanned !== undefined ? ctx.m.keptPosts(scanned) : "";
  const buttons = ctx.actions
    ? `<div class="btn-row"><button class="btn btn--primary" type="button" data-action="retry">${icon("refresh")}${ctx.m.tryAgain}</button>${collectButton(ctx, false)}</div>`
    : "";
  return (
    `<section class="state state--error" role="alert" aria-labelledby="er-h">` +
    `<div class="state__icon" aria-hidden="true">${icon("alert")}</div><h2 id="er-h">${ctx.m.notPrepared}</h2>` +
    `<p>${esc(reason)}${kept}</p>` +
    (details
      ? `<details class="error-detail"><summary>${ctx.m.technicalDetail}</summary><pre>${esc(details)}</pre></details>`
      : "") +
    buttons +
    `</section>`
  );
}

/**
 * Words at 200/min plus a glance per photo, video/GIF and link (X) or
 * image and video (Instagram) the card shows. Generic cards show no media.
 */
function readingMinutes(doc: TimelineDoc, cards: TimelineCard[]): number {
  let seconds = (doc.header.wordCount / 200) * 60;
  for (const { post } of cards) {
    if (isGenericItem(post)) continue;
    for (const m of isInstagramPost(post) ? igShownMedia(post) : post.media) {
      seconds += m.type === "photo" || m.type === "image" ? 8 : m.type === "link" ? 5 : 15;
    }
  }
  return Math.max(1, Math.round(seconds / 60));
}

/* ── Page ────────────────────────────────────────────────────── */

export function renderTimeline(doc: TimelineDoc, opts: RenderOptions = {}): string {
  const lang = opts.lang ?? "en";
  const ctx = makeCtx(doc, lang, opts);
  // The schema already forbids them; a contradicted post never reaches the feed.
  const cards = doc.cards.filter((card) => card.verification?.status !== "false_or_disputed");
  const total = cards.length;
  // Source lines only when the feed mixes platforms; the source list when the run read several.
  const mixed = new Set(cards.map((card) => platformOf(card.post))).size > 1;
  const sources = sourceLabels(doc, cards);
  const sourceList =
    sources.length > 1
      ? ctx.m.sourceList(
          esc(
            listNames(
              ctx,
              sources.map((l) => sourceName(l, cards)),
            ),
          ),
        )
      : "";
  // Some sources brought nothing, the others made the feed: said up front.
  const missing = missingNames(ctx, doc, cards);
  const missingNote = missing
    ? `<p class="short-note">${ctx.m.missingNote(esc(missing))}</p>`
    : "";
  const assets = pageAssets(cards, lang);
  const state = doc.status.state;
  const scanned = doc.funnel?.scanned;

  let meta: string;
  let main: string;
  if (doc.status.state === "error") {
    meta = ctx.m.metaNotPrepared;
    main = renderError(ctx, doc, doc.status.reason, doc.status.detail);
  } else if (total === 0) {
    meta = ctx.m.metaPostsHtml(0) + (scanned !== undefined ? ctx.m.metaScanned(scanned) : "");
    main = missingNote + renderDone(ctx, doc, cards, 0);
  } else {
    meta =
      ctx.m.metaPostsHtml(total) +
      ctx.m.metaReading(readingMinutes(doc, cards)) +
      (scanned !== undefined ? ctx.m.metaPickedFrom(scanned) : "");
    main =
      missingNote +
      (state === "short"
        ? `<p class="short-note">${ctx.m.shortNote(total, doc.header.timelineSize)}</p>`
        : "") +
      `<p class="intro">${ctx.m.intro(sourceList)}</p>` +
      `<div class="feed" role="feed" aria-busy="false" aria-label="${ctx.m.feedLabel(total)}">` +
      cards.map((card, i) => renderCard(ctx, { ...card, rank: i + 1 }, total, mixed)).join("") +
      `</div>` +
      renderDone(ctx, doc, cards, total);
  }

  const title = ctx.m.pageTitle(ctx.title.format(new Date(doc.header.generatedAt)));
  const progress =
    total > 0
      ? `<span class="progress-text" aria-hidden="true"><b id="progress-now">1</b><span id="progress-of"> / ${total}</span></span>`
      : "";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${assets.csp}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · No More Clickbait</title>
<style>${assets.css}</style>
</head>
<body>
<div class="stage"><div class="app">
<header class="topbar"><div class="topbar__row"><div class="topbar__titles">
<div class="topbar__brand">No More Clickbait</div>
<h1>${esc(title)}</h1>
<p class="topbar__meta">${meta}</p>
</div>${progress}<button class="icon-btn" id="theme-btn" type="button" data-mode="system" aria-label="${ctx.m.themeLabel}" title="${ctx.m.themeTitle}">${icon("monitor", "i-monitor")}${icon("sun", "i-sun")}${icon("moon", "i-moon")}</button></div>
<div class="progress" aria-hidden="true"><span id="progress-bar"></span></div>
</header>
<main id="main">${main}</main>
</div></div>
<dialog class="lightbox" id="lightbox" aria-label="${ctx.m.image}">
<div class="lightbox__inner">
<div class="lightbox__top"><span id="lb-count" aria-live="polite"></span><button class="lb-btn" id="lb-close" type="button" aria-label="${ctx.m.close}">${icon("close")}</button></div>
<div class="lightbox__img"><button class="lb-btn lb-prev" id="lb-prev" type="button" aria-label="${ctx.m.previousImage}">${icon("left")}</button><img id="lb-img" alt=""><button class="lb-btn lb-next" id="lb-next" type="button" aria-label="${ctx.m.nextImage}">${icon("right")}</button></div>
<p class="lightbox__cap" id="lb-cap"></p>
</div>
</dialog>
<script>${assets.script}</script>
</body>
</html>
`;
}
