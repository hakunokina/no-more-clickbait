import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createClaudeScorer, createClaudeScorerProvider } from "@nmc/core/scorer";
import { createClaudeVerifier, createClaudeVerifierProvider } from "@nmc/core/verifier";
import type { SpawnFn } from "@nmc/core/llm";
import type { CreateStages } from "./pipeline-runner.js";

/**
 * Production stages: the user's own logged-in `claude` CLI, with the
 * Scorer's and Verifier's pinned settings. Every child process is
 * tracked so a cancelled run kills its in-flight calls instead of
 * letting them spend tokens in the background.
 */
export const createClaudeStages: CreateStages = (metrics) => {
  const children = new Set<ChildProcessWithoutNullStreams>();
  const spawnFn: SpawnFn = (command, args, env) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    children.add(child);
    child.on("close", () => children.delete(child));
    return child;
  };
  const scorerProvider = createClaudeScorerProvider({ spawnFn });
  return {
    checkAvailable: () => scorerProvider.checkAvailable(),
    scorer: createClaudeScorer({ provider: scorerProvider, metrics }),
    verifier: createClaudeVerifier({
      provider: createClaudeVerifierProvider({ spawnFn }),
      metrics,
    }),
    cancel() {
      for (const child of children) child.kill();
    },
  };
};
