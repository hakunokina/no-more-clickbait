import type { HardFilter } from "./pipeline.js";
import type { Post } from "./schemas.js";

/**
 * The code-only hard filter: drops what needs no judgement and counts
 * why. It is stateful across one run — `keep` is called once per post
 * in feed order, across every captured response, so a post repeated by
 * an overlapping response (or the same original reposted again) is
 * dropped after its first appearance.
 *
 * Media-only posts (no text of their own) cannot be judged from text,
 * but they are KEPT and counted as flagged (owner's decision); the
 * Post carries `mediaOnly` for later stages.
 */

export type HardFilterDropReason =
  /** Ads: the platform marked the post as promoted. */
  | "promoted"
  /** The same post id was already seen in this run. */
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
  /** Kept post ids → whether that kept appearance was a repost. */
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
  /** Post id → whether its kept appearance was a repost. */
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
    keep(post: Post): boolean {
      stats.seen += 1;
      if (post.promoted) return drop("promoted");
      const isRepost = post.repostedBy !== undefined;
      const seenAsRepost = seenIds.get(post.id);
      if (seenAsRepost !== undefined) {
        return drop(seenAsRepost || isRepost ? "duplicate-repost" : "duplicate");
      }
      seenIds.set(post.id, isRepost);
      stats.kept += 1;
      if (post.mediaOnly) stats.flagged.mediaOnly += 1;
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
