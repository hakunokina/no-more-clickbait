import { feedItemKey, isInstagramPost, isMediaOnly, isXPost } from "./feed-item.js";
import type { HardFilter } from "./pipeline.js";
import type { FeedItem } from "./schemas.js";

/**
 * The code-only hard filter: drops what needs no judgement and counts
 * why. It is stateful across one run — `keep` is called once per post
 * in feed order, across every captured response, so a post repeated by
 * an overlapping response (or the same original reposted again) is
 * dropped after its first appearance. Items of every source share one
 * run; repeats are told apart by `feedItemKey` (source + id), and only X
 * has reposts.
 *
 * Media-only posts (no text of their own) cannot be judged from text,
 * but they are KEPT and counted as flagged (owner's decision); the
 * Post carries `mediaOnly` for later stages.
 *
 * With `dropSuggested` (the user's "Instagram: only accounts I follow"),
 * the posts Instagram suggests from accounts the user does not follow
 * are dropped too, under their own reason; otherwise they are kept and
 * stay marked `suggested`.
 */

export type HardFilterDropReason =
  /** Ads: the platform marked the post as promoted. */
  | "promoted"
  /** The same item (source + id) was already seen in this run. */
  | "duplicate"
  /** The same original was already seen, at least once via a repost. */
  | "duplicate-repost"
  /** An Instagram suggestion (an account not followed), with `dropSuggested`. */
  | "not-followed";

export interface HardFilterStats {
  /** Posts offered to the filter. */
  seen: number;
  kept: number;
  /** `not-followed` appears only once such a post was dropped (runs before it existed lack it). */
  dropped: Record<Exclude<HardFilterDropReason, "not-followed">, number> & {
    "not-followed"?: number;
  };
  /** Kept posts that carry a "cannot judge" flag. */
  flagged: { mediaOnly: number };
}

/**
 * Serialisable run state (JSON-safe), so a run can outlive the process
 * holding it — e.g. an MV3 service worker that the browser restarts.
 */
export interface HardFilterState {
  /** Kept item keys (`feedItemKey`) → whether that kept appearance was a repost. */
  seen: [id: string, asRepost: boolean][];
  stats: HardFilterStats;
}

export interface HardFilterOptions {
  /** Drop Instagram's suggestions (accounts not followed). Off by default. */
  dropSuggested?: boolean;
}

export interface CountingHardFilter extends HardFilter {
  /** Like `keep`, with the reason when the item is dropped (null: kept). */
  check(item: FeedItem): HardFilterDropReason | null;
  /** Live counters for the current run (a snapshot copy). */
  readonly stats: HardFilterStats;
  /** A copy of the run state; pass it to `createHardFilter` to resume. */
  snapshot(): HardFilterState;
}

function copyStats(stats: HardFilterStats): HardFilterStats {
  return { ...stats, dropped: { ...stats.dropped }, flagged: { ...stats.flagged } };
}

export function createHardFilter(
  resume?: HardFilterState,
  options: HardFilterOptions = {},
): CountingHardFilter {
  /** Item key → whether its kept appearance was a repost. */
  const seenIds = new Map<string, boolean>(resume?.seen);
  const stats: HardFilterStats = resume
    ? copyStats(resume.stats)
    : {
        seen: 0,
        kept: 0,
        dropped: { promoted: 0, duplicate: 0, "duplicate-repost": 0 },
        flagged: { mediaOnly: 0 },
      };

  const drop = (reason: HardFilterDropReason): HardFilterDropReason => {
    stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1;
    return reason;
  };

  const check = (item: FeedItem): HardFilterDropReason | null => {
    stats.seen += 1;
    if (item.promoted) return drop("promoted");
    if (options.dropSuggested && isInstagramPost(item) && item.suggested === true) {
      return drop("not-followed");
    }
    const isRepost = isXPost(item) && item.repostedBy !== undefined;
    const key = feedItemKey(item);
    const seenAsRepost = seenIds.get(key);
    if (seenAsRepost !== undefined) {
      return drop(seenAsRepost || isRepost ? "duplicate-repost" : "duplicate");
    }
    seenIds.set(key, isRepost);
    stats.kept += 1;
    if (isMediaOnly(item)) stats.flagged.mediaOnly += 1;
    return null;
  };

  return {
    check,
    keep: (item: FeedItem): boolean => check(item) === null,
    get stats(): HardFilterStats {
      return copyStats(stats);
    },
    snapshot(): HardFilterState {
      return { seen: [...seenIds], stats: copyStats(stats) };
    },
  };
}
