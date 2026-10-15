# Contributing

Thanks for considering a contribution. This is a small, opinionated project;
the rules below exist to keep it safe to run against people's real accounts.

## Setup

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

All four must pass before a PR. CI runs the same on Windows and Ubuntu.

## Hard rules

- **Synthetic test data only.** Never commit real feed captures, real posts,
  cookies, tokens, or anything scraped from an actual account. Model
  fixtures on `packages/core/fixtures/synthetic-batch.json` (note the
  `example.invalid` URLs).
- **No secrets in the repo, ever.** No `.env` files with real values (only
  `.env.example` with non-secret placeholders). Runtime secrets belong in
  the OS keychain via Electron `safeStorage` (see
  `apps/desktop/src/main/secret-store.ts`). CI runs gitleaks on every push.
- **The user's session stays on the user's device.** No change may send
  cookies, auth headers, or raw feed payloads anywhere but the local
  desktop app via Native Messaging. No new network listeners (the bridge
  is stdio-only by design).
- **Mode B stays opt-in and off by default**, with its risks documented
  wherever the toggle appears.
- **Feed content is hostile input.** Validate with the zod schemas in
  `@nmc/core` at boundaries, escape on render, and keep LLM tool
  permissions as narrow as the feature allows.
- **Verification wording never overclaims:** absence of evidence is
  "could not be verified", not "false".

## Style

- TypeScript, strict mode. Match the surrounding code; prefer small,
  surgical changes over refactors.
- Run `pnpm lint` and keep formatting consistent (`.prettierrc.json`).
- Add or update unit tests for behaviour changes. Pipeline and provider
  logic must be testable with fakes — no real browser, CLI, or network in
  tests.

## Pull requests

- One concern per PR, with a short description of what changed and how you
  verified it (commands + results).
- If your change touches the extension or bridge, say how you exercised it
  (e.g. loaded unpacked in Brave, host registered, batch arrived).
