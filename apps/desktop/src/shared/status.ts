import type {
  CollectSource,
  CollectSourceOutcome,
  FunnelCounts,
  SiteProgress,
  UiLang,
} from "@nmc/core";
import type { Note } from "./i18n.js";

/**
 * The desktop app's state as the windows see it. Main owns it and pushes
 * every change to the monitor and reading windows; counts and token
 * figures only — never feed content. Messages are `Note`s, put into
 * words by each window in `lang`.
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
  "cli-not-found" | "cli-not-authenticated" | "cli-error" | "session-unreadable" | "internal";

export interface RunError {
  kind: RunErrorKind;
  /** Plain-language reason; technical detail goes in `detail`. */
  note: Note;
  detail: string | null;
}

export interface RunCounts {
  /** Posts read from the session (repeats/ads included). */
  postsIn: number | null;
  /** Distinct organic posts after the hard filter. */
  afterHardFilter: number | null;
  /** Media-only posts set aside unjudged. */
  mediaOnly: number | null;
  /**
   * Judged posts that did not make the timeline: clickbait, below the
   * read floor, unscored, contradicted, or ranked below N.
   */
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

/** One scrolled feed's count in a collection that is not X alone. */
export interface FeedProgress {
  source: CollectSource;
  /** Distinct posts counted so far (null: none reported yet). */
  count: number | null;
}

/**
 * One custom site's part of a collection: `waiting`, `collecting`, then
 * its outcome ("ok", "empty", "error", "timeout", "skipped") with the
 * items it delivered.
 */
export interface CollectionSite {
  siteId: string;
  /** The rule's name (its id when the extension sent none). */
  name: string;
  status: SiteProgress["status"];
  itemCount: number;
}

/** `cancelling`: "Cancel" was pressed; waiting for the extension to end the run. */
export type CollectionState = "idle" | "requested" | "collecting" | "cancelling" | "refused";

export interface DesktopStatus {
  /** The language the windows show (the Settings choice, "system" resolved). */
  lang: UiLang;
  link: {
    listening: boolean;
    /** Authenticated native-host connections (one per running browser). */
    hosts: number;
    error: Note | null;
  };
  collection: {
    state: CollectionState;
    /**
     * Why a request was refused or a collection fell short, or what the
     * user should do next.
     */
    message: Note | null;
    target: number | null;
    /** Distinct posts counted so far by the running collection. */
    count: number | null;
    /**
     * Each feed's count, in the order they are scrolled, when the
     * collection is not X alone (absent: X alone; `[]`: custom sites only).
     */
    sources?: FeedProgress[];
    /**
     * Each custom site of the collection, in rule order, as the extension
     * last reported it (absent: none reported). The finished collection's
     * outcomes stay until the next one starts.
     */
    sites?: CollectionSite[];
  };
  /**
   * A finished collection waiting for the user's "Build timeline" (no
   * run starts without it): Mode A, or a Mode B run that stopped for a
   * reason that does not build on its own (e.g. not logged in).
   */
  pending: PendingCollection | null;
  /**
   * Sessions with stored posts whose collection never completed (no
   * complete.json) — e.g. the browser closed mid-run. Kept on disk.
   */
  unfinished: { count: number; newestAt: string | null };
  run: {
    stage: RunStage;
    sessionId: string | null;
    startedAt: string | null;
    endedAt: string | null;
    counts: RunCounts;
    usage: UsageTotals;
    stageDurationsMs: Record<string, number>;
    collectionSpanMs: number | null;
    /** Where every scanned post went (finished runs). */
    funnel: FunnelCounts | null;
    error: RunError | null;
    /** A finished timeline for `sessionId` can be opened. */
    hasTimeline: boolean;
    /** The finished timeline was deleted since (session folders are pruned). */
    timelineGone: boolean;
  };
}

export interface PendingCollection {
  sessionId: string;
  /**
   * Distinct posts collected: X's, or every feed's together when not X
   * alone; with every feed turned off, the custom sites' stored items.
   */
  uniquePostCount: number;
  mode: "A" | "B";
  /** Why the collection ended ("target-reached" or a Mode B stop reason). */
  reason: string;
  target: number | null;
  /** Each feed's outcome when the collection was not X alone (empty: custom sites only). */
  sources?: CollectSourceOutcome[];
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
    lang: "en",
    link: { listening: false, hosts: 0, error: null },
    collection: { state: "idle", message: null, target: null, count: null },
    pending: null,
    unfinished: { count: 0, newestAt: null },
    run: {
      stage: "idle",
      sessionId: null,
      startedAt: null,
      endedAt: null,
      counts: { ...EMPTY_COUNTS },
      usage: { ...EMPTY_USAGE },
      stageDurationsMs: {},
      collectionSpanMs: null,
      funnel: null,
      error: null,
      hasTimeline: false,
      timelineGone: false,
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
