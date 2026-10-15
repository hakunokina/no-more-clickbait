/**
 * The page's only stylesheet (from the approved mockup,
 * docs/design/timeline-mockup.html). Static: no feed data is ever
 * interpolated, so its CSP hash is fixed.
 */
export const TIMELINE_CSS = `
/* Tokens */
:root {
  color-scheme: light;
  --bg: #ffffff;
  --surface: #f5f7f8;
  --surface-2: #eceff1;
  --text: #0f1419;
  --muted: #536471;
  --border: #d5dde2;
  --accent: #0b57d0;
  --on-accent: #ffffff;
  --focus: #0b57d0;
  --media-bg: #e3e8eb;
  --ok: #176934;      --ok-bg: #e7f4eb;
  --warn: #8a4b00;    --warn-bg: #fdf1e0;
  --info: #3f4f5e;    --info-bg: #edf1f4;

  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
  --r-media: 16px; --r-pill: 999px; --r-box: 12px;
  --col: 640px;
  --avatar: 40px;
  --pad-x: var(--s4);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --fs-body: .9375rem;
  --fs-meta: .875rem;
  --fs-small: .8125rem;
  --lh-body: 1.45;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0e1116; --surface: #161b22; --surface-2: #1e252e; --text: #e7e9ea; --muted: #9aa5b1;
  --border: #2f3640; --accent: #8ab4f8; --on-accent: #0e1116; --focus: #8ab4f8; --media-bg: #1b2129;
  --ok: #72d39c; --ok-bg: #12261b; --warn: #f2b45a; --warn-bg: #2b1f0d; --info: #b8c3ce; --info-bg: #1e252e;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0e1116; --surface: #161b22; --surface-2: #1e252e; --text: #e7e9ea; --muted: #9aa5b1;
    --border: #2f3640; --accent: #8ab4f8; --on-accent: #0e1116; --focus: #8ab4f8; --media-bg: #1b2129;
    --ok: #72d39c; --ok-bg: #12261b; --warn: #f2b45a; --warn-bg: #2b1f0d; --info: #b8c3ce; --info-bg: #1e252e;
  }
}

/* Base */
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { animation: none !important; transition: none !important; } }
body { margin: 0; background: var(--bg); color: var(--text); font: var(--fs-body)/var(--lh-body) var(--font); }
a { color: var(--accent); }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
svg.i { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
[hidden] { display: none !important; }

/* Shell */
.stage { display: flex; justify-content: center; }
.app {
  container: app / inline-size;
  width: 100%; max-width: var(--col); min-height: 100vh;
  border-inline: 1px solid var(--border); background: var(--bg);
}

/* Header */
.topbar {
  position: sticky; top: 0; z-index: 5;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.topbar__row { display: flex; align-items: center; gap: var(--s3); padding: var(--s3) var(--pad-x); }
.topbar__titles { flex: 1; min-width: 0; }
.topbar__brand { font-size: var(--fs-small); color: var(--muted); font-weight: 600; letter-spacing: .02em; }
.topbar h1 { font-size: 1.125rem; line-height: 1.3; margin: 0; }
.topbar__meta { margin: 2px 0 0; color: var(--muted); font-size: var(--fs-meta); }
.topbar__meta b { color: var(--text); font-weight: 600; }
.progress-text { font-variant-numeric: tabular-nums; font-size: var(--fs-meta); color: var(--muted); white-space: nowrap; }
.progress-text b { color: var(--text); }
.icon-btn {
  display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: var(--r-pill);
  border: 1px solid var(--border); background: var(--bg); cursor: pointer; flex: none;
}
.icon-btn:hover { background: var(--surface); }
.icon-btn svg { display: none; }
.icon-btn[data-mode="system"] .i-monitor, .icon-btn[data-mode="light"] .i-sun, .icon-btn[data-mode="dark"] .i-moon { display: block; }
.progress { height: 3px; background: transparent; }
.progress span { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s ease; }

.intro { margin: 0; padding: var(--s3) var(--pad-x); color: var(--muted); font-size: var(--fs-meta); border-bottom: 1px solid var(--border); }

/* Post card */
.feed { margin: 0; padding: 0; }
.post { padding: var(--s3) var(--pad-x); border-bottom: 1px solid var(--border); scroll-margin-top: 96px; }
.post:focus-visible { outline-offset: -3px; border-radius: 0; }
.post__repost { display: flex; align-items: center; gap: var(--s2); margin: 0 0 var(--s1) calc(var(--avatar) - 18px); color: var(--muted); font-size: var(--fs-small); font-weight: 600; }
.post__repost svg.i { width: 16px; height: 16px; }
.post__grid { display: grid; grid-template-columns: var(--avatar) minmax(0, 1fr); gap: var(--s3); }
.avatar {
  width: var(--avatar); height: var(--avatar); border-radius: 50%; display: grid; place-items: center;
  color: #fff; font-weight: 700; font-size: .875rem; user-select: none; background: var(--surface-2); object-fit: cover;
}
.avatar--sm { width: 20px; height: 20px; font-size: .5625rem; }
.avatar--h0 { background: hsl(210 45% 36%); } .avatar--h1 { background: hsl(25 45% 36%); }
.avatar--h2 { background: hsl(300 45% 36%); } .avatar--h3 { background: hsl(160 45% 30%); }
.avatar--h4 { background: hsl(0 45% 40%); }   .avatar--h5 { background: hsl(240 45% 40%); }
.avatar--h6 { background: hsl(90 45% 28%); }  .avatar--h7 { background: hsl(330 45% 38%); }
.post__head { display: flex; align-items: center; flex-wrap: wrap; gap: 0 var(--s1); font-size: var(--fs-body); line-height: 1.3; }
.post__name { color: var(--text); font-weight: 700; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
a.post__name:hover { text-decoration: underline; }
.badge-verified { width: 18px; height: 18px; flex: none; }
.post__handle, .post__time, .post__dot { color: var(--muted); font-size: var(--fs-meta); }
.post__handle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.post__text { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.post__text.is-clamped { display: -webkit-box; -webkit-line-clamp: 10; -webkit-box-orient: vertical; overflow: hidden; }
.link-btn { border: 0; background: none; padding: 4px 0; min-height: 28px; color: var(--accent); cursor: pointer; font-size: var(--fs-meta); }
.link-btn:hover { text-decoration: underline; }

/* Media */
.media {
  margin-top: var(--s3); border: 1px solid var(--border); border-radius: var(--r-media); overflow: hidden;
  display: grid; gap: 2px; background: var(--border);
}
.media__cell { position: relative; background: var(--media-bg); min-height: 0; }
.media__zoom { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: none; cursor: zoom-in; }
.media__zoom:focus-visible { outline-offset: -3px; }
.media img { display: block; width: 100%; }
.media--1 img { height: auto; max-height: min(80vh, 720px); object-fit: contain; }
.media--1 .media__cell--nodims img { aspect-ratio: 16 / 9; }
.media--2, .media--3, .media--4 { aspect-ratio: 16 / 9; grid-template-columns: 1fr 1fr; }
.media--3, .media--4 { grid-template-rows: 1fr 1fr; }
.media--3 .media__cell:first-child { grid-row: span 2; }
.media--2 img, .media--3 img, .media--4 img { height: 100%; object-fit: cover; }
.chip {
  position: absolute; left: var(--s2); bottom: var(--s2);
  background: rgb(0 0 0 / .72); color: #fff; border: 0; border-radius: 4px;
  font-size: .75rem; font-weight: 700; line-height: 1; padding: 4px 6px; letter-spacing: .03em;
}
button.chip { cursor: pointer; min-height: 24px; }
.alt-pop {
  position: absolute; left: var(--s2); right: var(--s2); bottom: 40px; margin: 0;
  background: rgb(0 0 0 / .85); color: #fff; padding: var(--s2) var(--s3); border-radius: 8px; font-size: var(--fs-small);
}

/* Video / GIF */
.video, .gif { position: relative; background: #000; }
.video video, .gif video, .video img { display: block; width: 100%; height: auto; max-height: min(80vh, 720px); object-fit: contain; background: #000; }
.media__cell--nodims video, .media__cell--nodims.video img { aspect-ratio: 16 / 9; }
.video__play {
  position: absolute; inset: 0; margin: auto; width: 64px; height: 64px; border-radius: 50%;
  border: 3px solid #fff; background: rgb(15 20 25 / .75); color: #fff; display: grid; place-items: center; cursor: pointer;
}
.video__play svg.i { width: 28px; height: 28px; fill: #fff; stroke: none; margin-left: 4px; }
.video[data-state="playing"] .video__play, .video[data-state="playing"] .chip--dur { display: none; }
.video__play:focus-visible, .gif__toggle:focus-visible { outline-color: #fff; }
.gif__toggle {
  position: absolute; right: var(--s2); bottom: var(--s2); width: 32px; height: 32px; border-radius: 50%;
  border: 0; background: rgb(0 0 0 / .72); color: #fff; display: grid; place-items: center; cursor: pointer;
}
.gif__toggle svg.i { width: 16px; height: 16px; }
.gif__toggle .i-pause, .gif__toggle[aria-pressed="true"] .i-play { display: none; }
.gif__toggle[aria-pressed="true"] .i-pause { display: block; }

/* Quote and link card */
.quote, .linkcard {
  display: block; margin-top: var(--s3); border: 1px solid var(--border); border-radius: var(--r-media);
  color: var(--text); text-decoration: none; overflow: hidden;
}
.quote { padding: var(--s3); }
a.quote:hover, a.linkcard:hover { background: var(--surface); }
.quote__head { display: flex; align-items: center; gap: var(--s1); font-size: var(--fs-meta); flex-wrap: wrap; }
.quote__arrow { color: var(--muted); font-weight: 700; }
.quote__head .post__handle, .quote__head .post__time { font-size: var(--fs-meta); }
.quote__text { margin: var(--s1) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
.quote__media { display: block; position: relative; margin-top: var(--s2); border-radius: var(--r-box); overflow: hidden; background: var(--media-bg); }
.quote__media img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
.linkcard img { display: block; width: 100%; aspect-ratio: 1.91 / 1; object-fit: cover; background: var(--media-bg); border-bottom: 1px solid var(--border); }
.linkcard__body { display: grid; gap: 2px; padding: var(--s3); }
.linkcard__domain { color: var(--muted); font-size: var(--fs-small); }
.linkcard__title { font-weight: 600; }
.linkcard__desc { color: var(--muted); font-size: var(--fs-meta); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.linkcard--plain .linkcard__body { padding: var(--s2) var(--s3); }
.linkcard__url { color: var(--accent); font-size: var(--fs-meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Verification band */
.verify { margin-top: var(--s3); border-radius: var(--r-box); background: var(--v-bg); color: var(--v-fg); }
.verify--ok   { --v-bg: var(--ok-bg);   --v-fg: var(--ok); }
.verify--info { --v-bg: var(--info-bg); --v-fg: var(--info); }
.verify__toggle {
  width: 100%; display: flex; align-items: center; gap: var(--s2); text-align: left;
  border: 0; background: none; color: inherit; padding: var(--s2) var(--s3); min-height: 40px; cursor: pointer; border-radius: var(--r-box);
}
.verify__label { font-weight: 700; white-space: nowrap; font-size: var(--fs-meta); }
.verify__claim { flex: 1; min-width: 0; color: var(--text); font-size: var(--fs-meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.verify__chev { transition: transform .15s ease; }
.verify__toggle[aria-expanded="true"] .verify__chev { transform: rotate(180deg); }
.verify__panel { padding: 0 var(--s3) var(--s3) calc(var(--s3) + 18px + var(--s2)); color: var(--text); font-size: var(--fs-meta); overflow-wrap: anywhere; }
.verify__panel p { margin: 0 0 var(--s2); }
.verify__claimfull { font-style: italic; }
.verify__sources { margin: 0 0 var(--s2); padding-left: 1.1em; }
.verify__sources li { margin-bottom: 2px; }
.verify__sources small { color: var(--muted); }
.verify__meta { color: var(--muted); font-size: var(--fs-small); margin: 0 !important; }

/* Footer */
.post__foot { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s1) var(--s4); margin-top: var(--s2); }
.stats { list-style: none; margin: 0; padding: 0; display: flex; gap: var(--s4); flex: 1; color: var(--muted); font-size: var(--fs-small); font-variant-numeric: tabular-nums; }
.stats li { display: inline-flex; align-items: center; gap: var(--s1); }
.stats svg.i { width: 16px; height: 16px; }
.post__actions { display: flex; align-items: center; gap: var(--s4); margin-left: auto; }
.why-btn { color: var(--muted); }
.open-x { display: inline-flex; align-items: center; gap: var(--s1); font-size: var(--fs-meta); font-weight: 600; text-decoration: none; min-height: 28px; }
.open-x:hover { text-decoration: underline; }
.open-x svg.i { width: 15px; height: 15px; }
.why { margin-top: var(--s2); padding: var(--s3); border-radius: var(--r-box); background: var(--surface); font-size: var(--fs-meta); }
.why p { margin: 0 0 var(--s2); }
.why dl { display: grid; grid-template-columns: auto 1fr; gap: 2px var(--s3); margin: 0; }
.why dt { color: var(--muted); }
.why dd { margin: 0; }
.why dd small { color: var(--muted); font-variant-numeric: tabular-nums; }

/* Done */
.done { padding: var(--s7) var(--pad-x) var(--s7); text-align: center; }
.done:focus { outline: none; }
.done__icon { width: 56px; height: 56px; border-radius: 50%; margin: 0 auto var(--s3); display: grid; place-items: center; background: var(--ok-bg); color: var(--ok); }
.done__icon svg.i { width: 30px; height: 30px; stroke-width: 2.5; }
.done h2 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 var(--s1); }
.done__lead { margin: 0 0 var(--s5); color: var(--muted); }
.tally { max-width: 360px; margin: 0 auto var(--s5); text-align: left; border: 1px solid var(--border); border-radius: var(--r-box); padding: var(--s2) var(--s4); }
.tally__row { display: grid; grid-template-columns: 1fr auto; gap: var(--s2); padding: 6px 0; align-items: baseline; }
.tally__row + .tally__row { border-top: 1px solid var(--border); }
.tally dt { display: grid; grid-template-columns: 1.2em 1fr; gap: var(--s2); }
.tally__op { color: var(--muted); text-align: center; }
.tally__hint { display: block; color: var(--muted); font-size: var(--fs-small); }
.tally dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
.tally__row--sum dt, .tally__row--sum dd { font-weight: 700; }
.tally__row--total { border-top: 2px solid var(--text) !important; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--s2);
  min-height: 44px; padding: 0 var(--s5); border-radius: var(--r-pill); border: 1px solid transparent; font-weight: 700; cursor: pointer;
}
.btn--primary { background: var(--text); color: var(--bg); }
.btn--primary:hover { opacity: .9; }
.btn--ghost { background: transparent; border-color: var(--border); color: var(--text); }
.done__foot { margin: var(--s3) 0 0; color: var(--muted); font-size: var(--fs-small); }

/* Error */
.state { padding: var(--s7) var(--pad-x); text-align: center; }
.state h2 { font-size: 1.25rem; margin: 0 0 var(--s2); }
.state p { color: var(--muted); margin: 0 0 var(--s4); }
.state__icon { width: 56px; height: 56px; border-radius: 50%; margin: 0 auto var(--s3); display: grid; place-items: center; background: var(--warn-bg); color: var(--warn); }
.state__icon svg.i { width: 28px; height: 28px; }
.error-detail { max-width: 420px; margin: 0 auto var(--s4); text-align: left; font-size: var(--fs-small); }
.error-detail summary { cursor: pointer; color: var(--muted); }
.error-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface); padding: var(--s2) var(--s3); border-radius: 8px; color: var(--text); }
.btn-row { display: flex; gap: var(--s2); justify-content: center; flex-wrap: wrap; }
.short-note { margin: 0; padding: var(--s3) var(--pad-x); background: var(--info-bg); color: var(--info); font-size: var(--fs-meta); border-bottom: 1px solid var(--border); }

/* Lightbox */
.lightbox { border: 0; padding: 0; max-width: none; max-height: none; width: 100vw; height: 100vh; background: rgb(0 0 0 / .92); color: #fff; }
.lightbox::backdrop { background: rgb(0 0 0 / .6); }
.lightbox__inner { height: 100%; display: grid; grid-template-rows: auto 1fr auto; }
.lightbox__top { display: flex; justify-content: space-between; align-items: center; padding: var(--s3) var(--s4); }
.lightbox__img { min-height: 0; display: grid; place-items: center; padding: 0 var(--s7); position: relative; }
.lightbox__img img { max-width: 100%; max-height: 100%; object-fit: contain; }
.lightbox__cap { padding: var(--s3) var(--s4) var(--s4); max-width: 720px; margin: 0 auto; font-size: var(--fs-meta); color: #d9dee2; }
.lb-btn { width: 40px; height: 40px; border-radius: 50%; border: 0; background: rgb(255 255 255 / .14); color: #fff; display: grid; place-items: center; cursor: pointer; }
.lb-btn:hover { background: rgb(255 255 255 / .24); }
.lb-btn:focus-visible { outline-color: #fff; }
.lb-prev, .lb-next { position: absolute; top: 50%; transform: translateY(-50%); }
.lb-prev { left: var(--s2); } .lb-next { right: var(--s2); }

/* Narrow column (mobile 360-414) */
@container app (max-width: 480px) {
  .topbar__row, .post, .intro, .short-note { padding-inline: var(--s3); }
  .topbar h1 { font-size: 1rem; }
  .post__grid { gap: var(--s2); }
  .media, .quote, .linkcard { border-radius: var(--r-box); }
  .stats { gap: var(--s3); }
  .post__foot { gap: var(--s1) var(--s3); }
  .done h2 { font-size: 1.5rem; }
  .tally { padding-inline: var(--s3); }
}
@container app (max-width: 380px) {
  .stats li[data-k="views"] { display: none; }
}
`;

