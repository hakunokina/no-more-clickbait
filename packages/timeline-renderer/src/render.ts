import { createHash } from "node:crypto";
import {
  isXCard,
  scoreOutOfTen,
  type FunnelCounts,
  type Post,
  type PostMedia,
  type ScoreLevel,
  type TimelineCard,
  type TimelineDoc,
  type VerificationResult,
  type XTimelineCard,
} from "@nmc/core";
import { TIMELINE_SCRIPT } from "./client-script.js";
import { TIMELINE_CSS } from "./styles.js";

/**
 * TimelineDoc → one self-contained HTML page (the approved mockup,
 * docs/design/timeline-mockup.html, without its developer strip).
 *
 * Feed content is untrusted: every string is HTML-escaped, every URL is
 * parsed and allow-listed (media only from X's CDNs, links https only),
 * the CSP admits nothing but those CDNs and the page's own style/script
 * by hash, and there are no inline handlers or style attributes.
 */

export interface RenderOptions {
  /** IANA time zone for absolute dates (default: the process's). */
  timeZone?: string;
  /**
   * Render the "Yeni akış topla" / "Tekrar dene" buttons
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
const HANDLE = /^[A-Za-z0-9_]{1,50}$/;
const STATUS_ID = /^\d{1,30}$/;
/** X marks text it cannot classify with these; they are not languages. */
const NON_LANGUAGES = new Set(["und", "zxx", "qme", "qam", "qct", "qht", "qst", "art"]);
const LONG_TEXT = 600;

function sha256(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

export const TIMELINE_CSP = [
  "default-src 'none'",
  "img-src https://pbs.twimg.com data:",
  "media-src https://video.twimg.com",
  `style-src ${sha256(TIMELINE_CSS)}`,
  `script-src ${sha256(TIMELINE_SCRIPT)}`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

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
} as const;
type IconName = keyof typeof ICON;

function icon(name: IconName, cls = ""): string {
  return `<svg class="i${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
}

const VERIFIED_BADGE =
  '<svg class="badge-verified" viewBox="0 0 24 24" role="img" aria-label="Onaylı hesap"><title>Onaylı hesap</title>' +
  '<path fill="var(--accent)" d="M12 1.8l2.6 1.9 3.2-.2 1 3 2.6 1.9-1 3 1 3-2.6 1.9-1 3-3.2-.2L12 22.2l-2.6-1.9-3.2.2-1-3-2.6-1.9 1-3-1-3 2.6-1.9 1-3 3.2.2z"/>' +
  '<path d="M8 12.3l2.7 2.7L16.2 9.5" fill="none" stroke="var(--on-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ── Formatting ──────────────────────────────────────────────── */

interface Ctx {
  /** Reference time for relative dates: the capture (else the doc) time. */
  refMs: number;
  abs: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  clock: Intl.DateTimeFormat;
  title: Intl.DateTimeFormat;
  compact: Intl.NumberFormat;
  actions: boolean;
}

function makeCtx(doc: TimelineDoc, opts: RenderOptions): Ctx {
  const tz = opts.timeZone ? { timeZone: opts.timeZone } : {};
  return {
    refMs: Date.parse(doc.header.capturedAt ?? doc.header.generatedAt),
    abs: new Intl.DateTimeFormat("tr-TR", { dateStyle: "long", timeStyle: "short", ...tz }),
    day: new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", ...tz }),
    clock: new Intl.DateTimeFormat("tr-TR", {
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      ...tz,
    }),
    title: new Intl.DateTimeFormat("tr-TR", {
      day: "numeric",
      month: "long",
      weekday: "long",
      ...tz,
    }),
    compact: new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 }),
    actions: opts.actions ?? false,
  };
}

function relTime(ctx: Ctx, iso: string): string {
  const min = Math.max(0, Math.round((ctx.refMs - Date.parse(iso)) / 60e3));
  if (min < 1) return "şimdi";
  if (min < 60) return `${min} dk`;
  if (min < 24 * 60) return `${Math.round(min / 60)} sa`;
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

const LEVEL_WORD: Record<ScoreLevel, string> = {
  "very-low": "Çok düşük",
  low: "Düşük",
  medium: "Orta",
  high: "Yüksek",
  "very-high": "Çok yüksek",
};

/** 0.91 → "9 / 10": the Settings' 0-10 scale, rounded down (scoreOutOfTen). */
function outOfTen(value: number): string {
  return `${scoreOutOfTen(value)} / 10`;
}

function initials(name: string): string {
  return name
    .replace(/^@/, "")
    .split(/[\s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase("tr-TR");
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

/** X serves 48px `_normal` avatars; `_bigger` (73px) keeps 40px sharp on HiDPI. */
function avatarSrc(raw: string | undefined): string | undefined {
  const url = safeUrl(raw, IMAGE_HOSTS);
  if (!url) return undefined;
  url.pathname = url.pathname.replace(/_normal(\.\w+)$/, "_bigger$1");
  return url.href;
}

function avatar(
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
  return `<span class="avatar${size} ${hueClass(handle)}" aria-hidden="true">${esc(initials(name))}</span>`;
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

function renderPhotos(pid: string, photos: PostMedia[]): string {
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
    const name = alt ? ` — büyüt${position}` : `Görsel — büyüt${position}`;
    return (
      `<div class="media__cell${nodims(m)}">` +
      `<button class="media__zoom" type="button"><img src="${esc(src.href)}" alt="${esc(alt)}"${dims(m)} loading="lazy" decoding="async"><span class="sr-only">${name}</span></button>` +
      (alt
        ? `<button class="chip" type="button" aria-expanded="false" aria-controls="${altId}" data-alt>ALT<span class="sr-only"> metnini göster</span></button>` +
          `<p class="alt-pop" id="${altId}" hidden>${esc(alt)}</p>`
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

function renderVideo(m: PostMedia, postUrl: URL | undefined): string {
  const poster = safeUrl(m.url, IMAGE_HOSTS);
  const src = mp4(m);
  const alt = m.altText?.trim() ?? "";
  const length = m.durationMs !== undefined ? duration(m.durationMs) : "";
  const label = `Videoyu oynat${length ? `, süre ${length}` : ""}${alt ? `. ${alt}` : ""}`;
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
    ? `<a class="video__play" href="${esc(postUrl.href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`${label} (X'te, yeni pencerede)`)}">${icon("play")}</a>`
    : "";
  return (
    `<div class="media media--1"><div class="media__cell video${nodims(m)}">` +
    `<img src="${esc(poster.href)}" alt=""${dims(m)} loading="lazy" decoding="async">${open}${chip}` +
    `</div></div>`
  );
}

/** `gid`: unique per GIF of the post, for the still-frame fallback's ids. */
function renderGif(gid: string, m: PostMedia): string {
  const poster = safeUrl(m.url, IMAGE_HOSTS);
  const src = mp4(m);
  const alt = m.altText?.trim() ?? "";
  if (!src) {
    // No playable rendition: its still frame, as a photo.
    return renderPhotos(gid, [{ ...m, type: "photo" }]);
  }
  return (
    `<div class="media media--1"><div class="media__cell gif${nodims(m)}" data-playing="false">` +
    `<video${dims(m)} preload="none" muted loop playsinline${poster ? ` poster="${esc(poster.href)}"` : ""} aria-label="${esc(alt ? `GIF: ${alt}` : "GIF")}">` +
    `<source src="${esc(src.href)}" type="video/mp4"></video>` +
    `<span class="chip" aria-hidden="true">GIF</span>` +
    `<button class="gif__toggle" type="button" aria-pressed="false" aria-label="GIF'i oynat">${icon("play", "i-play")}${icon("pause", "i-pause")}</button>` +
    `</div></div>`
  );
}

/** Photos as one grid (≤ 4), then each video/GIF full width, in post order. */
function renderMedia(pid: string, media: PostMedia[], postUrl: URL | undefined): string {
  const photos = media.filter((m) => m.type === "photo");
  let out = renderPhotos(pid, photos);
  let gifs = 0;
  for (const m of media) {
    if (m.type === "video") out += renderVideo(m, postUrl);
    if (m.type === "gif") out += renderGif(`${pid}-gif${++gifs}`, m);
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
    `<span class="sr-only">Alıntılanan gönderi: </span>` +
    `<span class="quote__head"><span class="quote__arrow" aria-hidden="true">↳</span>${avatar(quoted.authorHandle, name, undefined, true)}` +
    `<strong>${esc(name)}</strong>${quoted.authorVerified ? VERIFIED_BADGE : ""}<span class="post__handle">@${esc(quoted.authorHandle)}</span>` +
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
  verified: {
    cls: "ok",
    icon: "check",
    label: "Doğrulandı",
    lead: "Bulunan kaynaklar bu iddiayı destekliyor.",
  },
  unverifiable: {
    cls: "info",
    icon: "question",
    label: "Doğrulanamadı",
    lead: "İddiayı destekleyen ya da çürüten güvenilir bir kaynak bulunamadı. Bu, iddianın yanlış olduğu anlamına gelmez.",
  },
} as const satisfies Record<
  string,
  { cls: string; icon: IconName; label: string; lead: string }
>;

function renderVerify(pid: string, v: VerificationResult | null): string {
  if (!v || v.status === "false_or_disputed") return "";
  const d = VERDICT[v.status];
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
    `${icon(d.icon)}<span class="verify__label">${d.label}</span>` +
    `<span class="verify__claim"><span class="sr-only">İddia: </span>${esc(v.claim)}</span>${icon("chevron", "verify__chev")}</button>` +
    `<div class="verify__panel" id="${panelId}" hidden>` +
    `<p class="verify__claimfull">“${esc(v.claim)}”</p><p>${d.lead}</p>` +
    (v.summary.trim() ? `<p>${esc(v.summary)}</p>` : "") +
    (sources
      ? `<p><strong>Kaynaklar</strong></p><ul class="verify__sources">${sources}</ul>`
      : "") +
    `<p class="verify__meta">${v.failed ? "Kontrol tamamlanamadı (Claude yanıtı alınamadı)." : "Claude ile web araması üzerinden kontrol edildi."}</p>` +
    `</div></div>`
  );
}

function renderWhy(pid: string, card: TimelineCard, total: number): string {
  const { score, levels } = card;
  return (
    `<div class="why" id="${pid}-why" hidden>` +
    (score.reason?.trim() ? `<p>${esc(score.reason)}</p>` : "") +
    `<dl><dt>Okuma değeri</dt><dd>${LEVEL_WORD[levels.readValue]} <small>(${outOfTen(score.readWorthinessScore)})</small></dd>` +
    `<dt>Clickbait</dt><dd>${LEVEL_WORD[levels.clickbait]} <small>(${outOfTen(score.clickbaitScore)})</small></dd>` +
    `<dt>Sıra</dt><dd>${card.rank} / ${total}</dd></dl></div>`
  );
}

function renderStats(ctx: Ctx, metrics: Post["metrics"]): string {
  const m = metrics ?? {};
  const stat = (value: number | undefined, key: string, ic: IconName, label: string) =>
    value === undefined
      ? ""
      : `<li data-k="${key}" title="${label}">${icon(ic)}<span class="sr-only">${label}: </span>${esc(ctx.compact.format(value))}</li>`;
  return (
    `<ul class="stats" aria-label="Etkileşimler">` +
    stat(m.replies, "replies", "reply", "Yanıt") +
    stat(m.reposts, "reposts", "repost", "Yeniden paylaşım") +
    stat(m.likes, "likes", "like", "Beğeni") +
    stat(m.views, "views", "views", "Görüntülenme") +
    `</ul>`
  );
}

function renderCard(ctx: Ctx, card: XTimelineCard, total: number): string {
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
    (post.repostedBy
      ? `<div class="post__repost">${icon("repost")}<span>@${esc(post.repostedBy)} yeniden paylaştı</span></div>`
      : "") +
    `<div class="post__grid">${avatar(post.authorHandle, name, post.authorAvatarUrl)}<div class="post__main">` +
    `<div class="post__head">` +
    (profile
      ? `<a class="post__name" id="${pid}-name" href="${esc(profile)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`
      : `<span class="post__name" id="${pid}-name">${esc(name)}</span>`) +
    (post.authorVerified ? VERIFIED_BADGE : "") +
    `<span class="post__handle">@${esc(post.authorHandle)}</span><span class="post__dot" aria-hidden="true">·</span>${timeTag(ctx, post.publishedAt)}` +
    `</div>` +
    (text
      ? `<p class="post__text${long ? " is-clamped" : ""}" id="${pid}-text"${langAttr(post.lang)}>${linkify(text)}</p>`
      : "") +
    (long
      ? `<button class="link-btn" type="button" data-more aria-expanded="false" aria-controls="${pid}-text">Devamını oku</button>`
      : "") +
    renderMedia(pid, post.media, postUrl) +
    (post.quoted ? renderQuote(ctx, post.quoted) : "") +
    links +
    renderVerify(pid, card.verification) +
    `<div class="post__foot">${renderStats(ctx, post.metrics)}<div class="post__actions">` +
    `<button class="link-btn why-btn" type="button" aria-expanded="false" aria-controls="${pid}-why">Neden burada?</button>` +
    (postUrl
      ? `<a class="open-x" href="${esc(postUrl.href)}" target="_blank" rel="noopener noreferrer">X'te aç${icon("external")}<span class="sr-only"> (yeni pencerede)</span></a>`
      : "") +
    `</div></div>` +
    renderWhy(pid, card, total) +
    `</div></div></article>`
  );
}

