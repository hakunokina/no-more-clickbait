/**
 * The picker's styles (design: rule-picker-mockup.html, shadow part).
 * Given as a constructed stylesheet (`adoptedStyleSheets`), which a
 * page's strict `style-src` CSP does not block. `:host { all: initial }`
 * resets inherited properties but NOT custom properties — the page's
 * `--accent` would leak in — so every token is defined again on :host.
 */

const TOKENS_LIGHT =
  "--bg:#ffffff;--surface:#f5f7f8;--surface-2:#eceff1;--text:#0f1419;--muted:#536471;--border:#d5dde2;--accent:#0b57d0;--on-accent:#fff;--focus:#0b57d0;--media-bg:#e3e8eb;--ok:#176934;--ok-bg:#e7f4eb;--warn:#8a4b00;--warn-bg:#fdf1e0;--info:#3f4f5e;--info-bg:#edf1f4;color-scheme:light;";
const TOKENS_DARK =
  "--bg:#0e1116;--surface:#161b22;--surface-2:#1e252e;--text:#e7e9ea;--muted:#9aa5b1;--border:#2f3640;--accent:#8ab4f8;--on-accent:#0e1116;--focus:#8ab4f8;--media-bg:#1b2129;--ok:#72d39c;--ok-bg:#12261b;--warn:#f2b45a;--warn-bg:#2b1f0d;--info:#b8c3ce;--info-bg:#1e252e;color-scheme:dark;";