/**
 * Added only to a page that holds Instagram or generic cards
 * (docs/design/timeline-cards-mockup.html), so an X-only page stays
 * byte for byte what it was. Static, like TIMELINE_CSS.
 */
export const CARDS_CSS = `
/* Cards: tokens */
:root { --fs-title: 1.0625rem; --reel-h: min(80vh, 640px); }

/* Source line (mixed feed only, X and Instagram cards) */
.src {
  display: flex; align-items: center; gap: var(--s2); margin: 0 0 var(--s1) calc(var(--avatar) - 16px);
  color: var(--muted); font-size: var(--fs-small); font-weight: 600; min-width: 0;
}
.src svg.i { width: 16px; height: 16px; }
.src__sep { font-weight: 400; }
.src__mark {
  width: 16px; height: 16px; border-radius: 4px; flex: none; display: grid; place-items: center;
  background: var(--muted); color: var(--bg); font-size: .625rem; font-weight: 800; line-height: 1;
}
.src__mark svg.i { width: 12px; height: 12px; stroke-width: 2.4; }
.src__repost { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }

/* Instagram card */
.ig__head { display: grid; grid-template-columns: var(--avatar) minmax(0, 1fr); gap: var(--s3); align-items: center; }
.ig__who { min-width: 0; }
.ig__line { display: flex; align-items: center; gap: 0 var(--s1); min-width: 0; line-height: 1.3; }
.ig__handle { color: var(--text); font-weight: 700; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
a.ig__handle:hover { text-decoration: underline; }
.ig__media { display: block; position: relative; margin-top: var(--s3); border: 1px solid var(--border); border-radius: var(--r-media); overflow: hidden; background: var(--media-bg); }
.ig__frame { position: relative; width: 100%; max-height: min(80vh, 720px); overflow: hidden; }
.ig__ratio { display: block; width: 100%; height: auto; }
.ig__frame .media__zoom { position: absolute; inset: 0; }
.ig__frame img { display: block; width: 100%; height: 100%; object-fit: contain; }
.ig__fallback { display: none; position: absolute; inset: 0; margin: 0; padding: var(--s4); place-items: center; text-align: center; color: var(--muted); font-size: var(--fs-meta); background: var(--media-bg); pointer-events: none; }
.ig__frame[data-broken] .ig__fallback { display: grid; }
.ig__frame[data-broken] img, .ig__frame[data-broken] .chip { visibility: hidden; }

/* Carousel: scrolling track + arrow buttons + counter chip + dots */
.car__track { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; overscroll-behavior-x: contain; }
.car__track::-webkit-scrollbar { display: none; }
.car__slide { flex: 0 0 100%; scroll-snap-align: start; position: relative; }
.car__count {
  position: absolute; top: var(--s2); right: var(--s2); z-index: 1; background: rgb(0 0 0 / .72); color: #fff;
  border-radius: var(--r-pill); font-size: .75rem; font-weight: 700; padding: 4px 8px; font-variant-numeric: tabular-nums;
}
.car__btn {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 1; width: 32px; height: 32px; border-radius: 50%;
  border: 0; background: rgb(255 255 255 / .92); color: #0f1419; display: grid; place-items: center; cursor: pointer;
  box-shadow: 0 1px 4px rgb(0 0 0 / .3);
}
.car__btn svg.i { width: 18px; height: 18px; stroke-width: 2.5; }
.car__btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; box-shadow: 0 0 0 2px #fff; }
.car__prev { left: var(--s2); } .car__next { right: var(--s2); }
.car__dots { display: flex; justify-content: center; gap: 4px; padding: var(--s2) 0 0; }
.car__dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--border); }
.car__dots i[data-on] { background: var(--accent); }

/* Reel: vertical 9:16, never cropped; height capped, centred */
.reel-wrap { display: grid; place-items: center; background: var(--media-bg); }
.reel { position: relative; aspect-ratio: 9 / 16; width: min(100%, calc(var(--reel-h) * 9 / 16)); background: #000; }
.reel video, .reel img { display: block; width: 100%; height: 100%; max-height: none; object-fit: cover; }
.reel__tag {
  position: absolute; top: var(--s2); left: var(--s2); display: inline-flex; align-items: center; gap: 4px;
  background: rgb(0 0 0 / .72); color: #fff; border-radius: 4px; font-size: .75rem; font-weight: 700; padding: 4px 6px;
}
.reel__tag svg.i { width: 14px; height: 14px; }
.reel[data-state="playing"] .reel__tag { display: none; }
.ig__frame.video video { width: 100%; height: 100%; max-height: none; position: absolute; inset: 0; }

.ig__caption { margin: var(--s3) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.ig__caption.is-clamped { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.ig__caption b { font-weight: 700; }

/* Generic card (Reddit + custom sites) */
.site-badge {
  width: var(--avatar); height: var(--avatar); border-radius: 10px; display: grid; place-items: center;
  color: #fff; font-weight: 800; font-size: 1rem; user-select: none;
}
.site-badge--reddit { background: hsl(16 55% 38%); }
.gen__head { display: flex; align-items: center; flex-wrap: wrap; gap: 0 var(--s1); line-height: 1.3; min-width: 0; }
.gen__place { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.gen__meta, .gen__dot { color: var(--muted); font-size: var(--fs-meta); }
.gen__meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.gen__body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s3); margin-top: var(--s1); align-items: start; }
.gen__title { margin: 0; font-size: var(--fs-title); line-height: 1.3; font-weight: 700; overflow-wrap: anywhere; }
.gen__text { margin: var(--s1) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.gen__text.is-clamped { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.gen__text--lead { margin-top: 0; }
.gen__domain { display: inline-flex; align-items: center; gap: var(--s1); margin-top: var(--s2); min-height: 28px; font-size: var(--fs-small); color: var(--muted); text-decoration: none; max-width: 100%; }
.gen__domain span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
a.gen__domain:hover { text-decoration: underline; color: var(--accent); }
.gen__domain svg.i { width: 14px; height: 14px; }

/* Narrow column */
@container app (max-width: 480px) {
  .ig__head { gap: var(--s2); }
  .ig__media { margin-inline: calc(var(--s3) * -1); border-radius: 0; border-inline: 0; }
  .gen__body { gap: var(--s2); }
}
`;