/* ── Done, tally, states ─────────────────────────────────────── */

type TallyRow = [op: string, label: string, hint: string, value: number, mod?: string];

/** Taranan − each bucket = Gösterilen; optional buckets only when non-zero. */
function tallyRows(f: FunnelCounts, timelineSize: number): TallyRow[] {
  const rows: (TallyRow | false)[] = [
    ["", "Taranan", "Ana akıştan toplanan gönderi", f.scanned, "sum"],
    ["−", "Reklam", "", f.ads],
    ["−", "Tekrar", "Aynı gönderi ya da yeniden paylaşımı", f.duplicates],
    ["−", "Clickbait", "Tık tuzağı olarak elenen", f.clickbait],
    ["−", "Yargılanamayan medya", "Metni yok, yalnız görsel/video", f.mediaOnly],
    f.scoringFailed > 0 && [
      "−",
      "Puanlanamayan",
      "Claude bu gönderiler için puan döndürmedi",
      f.scoringFailed,
    ],
    ["−", "Kaynaklarla çelişen", "Doğrulamada kaynaklar iddiayla çelişti", f.contradicted],
    ["−", "Eşik altı", "Okumaya yeterince değer bulunmadı", f.belowReadFloor],
    f.rankedOut > 0 && [
      "−",
      "Sıraya giremeyen",
      `Eşiği geçti, ilk ${timelineSize} gönderiye giremedi`,
      f.rankedOut,
    ],
    ["=", "Gösterilen", "", f.shown, "sum total"],
  ];
  return rows.filter((row): row is TallyRow => row !== false);
}

