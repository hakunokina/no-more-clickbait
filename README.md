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

- It waits between scrolls at a reading pace (about 2–3.5 s) and ends at
  the first of: N distinct organic posts, 10 minutes, 8 scrolls in a row
  without a new post, a login/error/rate-limit page, or the tab being
  closed. The hidden tab or window then closes and a notification says why.
- Switching Mode B on asks for the `alarms` permission (no install
  warning). It only lets a run resume if the browser stops the extension's
  background worker mid-run.
- Browsers stop rendering pages nobody can see and slow their timers, and
  X may then load no further posts. The options page therefore offers
  three surfaces — a minimized window, a background tab, and a small
  window in the screen corner (browsers keep at least half of a window on
  screen, so this one stays partly visible) — and two scroll paces (wait
  for X to answer each scroll, or a fixed fast timer). It shows the numbers
  of the last run (posts, scrolls per minute, responses, how often the page
  was hidden, why it stopped and the browser's error, if any). With
  developer capture on, the same counts are added to that capture's
  `summary.json`.

## Layout

| Path                   | What it is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `apps/extension`       | MV3 extension for Chrome/Brave (Mode A listener, Mode B auto-scroll)    |
| `apps/desktop`         | Electron tray app with a compact token-monitor window                   |
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

> **Raw captures are personal data.** They are your own home timeline as
> X sent it to your browser. Keep them on your machine, never share
> them, never commit them. This repo's tests use synthetic data only.

### Run the desktop app

```sh
pnpm --filter @nmc/desktop start
```

It starts in the system tray; click the tray icon for the status window,
where you can check that your `claude` CLI is installed and logged in.

## Configuration

There is intentionally almost none. See `.env.example` for the few
non-secret knobs (log level, host inbox directory). Secrets never go in env
files.

## Contributing / Security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Tests use **synthetic data only** — never commit real feed captures.

## License

MIT — see [LICENSE](LICENSE).
