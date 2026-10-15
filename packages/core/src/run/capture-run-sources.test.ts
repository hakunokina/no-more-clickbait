import { describe, expect, it } from "vitest";
import { feedItemKey } from "../feed-item.js";
import type { GenericItem, InstagramPost, ScoreEntry } from "../schemas.js";
import {
  renderClickbaitTopMarkdown,
  renderSelectedMarkdown,
  type CaptureRunReport,
} from "./capture-run.js";

const ig: InstagramPost = {
  platform: "instagram",
  id: "1",
  url: "https://www.instagram.com/p/1/",
  authorHandle: "ig_user",
  caption: "Domates\nölçümleri",
  kind: "carousel",
  media: [],
  publishedAt: "2026-01-01T00:00:00.000Z",
  promoted: false,
};

const generic: GenericItem = {
  platform: "generic",
  id: "t3_a",
  sourceLabel: "reddit",
  community: "r/science",
  title: "Yürüyüş ve uyku",
  text: "Gövde",
  url: "https://www.reddit.com/r/science/comments/a/",
  domain: "reddit.com",
  promoted: false,
};

const unjudgedIg: InstagramPost = { ...ig, id: "2", caption: "", kind: "reel" };

function score(postId: string): ScoreEntry {
  return { postId, clickbaitScore: 0.2, readWorthinessScore: 0.8, checkWorthyClaim: null };
}

/** Only what the Markdown renderers read. */
const report = {
  selector: {
    maxClickbaitScore: 0.7,
    minReadWorthinessScore: 0.2,
    timelineSize: 5,
    candidates: 2,
  },
  selected: [ig, generic].map((post) => ({
    post,
    score: score(feedItemKey(post)),
    verification: null,
  })),
  unjudged: [unjudgedIg],
  scores: [score(feedItemKey(ig)), score(feedItemKey(generic))],
  distribution: { scored: 2 },
} as unknown as CaptureRunReport;

describe("run Markdown with non-X items", () => {
  it("labels each item by its source and shows caption / title + text", () => {
    const markdown = renderSelectedMarkdown(report);
    expect(markdown).toContain("## 1. ig @ig_user — okuma 8/10");
    expect(markdown).toContain("> Domates ölçümleri");
    expect(markdown).toContain("## 2. reddit r/science — okuma 8/10");
    expect(markdown).toContain("> **Yürüyüş ve uyku** — Gövde");
    expect(markdown).toContain("## 1. ig @ig_user — reel");
  });

  it("finds non-X posts for the clickbait top by their key", () => {
    const top = renderClickbaitTopMarkdown(report, [ig, generic]);
    expect(top).toContain("## 1. ig @ig_user");
    expect(top).toContain("## 2. reddit r/science");
  });
});
