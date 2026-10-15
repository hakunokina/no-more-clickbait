# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab) rather than a
public issue. We will acknowledge as soon as we can; there is no bug bounty.

Do not include real account cookies, tokens, or other people's data in a
report — a description with synthetic examples is enough.

## Security model (what to expect)

- **No server component.** Everything runs on the user's machine: browser
  extension → Native Messaging (stdio, no TCP port) → desktop app.
- **Session data stays local.** The extension observes responses the user's
  own browser already received. Cookies and auth headers are never read,
  stored, or transmitted by this project.
- **LLM access via the user's own CLI.** The `claude` CLI subprocess keeps
  its own credentials; this project never touches its token files. Stored
  secrets for future providers use Electron `safeStorage` (OS-backed
  encryption) and are refused if OS encryption is unavailable.
- **Feed content is treated as hostile**: schema-validated at every
  process boundary,
  and the LLM receives the narrowest tool permissions per job (none for
  scoring; `WebSearch`/`WebFetch` only for verification), with the
  user's MCP servers disabled for these calls, to limit
  prompt-injection blast radius.
- **Extension permissions are minimal**: `storage`, `nativeMessaging`,
  X host access, and `tabs` only as an _optional_ permission for the
  opt-in Mode B.

## Out of scope

- Risks of Mode B itself (account/ToS risk) — documented, opt-in, off by
  default.
- Vulnerabilities in the user's own LLM CLI or browser; report those
  upstream.