function renderTally(f: FunnelCounts, timelineSize: number): string {
  const rows = tallyRows(f, timelineSize).map(([op, label, hint, value, mod = ""]) => {
    const cls = mod
      .split(" ")
      .filter(Boolean)
      .map((m) => ` tally__row--${m}`)
      .join("");
    return (
      `<div class="tally__row${cls}"><dt><span class="tally__op" aria-hidden="true">${op}</span>` +
      `<span>${label}${hint ? `<span class="tally__hint">${esc(hint)}</span>` : ""}</span></dt><dd>${value}</dd></div>`
    );
  });
  return `<dl class="tally" aria-label="Döküm">${rows.join("")}</dl>`;
}

function collectButton(ctx: Ctx, primary: boolean): string {
  if (!ctx.actions) return "";
  return primary
    ? `<button class="btn btn--primary" type="button" data-action="collect">${icon("refresh")}Yeni akış topla</button>`
    : `<button class="btn btn--ghost" type="button" data-action="collect">Yeni akış topla</button>`;
}

function renderDone(ctx: Ctx, doc: TimelineDoc, shown: number): string {
  const lead =
    shown === 0
      ? "Bugün okumaya değer bir gönderi çıkmadı. Bu da bir sonuç."
      : `Bugünlük bu kadar — ${shown} gönderinin hepsini gördün.`;
  const captured = doc.header.capturedAt
    ? `Son toplama: ${esc(ctx.clock.format(new Date(doc.header.capturedAt)))} · `
    : "";
  return (
    `<section class="done" id="done" tabindex="-1" aria-labelledby="done-h">` +
    `<div class="done__icon" aria-hidden="true">${icon("check")}</div><h2 id="done-h">Bitti</h2>` +
    `<p class="done__lead">${lead}</p>` +
    (doc.funnel ? renderTally(doc.funnel, doc.header.timelineSize) : "") +
    collectButton(ctx, true) +
    `<p class="done__foot">${captured}Yeni akış yalnız sen isteyince hazırlanır.</p></section>`
  );
}

