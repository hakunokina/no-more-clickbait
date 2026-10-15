import type { Post } from "@nmc/core";

/**
 * Converts a raw X HomeTimeline GraphQL response into core Posts.
 *
 * SKELETON: returns [] for now. The exact response shape will be pinned
 * down from real captures made with this extension in the user's own
 * browser (captures stay on the user's machine, never in this repo);
 * the mapping lands in the follow-up "X connector" change together with
 * synthetic fixtures modelled on that shape.
 */
export function parseHomeTimeline(_payload: unknown): Post[] {
  return [];
}
