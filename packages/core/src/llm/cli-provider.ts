import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LlmCallMetrics } from "../metrics.js";

/**
 * LLM access for phase 1: the user's own locally logged-in agent CLI,
 * invoked as a subprocess. We never read, copy or store the CLI's
 * credential/token files — the CLI handles its own auth. If the CLI is
 * missing or not logged in, we fail with a clear, actionable error.
 *
 * The wrapper is CLI-agnostic on purpose: a future Codex (or other) CLI
 * plugs in by describing its argv shape, not by new plumbing.
 */

export interface LlmRequest {
  prompt: string;
  /**
   * Tools the CLI agent may use. Keep this as narrow as the job allows:
   * feed content is untrusted and a prompt-injection source. Scoring
   * needs no tools; verification needs only WebSearch/WebFetch.
   */
  allowedTools?: readonly string[];
}

export interface LlmResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Provider-reported cost in USD (claude CLI: `total_cost_usd`). */
  costUsd?: number;
  /** Call duration; provider-reported when available, else measured. */
  durationMs: number;
}

export type LlmAvailability =
  | { ok: true; version: string }
  | { ok: false; reason: "not-found" | "not-authenticated" | "error"; detail: string };

export interface LlmProvider {
  readonly id: string;
  checkAvailable(): Promise<LlmAvailability>;
  complete(request: LlmRequest): Promise<LlmResult>;
}

export class CliNotFoundError extends Error {
  constructor(command: string) {
    super(`LLM CLI "${command}" was not found on PATH. Install it and log in, then retry.`);
    this.name = "CliNotFoundError";
  }
}

export class CliNotAuthenticatedError extends Error {
  constructor(command: string, detail: string) {
    super(
      `LLM CLI "${command}" does not appear to be logged in. Log in with the CLI first. (${detail})`,
    );
    this.name = "CliNotAuthenticatedError";
  }
}

export class CliRunError extends Error {
  constructor(command: string, detail: string) {
    super(`LLM CLI "${command}" failed: ${detail}`);
    this.name = "CliRunError";
  }
}

/** The slice of a child process this module needs (real spawn or a fake). */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  /** Extra environment entries for the child, merged over ours. */
  env?: Record<string, string>,
) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFn = (command, args, env) =>
  spawn(command, [...args], {
    shell: false,
    windowsHide: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });

export interface CliProviderSpec {
  id: string;
  command: string;
  /** argv for a non-interactive completion; the prompt is fed via stdin. */
  buildArgs(request: LlmRequest): string[];
  versionArgs: readonly string[];
  /** Optional argv reporting login state (see `parseAuthStatus`). */
  authCheckArgs?: readonly string[];
  /**
   * Reads the auth-check command's stdout: true = logged in, false =
   * definitely logged out, undefined = the output says nothing usable
   * (fall back to the exit code). Needed because `claude auth status`
   * exits 0 with `{"loggedIn": false}` when logged out — exit code
   * alone would read that as "ready".
   */
  parseAuthStatus?: (stdout: string) => boolean | undefined;
  /** Extract the result from the CLI's stdout. Throws on garbage. */
  parseOutput(stdout: string): Omit<LlmResult, "durationMs"> & { durationMs?: number };
  /** stderr/stdout fingerprint of "not logged in". */
  authFailurePattern?: RegExp;
}

export interface CliLlmProviderOptions {
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  /** Extra environment entries for every child process, merged over ours. */
  env?: Record<string, string>;
}

interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export class CliLlmProvider implements LlmProvider {
  readonly id: string;
  readonly #spec: CliProviderSpec;
  readonly #spawnFn: SpawnFn;
  readonly #timeoutMs: number;
  readonly #env: Record<string, string> | undefined;

  constructor(spec: CliProviderSpec, options: CliLlmProviderOptions = {}) {
    this.id = spec.id;
    this.#spec = spec;
    this.#spawnFn = options.spawnFn ?? defaultSpawn;
    this.#timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.#env = options.env;
  }

  async checkAvailable(): Promise<LlmAvailability> {
    let version: RunOutcome;
    try {
      version = await this.#run(this.#spec.versionArgs, "");
    } catch (error) {
      if (error instanceof CliNotFoundError) {
        return { ok: false, reason: "not-found", detail: error.message };
      }
      return { ok: false, reason: "error", detail: String(error) };
    }
    if (version.exitCode !== 0) {
      return {
        ok: false,
        reason: "error",
        detail: version.stderr.trim() || `exit ${version.exitCode}`,
      };
    }
    if (this.#spec.authCheckArgs) {
      const auth = await this.#run(this.#spec.authCheckArgs, "");
      if (auth.exitCode !== 0) {
        return {
          ok: false,
          reason: "not-authenticated",
          detail: (auth.stderr || auth.stdout).trim() || `exit ${auth.exitCode}`,
        };
      }
      // Exit 0 is not proof of a session: the CLI may report the login
      // state inside its output (claude: {"loggedIn": false}).
      if (this.#spec.parseAuthStatus?.(auth.stdout) === false) {
        return {
          ok: false,
          reason: "not-authenticated",
          detail: auth.stdout.trim() || "not logged in",
        };
      }
    }
    return { ok: true, version: version.stdout.trim() };
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const startedAt = Date.now();
    const outcome = await this.#run(this.#spec.buildArgs(request), request.prompt);
    const measuredMs = Date.now() - startedAt;
    if (outcome.exitCode !== 0) {
      // Only a failed run can signal an auth problem. On exit 0 the same
      // words may simply be quoted feed content inside a valid result.
      // Search BOTH streams: the CLI may put the complaint in stdout's
      // JSON error field while stderr carries unrelated warnings.
      const diagnostics = `${outcome.stderr}\n${outcome.stdout}`;
      if (this.#spec.authFailurePattern?.test(diagnostics)) {
        throw new CliNotAuthenticatedError(
          this.#spec.command,
          firstLine(outcome.stderr) || firstLine(outcome.stdout),
        );
      }
      throw new CliRunError(
        this.#spec.command,
        firstLine(outcome.stderr) || `exit ${outcome.exitCode}`,
      );
    }
    try {
      const parsed = this.#spec.parseOutput(outcome.stdout);
      return { ...parsed, durationMs: parsed.durationMs ?? measuredMs };
    } catch (error) {
      throw new CliRunError(this.#spec.command, `unparseable output: ${String(error)}`);
    }
  }

  #run(args: readonly string[], stdinText: string): Promise<RunOutcome> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.#spawnFn(this.#spec.command, args, this.#env);
      } catch {
        reject(new CliNotFoundError(this.#spec.command));
        return;
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new CliRunError(this.#spec.command, `timed out after ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(error.code === "ENOENT" ? new CliNotFoundError(this.#spec.command) : error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode });
      });
      child.stdin.end(stdinText);
    });
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

type ParsedCliResult = Omit<LlmResult, "durationMs"> & { durationMs?: number };

/** Parses `claude -p --output-format json` (single result object). */
export function parseClaudeJsonOutput(stdout: string): ParsedCliResult {
  const parsed: unknown = JSON.parse(stdout);
  return claudeResultToLlmResult(parsed);
}

/** Parses `claude -p --output-format stream-json` (one JSON object per line). */
export function parseClaudeStreamJsonOutput(stdout: string): ParsedCliResult {
  let result: ParsedCliResult | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed) && parsed.type === "result") {
      result = claudeResultToLlmResult(parsed);
    }
  }
  if (!result) throw new Error("no result event in stream-json output");
  return result;
}

function claudeResultToLlmResult(parsed: unknown): ParsedCliResult {
  if (!isRecord(parsed) || typeof parsed.result !== "string") {
    throw new Error("missing string `result` field");
  }
  if (parsed.is_error === true) throw new Error(`CLI reported an error: ${parsed.result}`);
  const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
  const result: ParsedCliResult = { text: parsed.result };
  const num = (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined;
  const assign = <K extends keyof ParsedCliResult>(key: K, value: number | undefined): void => {
    if (value !== undefined) result[key] = value as ParsedCliResult[K];
  };
  assign("inputTokens", num(usage?.input_tokens));
  assign("outputTokens", num(usage?.output_tokens));
  assign("cacheReadTokens", num(usage?.cache_read_input_tokens));
  assign("cacheCreationTokens", num(usage?.cache_creation_input_tokens));
  assign("costUsd", num(parsed.total_cost_usd));
  assign("durationMs", num(parsed.duration_ms));
  return result;
}

/** Converts a completed call into a RunMetrics entry for the monitor UI. */
export function llmResultToCallMetrics(
  providerId: string,
  stage: string,
  startedAtIso: string,
  result: LlmResult,
): LlmCallMetrics {
  return {
    providerId,
    stage,
    startedAt: startedAtIso,
    durationMs: result.durationMs,
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.cacheReadTokens !== undefined
      ? { cacheReadTokens: result.cacheReadTokens }
      : {}),
    ...(result.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: result.cacheCreationTokens }
      : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface ClaudeCliOptions extends CliLlmProviderOptions {
  /** Output format passed to the CLI. Defaults to "json". */
  outputFormat?: "json" | "stream-json";
  /**
   * Maximum output tokens per request. The CLI has no flag for this
   * (checked against `claude --help`, 2.1.300); the documented knob is
   * the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment variable, whose
   * default and cap vary by model (values above a model's cap are
   * lowered to the cap by the CLI). Left unset, the CLI default
   * applies and the child's environment is untouched.
   */
  maxOutputTokens?: number;
  /**
   * Model passed as `--model`. Unset, the CLI uses the user's own
   * configured default — fine for chat, but it makes cost, speed and
   * judgement depend on a setting this project does not control, so
   * callers that are measured/tuned (the Scorer) should pin it.
   */
  model?: string;
  /**
   * Effort passed as `--effort` (levels from `claude --help`, 2.1.300).
   * On adaptive-thinking models it steers how much the model thinks,
   * and thinking tokens count as output tokens. Unset = CLI default.
   */
  effort?: ClaudeEffort;
  /**
   * Extra argv appended before the tool/MCP restriction flags. Flags
   * this provider owns are rejected (see RESERVED_FLAGS) — this is an
   * escape hatch for unrelated flags, not a way around the security
   * posture or the pinned model/effort.
   */
  extraArgs?: readonly string[];
}

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * argv names `extraArgs` may not touch. The tool/MCP ones could
 * re-open the tool set or the user's MCP servers that this provider
 * hard-disables (MCP tools live outside `--tools`' built-in set, so
 * `--tools` alone would not close them). The restriction flags are
 * also placed after `extraArgs`, but several of these CLI options
 * accumulate rather than last-win (`--allowedTools`, `--mcp-config`),
 * so order alone is not a guarantee — reject them outright. Model and
 * effort have their own typed options; a second copy in extraArgs
 * would make the effective value depend on CLI parsing order.
 */
const RESERVED_FLAGS = [
  "--tools",
  "--allowedTools",
  "--allowed-tools",
  "--mcp-config",
  "--strict-mcp-config",
  "--model",
  "--effort",
] as const;

function assertExtraArgsSafe(extraArgs: readonly string[]): void {
  for (const arg of extraArgs) {
    const flag = arg.split("=", 1)[0] ?? arg;
    if ((RESERVED_FLAGS as readonly string[]).includes(flag)) {
      throw new Error(
        `extraArgs may not set "${flag}": tool/MCP restrictions keep feed content ` +
          "away from tools and are not configurable; use the model/effort options instead.",
      );
    }
  }
}

/** Reads `loggedIn` from `claude auth status` JSON stdout. */
export function parseClaudeAuthStatus(stdout: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed) && typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
  } catch {
    // Not JSON: no usable signal, the caller falls back to exit code.
  }
  return undefined;
}