function renderError(
  ctx: Ctx,
  doc: TimelineDoc,
  reason: string,
  detail: string | undefined,
): string {
  const scanned = doc.funnel?.scanned;
  const kept =
    scanned !== undefined
      ? ` Toplanan ${scanned} gönderi duruyor; yeniden denemek için yeniden toplamak gerekmez.`
      : "";
  const buttons = ctx.actions
    ? `<div class="btn-row"><button class="btn btn--primary" type="button" data-action="retry">${icon("refresh")}Tekrar dene</button>${collectButton(ctx, false)}</div>`
    : "";
  return (
    `<section class="state state--error" role="alert" aria-labelledby="er-h">` +
    `<div class="state__icon" aria-hidden="true">${icon("alert")}</div><h2 id="er-h">Akış hazırlanamadı</h2>` +
    `<p>${esc(reason)}${kept}</p>` +
    (detail
      ? `<details class="error-detail"><summary>Teknik ayrıntı</summary><pre>${esc(detail)}</pre></details>`
      : "") +
    buttons +
    `</section>`
  );
}

/** Words at 200/min plus a glance per photo, video/GIF and link. */
function readingMinutes(doc: TimelineDoc, cards: XTimelineCard[]): number {
  let seconds = (doc.header.wordCount / 200) * 60;
  for (const { post } of cards) {
    for (const m of post.media) seconds += m.type === "photo" ? 8 : m.type === "link" ? 5 : 15;
  }
  return Math.max(1, Math.round(seconds / 60));
}

