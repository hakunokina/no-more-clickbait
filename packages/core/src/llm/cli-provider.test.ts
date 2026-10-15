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
  calls: { command: string; args: readonly string[]; stdin: string }[];
} {
  const calls: { command: string; args: readonly string[]; stdin: string }[] = [];
  const spawnFn: SpawnFn = (command, args) => {
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
        calls.push({ command, args, stdin });
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
      args.includes("--version") ? { stdout: "1.2.3" } : { stdout: "{}" },
    );
    const provider = createClaudeCliProvider({ spawnFn });
    expect(await provider.checkAvailable()).toEqual({ ok: true, version: "1.2.3" });
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

  it("rejects an is_error result", () => {
    expect(() =>
      parseClaudeJsonOutput(JSON.stringify({ is_error: true, result: "boom" })),
    ).toThrow(/boom/);
  });
});
