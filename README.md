# No More Clickbait

Your own social feed, filtered by your own LLM — clickbait scored, factual
claims checked against sources, and a timeline that **ends** after N posts
instead of scrolling forever.

> **Status: skeleton.** The repo currently contains the project scaffold —
> extension, desktop shell, native bridge, shared schemas and pipeline
> interfaces with tests. The X response parser, scoring prompts and the
> end-to-end run are landing in follow-up changes.

## How it works

```
Your browser (Chrome/Brave)                Your machine
┌───────────────────────────┐   Native     ┌──────────────────────────────┐
│ MV3 extension             │   Messaging  │ Desktop app (Electron, tray) │
│ observes the HomeTimeline │ ───────────► │ hard filter (code)           │
│ responses X already       │   (no TCP    │ → scorer (one LLM call)      │
│ fetched for you           │    port)     │ → selector (code thresholds) │
└───────────────────────────┘              │ → verifier (parallel calls)  │
                                           │ → verified selection (JSON)  │
                                           └──────────────────────────────┘
```

Design rules:

- **Your cookies never leave your device.** The extension only observes
  responses your own browser session already received. There is no server,
  no third-party scraping service, no telemetry.
- **Orchestration is code; the LLM only judges.** Thresholds, ordering and
  the "show N, then stop" rule live in plain code. The LLM returns scores
  and verdicts as JSON, never HTML.
- **Verification never overclaims.** A claim with no supporting source is
  labelled "could not be verified", not "false".
- **Feed content is untrusted input.** It is schema-validated at every
  boundary, HTML-escaped in output, and the LLM runs with the narrowest
  tool permissions possible (none for scoring; web search/fetch only for
  verification) because posts are a prompt-injection source.

## Collection modes

- **Mode A — passive (default).** While you browse X yourself, the extension
  keeps the timeline responses your browser already fetched. No extra
  requests are made.
- **Mode B — automatic, opt-in, OFF by default.** "Collect feed (N)" in the
  extension popup or options opens x.com/home in your own browser session,
  somewhere you do not look at, and scrolls it until N distinct posts were
  collected. The page's own timeline responses are picked up exactly as in
  Mode A; the extension never calls X's API itself, and no external or
  headless browser is involved.

### Mode B and its risks

Mode B is **disabled by default** and must be switched on explicitly in the
extension options. Read this before you do:

- **X's Terms of Service.** Automated browsing sits in a grey area of X's
  Terms of Service. Mode B scrolls your timeline with a script, so X sees
  timeline requests you did not personally make.
- **Your account.** That traffic is tied to your logged-in account. X may
  answer it with rate limits, temporary locks or suspension. Mode B stops
  as soon as it sees a rate-limit answer, a login page or an error page,
  but it cannot rule these out.
- **You are responsible for how you use it.** If that risk is not
  acceptable to you, leave Mode B off — Mode A is the intended default
  experience.

How a run behaves:

- Each scroll jumps to the bottom of the timeline. The scroll pace is
  **Normal** by default (a short random pause of about 0.36–0.7 s) or
  **Fast** (half of that); Fast may be more likely to be noticed by X. A
  run ends at the first of: N distinct organic posts, 10 minutes, about
  20 s without a new post, a login/error/rate-limit page, or its window
  being closed. The window then closes and a notification says why.
- Switching Mode B on asks for the `alarms` permission (no install
  warning). It only lets a run resume if the browser stops the extension's
  background worker mid-run.
- Browsers stop rendering pages nobody can see and slow their timers, and
  X may then load no further posts. A run uses a **minimized window** by
  default; a small window in the screen corner is the fallback (browsers
  keep at least half of a window on screen, so this one stays partly
  visible). There is no background-tab option: in trials X stopped
  loading posts there after the first few dozen. The options page shows
  the numbers of the last run (posts, scrolls per minute, responses, how
  often the page was hidden, why it stopped and the browser's error, if
  any). With developer capture on, the same counts are added to that
  capture's `summary.json`.

### Instagram

Next to X, the Instagram home feed is a source of its own: tick
**Collect from Instagram** (and/or untick **Collect from X**) in the
extension options or the desktop Settings. It is read the same way as X —
from the responses the page itself loads (the first page embedded in the
document, then its `/graphql/query` pages); no extra requests, no reading
of the page's text.

- **Per source.** "Posts to collect" applies to each ticked source on its
  own (N from X, N from Instagram). Mode A completes once every ticked
  source reached it; a source that did is closed for that collection.
  The popup shows each source's count and **Finish now** ends your own
  collection early (the desktop app asks before building).
