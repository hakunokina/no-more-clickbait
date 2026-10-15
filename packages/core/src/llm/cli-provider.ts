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
) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFn = (command, args) =>
  spawn(command, [...args], { shell: false, windowsHide: true });

export interface CliProviderSpec {
  id: string;
  command: string;
  /** argv for a non-interactive completion; the prompt is fed via stdin. */
  buildArgs(request: LlmRequest): string[];
  versionArgs: readonly string[];
  /** Optional argv that exits non-zero when the CLI is not logged in. */
  authCheckArgs?: readonly string[];
  /** Extract the result from the CLI's stdout. Throws on garbage. */
  parseOutput(stdout: string): Omit<LlmResult, "durationMs"> & { durationMs?: number };
  /** stderr/stdout fingerprint of "not logged in". */
  authFailurePattern?: RegExp;
}

export interface CliLlmProviderOptions {
  spawnFn?: SpawnFn;
  timeoutMs?: number;
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

  constructor(spec: CliProviderSpec, options: CliLlmProviderOptions = {}) {
    this.id = spec.id;
    this.#spec = spec;
    this.#spawnFn = options.spawnFn ?? defaultSpawn;
    this.#timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
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
      const diagnostics = outcome.stderr.trim() !== "" ? outcome.stderr : outcome.stdout;
      if (this.#spec.authFailurePattern?.test(diagnostics)) {
        throw new CliNotAuthenticatedError(this.#spec.command, firstLine(diagnostics));
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
        child = this.#spawnFn(this.#spec.command, args);
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
  /** Extra argv appended verbatim (escape hatch for future flags). */
  extraArgs?: readonly string[];
}

/**
 * Phase 1 provider: the user's logged-in `claude` CLI in print mode.
 * The prompt goes over stdin (batch scoring prompts are far too large
 * for argv). Tool permissions stay as narrow as the request specifies.
 */
export function createClaudeCliProvider(options: ClaudeCliOptions = {}): CliLlmProvider {
  const outputFormat = options.outputFormat ?? "json";
  return new CliLlmProvider(
    {
      id: "claude-cli",
      command: "claude",
      versionArgs: ["--version"],
      authCheckArgs: ["auth", "status"],
      authFailurePattern: /not logged in|please run \/login|authentication required/i,
      buildArgs: (request) => {
        const args = ["-p", "--output-format", outputFormat];
        if (outputFormat === "stream-json") args.push("--verbose");
        // `--allowedTools` only ADDS permissions; tools allowed in the
        // user's own CLI settings would otherwise stay reachable and a
        // prompt injection in feed content could invoke them. So narrow
        // the available tool SET with `--tools` as well: exactly the
        // requested tools, or none at all (`--tools ""`).
        if (request.allowedTools && request.allowedTools.length > 0) {
          args.push("--tools", request.allowedTools.join(","));
          args.push("--allowedTools", ...request.allowedTools);
        } else {
          args.push("--tools", "");
        }
        args.push(...(options.extraArgs ?? []));
        return args;
      },
      parseOutput:
        outputFormat === "stream-json" ? parseClaudeStreamJsonOutput : parseClaudeJsonOutput,
    },
    options,
  );
}
