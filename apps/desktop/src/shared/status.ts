/**
 * The desktop app's state as the windows see it. Main owns it and pushes
 * every change to the monitor and reading windows; counts and token
 * figures only — never feed content.
 */

export type RunStage =
  | "idle"
  | "checking"
  | "filtering"
  | "scoring"
  | "verifying"
  | "rendering"
  | "ready"
  | "error"
  | "cancelled";

export type RunErrorKind =
  | "cli-not-found"
  | "cli-not-authenticated"
  | "cli-error"
  | "session-unreadable"
  | "internal";

export interface RunError {
  kind: RunErrorKind;
  /** Plain-language reason; technical detail goes in `detail`. */
  message: string;
  detail: string | null;
}

export interface RunCounts {
  /** Posts read from the session (repeats/ads included). */
  postsIn: number | null;
  /** Distinct organic posts after the hard filter. */
  afterHardFilter: number | null;
  /** Media-only posts set aside unjudged. */
  mediaOnly: number | null;
  /** Posts that did not make the timeline (judged posts only). */
  filteredOut: number | null;
  selected: number | null;
  verifyDone: number;
  /** Estimated claims to check; grows if backfill adds more. */
  verifyTotal: number;
}

export interface UsageTotals {
  llmCalls: number;
  failedCalls: number;
  /** Uncached input tokens. */
  inputTokens: number;
  /** Cache read + cache creation input tokens. */
  cacheTokens: number;
  /** Output tokens, thinking included. */
  outputTokens: number;
  thinkingTokens: number;
  costUsd: number | null;
}

export type CollectionState = "idle" | "requested" | "collecting" | "refused";

export interface DesktopStatus {
  link: {
    listening: boolean;
    /** Authenticated native-host connections (one per running browser). */
    hosts: number;
    error: string | null;
  };
  collection: {
    state: CollectionState;
    /** Why a request was refused, or what the user should do next. */
    message: string | null;
    target: number | null;
  };
  run: {
    stage: RunStage;
    sessionId: string | null;
    startedAt: string | null;
    endedAt: string | null;
    counts: RunCounts;
    usage: UsageTotals;
    stageDurationsMs: Record<string, number>;
    collectionSpanMs: number | null;
    error: RunError | null;
    /** A finished timeline for `sessionId` can be opened. */
    hasTimeline: boolean;
  };
}

export const EMPTY_COUNTS: RunCounts = {
  postsIn: null,
  afterHardFilter: null,
  mediaOnly: null,
  filteredOut: null,
  selected: null,
  verifyDone: 0,
  verifyTotal: 0,
};

export const EMPTY_USAGE: UsageTotals = {
  llmCalls: 0,
  failedCalls: 0,
  inputTokens: 0,
  cacheTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  costUsd: null,
};

export function initialStatus(): DesktopStatus {
  return {
    link: { listening: false, hosts: 0, error: null },
    collection: { state: "idle", message: null, target: null },
    run: {
      stage: "idle",
      sessionId: null,
      startedAt: null,
      endedAt: null,
      counts: { ...EMPTY_COUNTS },
      usage: { ...EMPTY_USAGE },
      stageDurationsMs: {},
      collectionSpanMs: null,
      error: null,
      hasTimeline: false,
    },
  };
}

/** Stages during which a run is in flight. */
export function isRunActive(stage: RunStage): boolean {
  return (
    stage === "checking" ||
    stage === "filtering" ||
    stage === "scoring" ||
    stage === "verifying" ||
    stage === "rendering"
  );
}