- **Mode B** scrolls the sources one after the other in the same window:
  X first, then Instagram, each until its own target or stop (not logged
  in, no new posts…). One source falling short never stops the other; a
  cancel ends both.
- Ads are dropped, posts Instagram suggests from accounts you do not
  follow are kept (marked "suggested"), and posts without a caption are
  set aside like X's media-only posts. Reload an Instagram tab that was
  open when you ticked it.
- With X, Instagram and every custom site off, "Collect" says there is
  nothing to collect; with only custom sites on, it collects them at once.

### Custom sites

Options › **Sites** adds news sites, blogs or forums next to X. For each
site you pick once, on the real page, which repeating box is an item and
where its title, text and link are (or use the site's RSS/Atom feed when
it has one — no picking needed). A rule only holds page selectors; it can
be exported and shared, and importing one runs no code.

- **Permissions.** Each site asks for access to that site only, when you
  add it; there is no "all sites" permission. Revoking it in the browser
  pauses the site ("Permission needed").
- **Your session.** Pages are fetched with your own browser session on
  that site, so a page you are signed in to answers as it does for you.
- **When.** Sites are collected only while a collection runs (Mode B, or
  Mode A reaching its target), in parallel with X and outside X's counts.
  The order is the feed, then the page's HTML fetched without a tab, then
  the page's own "more" responses captured while you browsed the site. A
  hidden window opens only for a site where you chose that and confirmed
  it once; otherwise the site shows "Visible tab needed".

## Layout

| Path                   | What it is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `apps/extension`       | MV3 extension for Chrome/Brave (Mode A listener, Mode B auto-scroll)    |
| `apps/desktop`         | Electron tray app: runs the pipeline, token monitor, reading window     |
| `packages/core`        | Shared zod schemas, pipeline interfaces + run metrics, LLM CLI provider |
| `packages/native-host` | Native Messaging host (browser ⇄ desktop bridge, stdio only)            |

The pipeline's output is the verified selection as JSON plus per-run
metrics (collection span, per-call tokens/cost/durations — see
`RunMetrics` in `@nmc/core`, rendered by the desktop token monitor). A
presentation layer for the finished timeline will be designed separately.

## LLM provider

Phase 1 uses **your own locally installed, logged-in `claude` CLI** as a
subprocess (`claude -p`, JSON output). The app never reads or copies the
CLI's credential files — the CLI handles its own authentication. If the CLI
is missing or not logged in, you get a clear error saying so. The provider
wrapper is CLI-agnostic so other agent CLIs can plug into the same shape,
and API-key providers are planned later. Secrets for future providers are
stored via the OS keychain through Electron `safeStorage` — never in env
files or plain text.

## Develop

Prerequisites: Node ≥ 20, pnpm 10.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

### Load the extension (Brave/Chrome)

1. `pnpm build`
2. Open `brave://extensions` (or `chrome://extensions`), enable
   **Developer mode**.
3. **Load unpacked** → select `apps/extension/dist`.

The extension ID is pinned by the public `key` in the manifest, so it is
the same on every machine regardless of the checkout path:
**`ojljncfhbebelhbkgjhmfgjodpojmnbe`**. (Only the public key lives in this
repo. The matching private key is needed solely to sign `.crx` packages
and is intentionally not kept — generating a new key pair would change
the ID.)

### Register the native host (Windows)

The bridge between browser and desktop uses Native Messaging — no open
ports. Registration is per-user (HKCU) and covers Chrome and Brave. The
script defaults to the pinned extension ID above, so after `pnpm build`
you (the user — it writes to your registry) run:

```powershell
./packages/native-host/install-host.ps1
```

(Node must be on PATH; the browser launches the host through
`packages/native-host/bin/no-more-clickbait-host.cmd`.) Uninstall with
`-Uninstall`.

### Developer capture (measure a real collection)

For development you can record your own timeline responses to inspect
the payload shape and measure collection time:

1. Open the extension **Options** and tick **Developer capture**
   (off by default). Set the capture target (default 250 posts).
2. Browse X as usual (Mode A). The extension forwards each
   HomeTimeline/HomeLatestTimeline response body **verbatim** to the
   native host.
