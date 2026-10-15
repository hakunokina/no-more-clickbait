import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CliNotAuthenticatedError,
  CliNotFoundError,
  CliRunError,
  createClaudeCliProvider,
  parseClaudeJsonOutput,
  parseClaudeStreamJsonOutput,
  type SpawnFn,
} from "./cli-provider.js";

interface FakeScript {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: NodeJS.ErrnoException;
}

/** A fake child process: no real CLI is ever invoked in tests. */
function fakeSpawn(handler: (args: readonly string[], stdin: string) => FakeScript): {
  spawnFn: SpawnFn;
  calls: {
    command: string;
    args: readonly string[];
    stdin: string;
    env?: Record<string, string>;
  }[];
} {
  const calls: {
    command: string;
    args: readonly string[];
    stdin: string;
    env?: Record<string, string>;
  }[] = [];
  const spawnFn: SpawnFn = (command, args, env) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdin = "";
    child.stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        stdin += chunk.toString("utf8");
        cb();
      },
      final(cb) {
        calls.push({ command, args, stdin, ...(env ? { env } : {}) });
        const script = handler(args, stdin);
        queueMicrotask(() => {
          if (script.spawnError) {
            child.emit("error", script.spawnError);
            return;
          }
          if (script.stdout) child.stdout.write(script.stdout);
          if (script.stderr) child.stderr.write(script.stderr);
          child.stdout.end();
          child.stderr.end();
          child.emit("close", script.exitCode ?? 0);
        });
        cb();
      },
    });
    child.kill = () => true;
    return child as ReturnType<SpawnFn>;
  };
  return { spawnFn, calls };
}

const okJson = JSON.stringify({
  type: "result",
  is_error: false,
  result: "the answer",
  duration_ms: 1234,
  total_cost_usd: 0.02,
  usage: {
    input_tokens: 100,
    output_tokens: 7,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 5,
  },
});