/* ── Page ────────────────────────────────────────────────────── */

export function renderTimeline(doc: TimelineDoc, opts: RenderOptions = {}): string {
  const ctx = makeCtx(doc, opts);
  // The schema already forbids them; a contradicted post never reaches the feed.
  // X cards only: Instagram and generic cards get their own renderers.
  const cards = doc.cards.filter(
    (card): card is XTimelineCard =>
      card.verification?.status !== "false_or_disputed" && isXCard(card),
  );
  const total = cards.length;
  const state = doc.status.state;
  const scanned = doc.funnel?.scanned;

  let meta: string;
  let main: string;
  if (doc.status.state === "error") {
    meta = "Hazırlanamadı";
    main = renderError(ctx, doc, doc.status.reason, doc.status.detail);
  } else if (total === 0) {
    meta = `<b>0 gönderi</b>${scanned !== undefined ? ` · ${scanned} gönderi tarandı` : ""}`;
    main = renderDone(ctx, doc, 0);
  } else {
    meta =
      `<b>${total} gönderi</b> · ≈ ${readingMinutes(doc, cards)} dk okuma` +
      (scanned !== undefined ? ` · ${scanned} gönderiden seçildi` : "");
    main =
      (state === "short"
        ? `<p class="short-note">Bugün yalnız ${total} gönderi eşiği geçti (hedef ${doc.header.timelineSize}). Akış kısa bitiyor; doldurmak için eşik düşürülmedi.</p>`
        : "") +
      `<p class="intro">Okuma değerine göre sıralı — en değerli üstte. Reklam, tekrar ve clickbait çıkarıldı.</p>` +
      `<div class="feed" role="feed" aria-busy="false" aria-label="Akış, ${total} gönderi">` +
      cards.map((card, i) => renderCard(ctx, { ...card, rank: i + 1 }, total)).join("") +
      `</div>` +
      renderDone(ctx, doc, total);
  }

  const title = `${ctx.title.format(new Date(doc.header.generatedAt))} akışı`;
  const progress =
    total > 0
      ? `<span class="progress-text" aria-hidden="true"><b id="progress-now">1</b><span id="progress-of"> / ${total}</span></span>`
      : "";
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${TIMELINE_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · No More Clickbait</title>
<style>${TIMELINE_CSS}</style>
</head>
<body>
<div class="stage"><div class="app">
<header class="topbar"><div class="topbar__row"><div class="topbar__titles">
<div class="topbar__brand">No More Clickbait</div>
<h1>${esc(title)}</h1>
<p class="topbar__meta">${meta}</p>
</div>${progress}<button class="icon-btn" id="theme-btn" type="button" data-mode="system" aria-label="Tema: Sistem. Değiştir: Açık" title="Tema: Sistem">${icon("monitor", "i-monitor")}${icon("sun", "i-sun")}${icon("moon", "i-moon")}</button></div>
<div class="progress" aria-hidden="true"><span id="progress-bar"></span></div>
</header>
<main id="main">${main}</main>
</div></div>
<dialog class="lightbox" id="lightbox" aria-label="Görsel">
<div class="lightbox__inner">
<div class="lightbox__top"><span id="lb-count" aria-live="polite"></span><button class="lb-btn" id="lb-close" type="button" aria-label="Kapat">${icon("close")}</button></div>
<div class="lightbox__img"><button class="lb-btn lb-prev" id="lb-prev" type="button" aria-label="Önceki görsel">${icon("left")}</button><img id="lb-img" alt=""><button class="lb-btn lb-next" id="lb-next" type="button" aria-label="Sonraki görsel">${icon("right")}</button></div>
<p class="lightbox__cap" id="lb-cap"></p>
</div>
</dialog>
<script>${TIMELINE_SCRIPT}</script>
</body>
</html>
`;
}
