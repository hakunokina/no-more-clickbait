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
- **Mode B — automatic, opt-in, OFF by default.** A hidden tab scrolls your
  timeline automatically until enough posts are gathered.

### Mode B and its risks

Mode B is **disabled by default** and must be switched on explicitly in the
extension options. Automated browsing sits in a grey area of X's Terms of
Service: enabling it may lead to rate limiting, account locks, or suspension.
It also makes requests you did not personally initiate. If that risk is not
acceptable to you, leave it off — Mode A is the intended default experience.
You are responsible for how you use it.

## Layout

| Path                   | What it is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `apps/extension`       | MV3 extension for Chrome/Brave (Mode A listener, Mode B toggle)         |
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
4. Note the extension ID shown on its card.

### Register the native host (Windows)

The bridge between browser and desktop uses Native Messaging — no open
ports. Registration is per-user (HKCU) and covers Chrome and Brave:

```powershell
./packages/native-host/install-host.ps1 -ExtensionId <id-from-step-4>
```

(Node must be on PATH; the browser launches the host through
`packages/native-host/bin/no-more-clickbait-host.cmd`.) Uninstall with
`-Uninstall`.

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