describe("createClaudeCliProvider (fake process)", () => {
  it("feeds the prompt via stdin and parses the json result", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ stdout: okJson }));
    const provider = createClaudeCliProvider({ spawnFn });
    const result = await provider.complete({ prompt: "score these posts" });
    expect(result).toEqual({
      text: "the answer",
      inputTokens: 100,
      outputTokens: 7,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
      costUsd: 0.02,
      durationMs: 1234,
    });
    expect(calls[0]?.command).toBe("claude");
    expect(calls[0]?.args).toContain("-p");
    expect(calls[0]?.stdin).toBe("score these posts");
    // No tools requested -> the tool set is hard-disabled (--tools ""),
    // so tools allowed in the user's own settings cannot leak in.
    expect(calls[0]?.args).not.toContain("--allowedTools");
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("grants exactly the requested tools (verification: web only)", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ stdout: okJson }));
    const provider = createClaudeCliProvider({ spawnFn });
    await provider.complete({ prompt: "verify", allowedTools: ["WebSearch", "WebFetch"] });
    const args = calls[0]?.args ?? [];
    const at = args.indexOf("--allowedTools");
    expect(args.slice(at + 1, at + 3)).toEqual(["WebSearch", "WebFetch"]);
    // The available tool set itself is narrowed too, not just permissions.
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
  });

  it("does not mistake feed text quoting 'not logged in' for an auth failure", async () => {
    const quoted = JSON.stringify({
      type: "result",
      is_error: false,
      result: 'the post says "not logged in. please run /login" lol',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { spawnFn } = fakeSpawn(() => ({ stdout: quoted }));
    const provider = createClaudeCliProvider({ spawnFn });
    const result = await provider.complete({ prompt: "score" });
    expect(result.text).toContain("not logged in");
  });

  it("maps ENOENT to CliNotFoundError with a clear message", async () => {
    const error = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
    }) as NodeJS.ErrnoException;
    const { spawnFn } = fakeSpawn(() => ({ spawnError: error }));
    const provider = createClaudeCliProvider({ spawnFn });
    await expect(provider.complete({ prompt: "x" })).rejects.toBeInstanceOf(CliNotFoundError);
    const availability = await provider.checkAvailable();
    expect(availability).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("maps a login complaint to CliNotAuthenticatedError", async () => {
    const { spawnFn } = fakeSpawn(() => ({
      stderr: "Not logged in. Please run /login",
      exitCode: 1,
    }));
    const provider = createClaudeCliProvider({ spawnFn });
    await expect(provider.complete({ prompt: "x" })).rejects.toBeInstanceOf(
      CliNotAuthenticatedError,
    );
  });

  it("checkAvailable reports not-authenticated when the auth check fails", async () => {
    const { spawnFn } = fakeSpawn((args) =>
      args.includes("--version")
        ? { stdout: "1.2.3 (fake)" }
        : { exitCode: 1, stderr: "no session" },
    );
    const provider = createClaudeCliProvider({ spawnFn });
    expect(await provider.checkAvailable()).toMatchObject({
      ok: false,
      reason: "not-authenticated",
    });
  });

  it("checkAvailable is ok when version + auth pass", async () => {
    const { spawnFn } = fakeSpawn((args) =>
      args.includes("--version")
        ? { stdout: "1.2.3" }
        : { stdout: JSON.stringify({ loggedIn: true }) },
    );
    const provider = createClaudeCliProvider({ spawnFn });
    expect(await provider.checkAvailable()).toEqual({ ok: true, version: "1.2.3" });
  });

  it("maps an auth complaint on stdout to CliNotAuthenticatedError even when stderr is noise", async () => {
    const { spawnFn } = fakeSpawn(() => ({
      stdout: JSON.stringify({
        type: "result",
        is_error: true,
        result: "Not logged in. Please run /login",
      }),
      stderr: "Warning: some unrelated deprecation notice",
      exitCode: 1,
    }));
    const provider = createClaudeCliProvider({ spawnFn });
    await expect(provider.complete({ prompt: "x" })).rejects.toBeInstanceOf(
      CliNotAuthenticatedError,
    );
  });

  it("checkAvailable reads loggedIn:false as not-authenticated (exit 0 is not enough)", async () => {
    const { spawnFn } = fakeSpawn((args) =>
      args.includes("--version")
        ? { stdout: "1.2.3" }
        : { stdout: JSON.stringify({ loggedIn: false }) },
    );
    const provider = createClaudeCliProvider({ spawnFn });
    expect(await provider.checkAvailable()).toMatchObject({
      ok: false,
      reason: "not-authenticated",
    });
  });

  it("disables the user's MCP servers: strict empty --mcp-config on every call", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ stdout: okJson }));
    const provider = createClaudeCliProvider({
      spawnFn,
      extraArgs: ["--append-system-prompt", "x"],
    });
    await provider.complete({ prompt: "score" });
    const args = calls[0]?.args ?? [];
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    // Restriction flags come AFTER extraArgs, so last-wins CLI parsing
    // cannot let an integrator-supplied arg loosen them.
    const extraAt = args.indexOf("--append-system-prompt");
    expect(args.indexOf("--tools")).toBeGreaterThan(extraAt);
    expect(args.indexOf("--strict-mcp-config")).toBeGreaterThan(extraAt);
  });

  it("rejects extraArgs that try to override the tool/MCP restrictions or model/effort", () => {
    const { spawnFn } = fakeSpawn(() => ({ stdout: okJson }));
    for (const extraArgs of [
      ["--tools", "default"],
      ["--tools=default"],
      ["--allowedTools", "Bash"],
      ["--mcp-config", "evil.json"],
      ["--strict-mcp-config=false"],
      ["--model", "other"],
      ["--effort=max"],
    ]) {
      expect(() => createClaudeCliProvider({ spawnFn, extraArgs })).toThrow(/extraArgs/);
    }
  });

  it("pins model and effort when given, and omits both by default", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ stdout: okJson }));
    await createClaudeCliProvider({
      spawnFn,
      model: "claude-opus-5-5",
      effort: "low",
    }).complete({
      prompt: "score",
    });
    await createClaudeCliProvider({ spawnFn }).complete({ prompt: "score" });
    const pinned = calls[0]?.args ?? [];
    expect(pinned[pinned.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(pinned[pinned.indexOf("--effort") + 1]).toBe("low");
    expect(calls[1]?.args).not.toContain("--model");
    expect(calls[1]?.args).not.toContain("--effort");
  });

  it("rejects a model value that could be read as a flag", () => {
    const { spawnFn } = fakeSpawn(() => ({ stdout: okJson }));
    for (const model of ["", "--tools"]) {
      expect(() => createClaudeCliProvider({ spawnFn, model })).toThrow(/model/);
    }
  });

  it("passes maxOutputTokens to the child via CLAUDE_CODE_MAX_OUTPUT_TOKENS", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ stdout: okJson }));
    const provider = createClaudeCliProvider({ spawnFn, maxOutputTokens: 16000 });
    await provider.complete({ prompt: "score" });
    expect(calls[0]?.env).toMatchObject({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16000" });
  });

  it("leaves the child's env untouched without maxOutputTokens and rejects bad values", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ stdout: okJson }));
    const provider = createClaudeCliProvider({ spawnFn });
    await provider.complete({ prompt: "score" });
    expect(calls[0]?.env).toBeUndefined();
    expect(() => createClaudeCliProvider({ spawnFn, maxOutputTokens: 0 })).toThrow(
      /maxOutputTokens/,
    );
  });

  it("wraps garbage output in CliRunError", async () => {
    const { spawnFn } = fakeSpawn(() => ({ stdout: "not json at all" }));
    const provider = createClaudeCliProvider({ spawnFn });
    await expect(provider.complete({ prompt: "x" })).rejects.toBeInstanceOf(CliRunError);
  });
});

describe("output parsers", () => {
  it("parses stream-json and picks the result event", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "done",
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    ].join("\n");
    expect(parseClaudeStreamJsonOutput(stream)).toEqual({
      text: "done",
      inputTokens: 3,
      outputTokens: 1,
    });
  });

  it("reads thinking tokens, model and stop reason from the json result", () => {
    const parsed = parseClaudeJsonOutput(
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "1|0|5|0||",
        stop_reason: "max_tokens",
        usage: {
          input_tokens: 2,
          output_tokens: 90,
          output_tokens_details: { thinking_tokens: 30 },
        },
        modelUsage: { "claude-opus-5-5": { outputTokens: 90 } },
      }),
    );
    expect(parsed).toMatchObject({
      outputTokens: 90,
      thinkingTokens: 30,
      model: "claude-opus-5-5",
      stopReason: "max_tokens",
    });
  });

  it("rejects an is_error result", () => {
    expect(() =>
      parseClaudeJsonOutput(JSON.stringify({ is_error: true, result: "boom" })),
    ).toThrow(/boom/);
  });
});