export const PICKER_CSS = `
:host { all: initial; ${TOKENS_LIGHT}
  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--r-pill:999px;--r-box:12px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  --fs-body:15px; --fs-meta:14px; --fs-small:13px; }
:host([data-theme="dark"]) { ${TOKENS_DARK} }
@media (prefers-color-scheme: dark) { :host(:not([data-theme="light"])) { ${TOKENS_DARK} } }
* { box-sizing: border-box; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
button, input, select { font: inherit; color: inherit; letter-spacing: normal; text-transform: none; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
svg.i { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
[hidden] { display: none !important; }
code { font-family: var(--mono); font-size: 12.5px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* One top-layer root (Popover API): above any page z-index, clicks pass through it. */
.root { position: fixed; inset: 0; width: 100vw; height: 100vh; margin: 0; padding: 0; border: 0; background: transparent; overflow: visible; pointer-events: none; color: var(--text); font: var(--fs-body)/1.45 var(--font); z-index: 2147483640; }
.root > :not(.layer) { pointer-events: auto; }

.layer { position: fixed; inset: 0; pointer-events: none; font: 600 11px/1 var(--font); }
.box { position: absolute; border: 2px solid var(--c); box-shadow: 0 0 0 2px #fff, 0 0 0 3px rgb(15 20 25 / .85); border-radius: 3px; background: color-mix(in srgb, var(--c) 7%, transparent); }
.box--match { border-style: dashed; background: transparent; }
.box--hover { border-width: 3px; background: color-mix(in srgb, var(--c) 12%, transparent); }
.box--cursor { border-width: 3px; border-style: solid; box-shadow: 0 0 0 2px #fff, 0 0 0 5px rgb(15 20 25 / .9); }
.box--field { border-width: 2px; background: transparent; box-shadow: 0 0 0 1px #fff; }
.box--veil { border: 2px solid #b3261e; background: repeating-linear-gradient(135deg, rgb(251 248 243 / .78) 0 8px, rgb(179 38 30 / .22) 8px 10px); box-shadow: 0 0 0 1px #fff; }
.box--veil::after { content: ""; position: absolute; left: 0; right: 0; top: 50%; border-top: 2px solid #b3261e; transform: rotate(-4deg); }
.box--not { border: 2px dashed #536471; background: rgb(251 248 243 / .7); box-shadow: 0 0 0 1px #fff; }
.tag { position: absolute; left: -2px; top: -22px; display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; border-radius: 4px 4px 4px 0; background: var(--c); color: #fff; white-space: nowrap; box-shadow: 0 0 0 1px #fff; }
.tag--in { top: 2px; left: 2px; border-radius: 3px; }
.tag b { font-weight: 800; }
.tag--letter { padding: 0 5px; }
.tag code { font-size: 11px; font-weight: 500; color: #fff; }
.tag svg.i { width: 12px; height: 12px; }

.panel { position: fixed; right: 16px; bottom: 16px; width: 360px; max-height: min(78vh, 720px);
  display: flex; flex-direction: column; background: var(--bg); color: var(--text); font: var(--fs-body)/1.45 var(--font);
  border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 12px 40px rgb(0 0 0 / .28), 0 2px 6px rgb(0 0 0 / .18); overflow: hidden; }
.panel[data-side="left"] { right: auto; left: 16px; }
.p-head { display: flex; align-items: center; gap: var(--s2); padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--border); }
.p-logo { width: 28px; height: 28px; border-radius: 8px; background: var(--text); color: var(--bg); display: grid; place-items: center; font: 800 11px/1 var(--font); letter-spacing: .02em; flex: none; }
.p-titles { flex: 1; min-width: 0; }
.p-brand { font-size: var(--fs-small); font-weight: 700; }
.p-site { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.hbtn { width: 32px; height: 32px; border-radius: 50%; border: 0; background: none; display: grid; place-items: center; cursor: pointer; color: var(--muted); flex: none; }
.hbtn:hover { background: var(--surface); color: var(--text); }
.hbtn svg.i { width: 17px; height: 17px; }
.p-body { padding: 14px; overflow-y: auto; flex: 1; min-height: 0; }
.p-foot { padding: 10px 14px 14px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.p-body h2 { font-size: 17px; line-height: 1.3; margin: 0 0 6px; }
.p-body p { margin: 0 0 10px; }
.muted { color: var(--muted); font-size: var(--fs-small); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 18px; border-radius: var(--r-pill); border: 1px solid transparent; font-weight: 700; cursor: pointer; width: 100%; }
.btn--primary { background: var(--text); color: var(--bg); }
.btn--primary:hover { opacity: .9; }
.btn--ghost { background: transparent; border-color: var(--border); }
.btn--ghost:hover { background: var(--surface); }
.btn[disabled], .btn[aria-disabled="true"] { opacity: .45; cursor: not-allowed; }
.btn--inline { width: auto; min-height: 36px; padding: 0 14px; font-size: var(--fs-meta); }
.linkbtn { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 4px 0; min-height: 28px; font-size: var(--fs-meta); text-decoration: underline; text-underline-offset: 2px; }
.choice { display: grid; gap: 10px; margin: 12px 0 4px; }
.choice .btn { justify-content: flex-start; height: auto; min-height: 56px; padding: 10px 16px; text-align: left; border-radius: 14px; }
.choice .btn small { display: block; font-weight: 400; font-size: 12.5px; opacity: .85; }
.privacy { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; color: var(--info); background: var(--info-bg); border-radius: 8px; padding: 8px 10px; margin: 0; }
.privacy svg.i { width: 16px; height: 16px; margin-top: 1px; }

.cursorbox { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; margin: 0 0 12px; background: var(--surface); cursor: default; }
.cursorbox:focus-visible { outline-offset: 1px; }
.cursorbox__row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cursorbox__row code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cursorbox__cnt { font-size: 12px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.cursorbox__keys { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.kb { display: inline-flex; align-items: center; gap: 4px; min-height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--r-pill); background: var(--bg); cursor: pointer; font-size: 12px; }
.kb svg.i { width: 14px; height: 14px; }
.kb:hover { background: var(--surface-2); }

.roles { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 10px; }
.roles li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 6px 6px 6px 10px; min-height: 40px; }
.roles li + li { border-top: 1px solid var(--border); }
.badge { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; background: var(--c); color: #fff; font: 800 11.5px/1 var(--font); }
.roles .r-name { font-size: var(--fs-meta); font-weight: 600; min-width: 0; }
.roles .r-val { display: block; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
.roles .ok { color: var(--ok); }
.roles .warn { color: var(--warn); }
.roles li.is-empty .r-name { color: var(--muted); font-weight: 400; }
.roles li.is-empty .badge { background: transparent; color: var(--muted); box-shadow: inset 0 0 0 1.5px var(--border); }
.rm { width: 28px; height: 28px; border: 0; background: none; border-radius: 50%; cursor: pointer; color: var(--muted); display: grid; place-items: center; }
.rm:hover { background: var(--surface); color: var(--text); }
.rm svg.i { width: 15px; height: 15px; }
.note { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; border-radius: 8px; padding: 8px 10px; margin: 10px 0 0; }
.note svg.i { width: 16px; height: 16px; margin-top: 1px; }
.note--warn { background: var(--warn-bg); color: var(--warn); }
.note--ok { background: var(--ok-bg); color: var(--ok); }
.note--info { background: var(--info-bg); color: var(--info); }
.note p { margin: 0; }
.note .linkbtn { color: inherit; font-size: 12.5px; min-height: 24px; padding: 0; }

.pill { position: fixed; right: 16px; bottom: 16px; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px 0 8px; border-radius: var(--r-pill); border: 1px solid var(--border); background: var(--bg); color: var(--text); font: 700 var(--fs-meta)/1 var(--font); box-shadow: 0 8px 24px rgb(0 0 0 / .25); cursor: pointer; }
.pill[data-side="left"] { right: auto; left: 16px; }

.pop { position: fixed; width: 288px; background: var(--bg); color: var(--text); font: var(--fs-meta)/1.4 var(--font);
  border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 12px 32px rgb(0 0 0 / .3); padding: 10px; }
.pop__head { display: flex; align-items: baseline; gap: 8px; margin: 0 2px 8px; min-width: 0; }
.pop__head code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.pop__head span { font-size: 12px; color: var(--muted); white-space: nowrap; }
.pop__nav { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
.pop__roles { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.rbtn { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); cursor: pointer; text-align: left; }
.rbtn:hover { background: var(--surface); }
.rbtn[aria-pressed="true"] { border-color: var(--c); box-shadow: inset 0 0 0 1px var(--c); }
.rbtn .badge { width: 20px; height: 20px; font-size: 11px; }
.rbtn kbd { margin-left: auto; font: 11px/1 var(--mono); color: var(--muted); }
.rbtn--cut { grid-column: 1 / -1; }
.pop__extra { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.pop__msg { font-size: 12.5px; color: var(--warn); background: var(--warn-bg); border-radius: 8px; padding: 6px 8px; margin: 8px 0 0; }

.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(440px, 100vw); display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); font: var(--fs-body)/1.45 var(--font); border-left: 1px solid var(--border); box-shadow: -12px 0 40px rgb(0 0 0 / .25); }
.drawer[data-side="left"] { right: auto; left: 0; border-left: 0; border-right: 1px solid var(--border); }
.d-sum { margin: 0; padding: 10px 16px; font-size: var(--fs-meta); color: var(--muted); border-bottom: 1px solid var(--border); }
.d-sum b { color: var(--text); }
.d-body { flex: 1; overflow-y: auto; min-height: 0; }
.post { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.post__grid { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; }
.avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 14px; background: #7a2e3b; }
.post__head { display: flex; align-items: center; flex-wrap: wrap; gap: 0 4px; line-height: 1.3; }
.post__name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.post__handle, .post__time, .post__dot { color: var(--muted); font-size: var(--fs-meta); }
.post__title { margin: 2px 0 0; font-weight: 700; }
.post__text { margin: 2px 0 0; overflow-wrap: anywhere; }
.post__missing { color: var(--muted); font-size: 12.5px; font-style: italic; }
.media { margin-top: 12px; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; background: var(--media-bg); }
.media img { display: block; width: 100%; height: auto; }
.post__foot { display: flex; justify-content: flex-end; margin-top: 8px; }
.open { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-meta); font-weight: 600; color: var(--accent); text-decoration: none; min-height: 28px; }
.open svg.i { width: 15px; height: 15px; }
.d-more { padding: 10px 16px; color: var(--muted); font-size: var(--fs-small); text-align: center; border-bottom: 1px solid var(--border); }
.d-zero { padding: 16px; }
.d-form { padding: 16px; display: grid; gap: 14px; }
.d-form h3 { margin: 0; font-size: 15px; }
.f label, .f .lbl { display: block; font-weight: 600; font-size: var(--fs-meta); margin-bottom: 4px; }
.f input, .f select { width: 100%; min-height: 40px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); padding: 0 10px; }
.f input[type="number"] { width: 96px; }
.f .muted { margin: 4px 0 0; }
.f .row { display: flex; gap: 8px; align-items: center; }
.f .note { margin: 6px 0 0; }
.readonly { font-family: var(--mono); font-size: 12.5px; padding: 8px 10px; background: var(--surface); border-radius: 8px; overflow-wrap: anywhere; }
.d-foot { padding: 12px 16px 16px; border-top: 1px solid var(--border); display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

.done-icon { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; background: var(--ok-bg); color: var(--ok); margin: 4px 0 10px; }
.done-icon svg.i { width: 26px; height: 26px; stroke-width: 2.5; }
.err-icon { background: var(--warn-bg); color: var(--warn); }

@media (max-width: 520px) {
  .panel, .panel[data-side="left"] { left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 56vh; }
  .pill, .pill[data-side="left"] { right: 8px; left: auto; bottom: 8px; }
  .pop { left: 8px !important; right: 8px; width: auto; top: auto !important; bottom: 8px; max-height: 70vh; overflow-y: auto; }
  .drawer, .drawer[data-side="left"] { width: 100vw; left: 0; right: 0; border: 0; }
}
`;