/** Empty MCP configuration: with --strict-mcp-config, no MCP servers. */
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/**
 * Phase 1 provider: the user's logged-in `claude` CLI in print mode.
 * The prompt goes over stdin (batch scoring prompts are far too large
 * for argv). Tool permissions stay as narrow as the request specifies.
 */
export function createClaudeCliProvider(options: ClaudeCliOptions = {}): CliLlmProvider {
  const outputFormat = options.outputFormat ?? "json";
  const extraArgs = options.extraArgs ?? [];
  assertExtraArgsSafe(extraArgs);
  if (
    options.maxOutputTokens !== undefined &&
    (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)
  ) {
    throw new Error("maxOutputTokens must be a positive integer");
  }
  // spawn() passes argv verbatim (no shell), but the CLI's own parser
  // would still read a "-..." value as the next flag.
  if (options.model !== undefined && (options.model === "" || options.model.startsWith("-"))) {
    throw new Error("model must be a non-empty model name, not a flag");
  }
  const env =
    options.maxOutputTokens !== undefined
      ? {
          ...options.env,
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxOutputTokens),
        }
      : options.env;
  return new CliLlmProvider(
    {
      id: "claude-cli",
      command: "claude",
      versionArgs: ["--version"],
      authCheckArgs: ["auth", "status"],
      parseAuthStatus: parseClaudeAuthStatus,
      authFailurePattern: /not logged in|please run \/login|authentication required/i,
      buildArgs: (request) => {
        const args = ["-p", "--output-format", outputFormat];
        if (outputFormat === "stream-json") args.push("--verbose");
        if (options.model !== undefined) args.push("--model", options.model);
        if (options.effort !== undefined) args.push("--effort", options.effort);
        args.push(...extraArgs);
        // Restriction flags go LAST (after extraArgs). `--allowedTools`
        // only ADDS permissions; tools allowed in the user's own CLI
        // settings would otherwise stay reachable and a prompt
        // injection in feed content could invoke them. So narrow the
        // available tool SET with `--tools` as well: exactly the
        // requested tools, or none at all (`--tools ""`). The user's
        // MCP servers are a separate channel (`--tools` covers only
        // the built-in set), so shut them on every call: strict mode
        // trusts only --mcp-config, and --mcp-config is empty.
        // (Both flag spellings verified in `claude --help`, 2.1.300.)
        if (request.allowedTools && request.allowedTools.length > 0) {
          args.push("--tools", request.allowedTools.join(","));
          args.push("--allowedTools", ...request.allowedTools);
        } else {
          args.push("--tools", "");
        }
        args.push("--mcp-config", EMPTY_MCP_CONFIG, "--strict-mcp-config");
        return args;
      },
      parseOutput:
        outputFormat === "stream-json" ? parseClaudeStreamJsonOutput : parseClaudeJsonOutput,
    },
    { ...options, ...(env ? { env } : {}) },
  );
}
