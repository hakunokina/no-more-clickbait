import { feedItemKey, isMediaOnly, isXPost } from "./feed-item.js";
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
 */

export type HardFilterDropReason =
  /** Ads: the platform marked the post as promoted. */
  | "promoted"
  /** The same item (source + id) was already seen in this run. */
  | "duplicate"
  /** The same original was already seen, at least once via a repost. */
  | "duplicate-repost";

export interface HardFilterStats {
  /** Posts offered to the filter. */
  seen: number;
  kept: number;
  dropped: Record<HardFilterDropReason, number>;
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

export interface CountingHardFilter extends HardFilter {
  /** Live counters for the current run (a snapshot copy). */
  readonly stats: HardFilterStats;
  /** A copy of the run state; pass it to `createHardFilter` to resume. */
  snapshot(): HardFilterState;
}

function copyStats(stats: HardFilterStats): HardFilterStats {
  return { ...stats, dropped: { ...stats.dropped }, flagged: { ...stats.flagged } };
}

export function createHardFilter(resume?: HardFilterState): CountingHardFilter {
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

  const drop = (reason: HardFilterDropReason): false => {
    stats.dropped[reason] += 1;
    return false;
  };

  return {
    keep(item: FeedItem): boolean {
      stats.seen += 1;
      if (item.promoted) return drop("promoted");
      const isRepost = isXPost(item) && item.repostedBy !== undefined;
      const key = feedItemKey(item);
      const seenAsRepost = seenIds.get(key);
      if (seenAsRepost !== undefined) {
        return drop(seenAsRepost || isRepost ? "duplicate-repost" : "duplicate");
      }
      seenIds.set(key, isRepost);
      stats.kept += 1;
      if (isMediaOnly(item)) stats.flagged.mediaOnly += 1;
      return true;
    },
    get stats(): HardFilterStats {
      return copyStats(stats);
    },
    snapshot(): HardFilterState {
      return { seen: [...seenIds], stats: copyStats(stats) };
    },
  };
}