3. The badge shows the running count of **distinct organic posts**
   (parsed posts, ads dropped, posts repeated across overlapping
   responses counted once — the host's `uniquePostCount`); when it
   reaches the target you get a badge + notification and capture keeps
   going until you untick it. Toggling the tick starts a new count and
   a new session folder.
4. The host writes each response to a per-session folder **outside the
   repo** — `%LOCALAPPDATA%\nmc\captures\<session time>\` by default
   (set `NMC_INBOX_DIR` in the host's environment to move it) — numbered
   `0001-<time>-HomeTimeline.json` etc., plus a `summary.json` holding
   only counts and times (first/last capture, response/promoted counts,
   oversized refusals, collection span) and two post counts:
   `uniquePostCount` (distinct organic posts, what the target measures)
   and `postCount` (rough: `tweet-` entries summed per response, so
   repeats across responses are included — typically ~30% higher). Responses over the
   32 MB bridge-frame ceiling are never chunked: they are refused,
   logged, and counted in the summary.
5. Reddit (www.reddit.com) is captured the same way into a separate
   `<session time>-reddit\` folder: raw shreddit responses plus DOM
   snapshots of the post elements. Its `summary.json` lists response
   paths by structure only (`/r/{x}/comments/{id}/*`, query key names
   without values) — no subreddit, user name or post title.
   **Rebuild the host (`pnpm build`) before opening a Reddit tab with
   capture on:** an older host files Reddit data into the X folder.
6. Instagram (www.instagram.com, home feed `/` only) goes into a
   `<session time>-instagram\` folder: the feed blocks embedded in the
   page (`ssr`) and the home feed's `/graphql/query` responses (labelled
   by transport, e.g. `graphql-query:xhr-text`). The host parses them:
   `uniquePostCount` is distinct organic posts (ads and repeats
   dropped), and `summary.json`'s `instagram` block adds counts only —
   feed slot mix (posts, suggested, ads, modules), post kinds, and
   `captionless` / `shortCaption` (≤20 characters) with their ratios:
   caption-less posts cannot be judged from text and are not shown.
   Same rule: rebuild the host first.
7. On Reddit and Instagram the page's `fetch`/XHR are wrapped only while
   the tick is on (the listener is registered with the tick, removed
   without it): **reload an open tab** after ticking or unticking.

> **Raw captures are personal data.** They are your own home timeline as
> X sent it to your browser. Keep them on your machine, never share
> them, never commit them. This repo's tests use synthetic data only.

### Run the desktop app

```sh
pnpm dev  # same as: pnpm --filter @nmc/desktop start
```

It starts in the system tray; click the tray icon for the status window
(the token monitor), where you can check that your `claude` CLI is
installed and logged in.

How the pieces talk:

- The extension keeps one native port open while the browser runs; the
  host process the browser starts for it links up with the desktop app
  over a **named pipe** (`\\.\pipe\no-more-clickbait-<user>`, no TCP
  port). Both ends prove a per-start random token kept in your
  `%LOCALAPPDATA%` before anything else is said: Windows' default pipe
  permissions let other local accounts _read_, so the handshake is what
  keeps the link yours.
- **Collect new timeline** (tray menu, status window or reading window)
  asks the extension to run Mode B. With Mode B off you are told to browse
  x.com/home yourself instead.
- The status window shows a Mode B run's count as it goes (`84 / 100`).
  A Mode B collection builds the timeline as soon as it finishes — also
  when X stopped giving new posts before the target (the window then says
  so). If the run stopped for another reason (e.g. not logged in to X), or
  it was a Mode A collection (your own scrolling reached the target), no
  LLM quota is spent on its own: you get a notification and a **Build
  timeline** button. A run you cancel is never built. If the extension
  goes quiet mid-collection, the window says so after a while instead of
  waiting forever, and collections that never finished are listed (their
  posts stay on disk).
- The pipeline (hard filter → `claude` scoring → selection → source
  checks) runs in the desktop app, one run at a time, cancellable; the
  status window shows the stage, counts, tokens and cost live. The
  finished timeline opens in the reading window; links open in your
  browser.

> **Collected posts stay on your machine.** Every collection is saved
> under `%LOCALAPPDATA%\NoMoreClickbait\sessions\<time>\` (post batches,
> then `timeline.html`/`timeline.json`/`result.json` once built), so a
> collection survives the desktop app being closed. Only the newest 10
> sessions are kept. They contain your feed: never share or commit them.

## Configuration

There is intentionally almost none. See `.env.example` for the few
non-secret knobs (log level, host inbox directory). Secrets never go in env
files.

## Contributing / Security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Tests use **synthetic data only** — never commit real feed captures.

## License

MIT — see [LICENSE](LICENSE).
