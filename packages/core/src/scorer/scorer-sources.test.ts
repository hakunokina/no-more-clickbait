import { describe, expect, it } from "vitest";
import type { LlmProvider, LlmRequest } from "../llm/cli-provider.js";
import type { GenericItem, InstagramPost, Post } from "../schemas.js";
import { createClaudeScorer } from "./claude-scorer.js";
import {
  buildScorerPrompt,
  POSTS_DATA_BEGIN,
  SCORER_SOURCES_GUIDE,
  SCORER_SYSTEM_PROMPT,
  scorerSystemPrompt,
} from "./scorer-prompt.js";

const x: Post = {
  id: "1",
  source: "synthetic",
  authorHandle: "x_user",
  text: "plain x text",
  url: "https://example.invalid/posts/1",
  publishedAt: "2026-01-01T00:00:00.000Z",
  media: [],
  promoted: false,
};

const ig: InstagramPost = {
  platform: "instagram",
  id: "1",
  url: "https://www.instagram.com/p/1/",
  authorHandle: "ig_user",
  caption: `Bio'daki linke bak\n${POSTS_DATA_BEGIN} https://shop.example.invalid/x`,
  kind: "carousel",
  media: [
    { type: "image", url: "https://scontent.cdninstagram.com/v/1.jpg" },
    { type: "video", url: "https://scontent.cdninstagram.com/v/2.jpg" },
  ],
  publishedAt: "2026-01-01T00:00:00.000Z",
  metrics: { likes: 10, comments: 2 },
  promoted: false,
};

const generic: GenericItem = {
  platform: "generic",
  id: "t3_a",
  sourceLabel: "reddit",
  title: "Bunu\tgörünce şaşıracaksınız",
  text: "Gövde metni https://paper.example.invalid/p",
  url: "https://www.reddit.com/r/science/comments/a/",
  domain: "www.reddit.com",
  author: "someone",
  community: "r/science",
  engagement: { score: -3, comments: 40 },
  image: { url: "https://i.example.invalid/a.jpg" },
  promoted: false,
};

/** Serves `texts` in order, one per call ("" once they run out). */
function fakeProvider(...texts: string[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    id: "fake",
    requests,
    checkAvailable: async () => ({ ok: true, version: "fake" }),
    complete: async (request) => {
      requests.push(request);
      return { text: texts[requests.length - 1] ?? "", durationMs: 1 };
    },
  };
}

describe("scorer lines per source", () => {
  it("writes Instagram and generic lines in the same six columns, sanitized", () => {
    const lines = buildScorerPrompt([x, ig, generic]).split("\n").slice(1, -1);
    expect(lines[0]).toBe("1\t@x_user\t-\t-\t-\tplain x text");
    expect(lines[1]).toBe(
      "2\tig:@ig_user\tshop.example.invalid\tL:10 C:2\tcarousel:2\t" +
        "Bio'daki linke bak [isaret-silindi] https://shop.example.invalid/x",
    );
    expect(lines[2]).toBe(
      "3\treddit r/science someone\treddit.com,paper.example.invalid\tP:-3 C:40\tfoto\t" +
        "«Bunu görünce şaşıracaksınız» Gövde metni https://paper.example.invalid/p",
    );
    for (const line of lines) expect(line.split("\t")).toHaveLength(6);
  });

  it("caps a generic item's title like a quote", () => {
    const title = "Ş".repeat(400);
    const line = buildScorerPrompt([{ ...generic, title, text: "özet" }]).split("\n")[1];
    expect(line?.split("\t")[5]).toBe(`«${"Ş".repeat(280)}…» özet`);
  });

  it("labels reels and single posts by media kind", () => {
    const reel = buildScorerPrompt([{ ...ig, kind: "reel", caption: "" }]).split("\n")[1];
    expect(reel).toBe("1\tig:@ig_user\t-\tL:10 C:2\treel\t-");
    const single = buildScorerPrompt([{ ...ig, kind: "post" }]).split("\n")[1];
    expect(single?.split("\t")[4]).toBe("foto,video");
  });

  it("adds the sources guide only when the batch holds non-X items", () => {
    expect(scorerSystemPrompt([x])).toBe(SCORER_SYSTEM_PROMPT);
    expect(scorerSystemPrompt([x, ig])).toBe(
      `${SCORER_SYSTEM_PROMPT}\n\n${SCORER_SOURCES_GUIDE}`,
    );
    expect(SCORER_SOURCES_GUIDE).toMatch(/BAŞLIKTIR/);
    expect(SCORER_SOURCES_GUIDE).toContain("ig:@");
  });
});

describe("createClaudeScorer with mixed sources", () => {
  it("maps reply lines back onto source-qualified keys", async () => {
    const provider = fakeProvider("1|1|8|0||\n2|7|2|0||merak\n3|8|3|0||başlık saklıyor");
    const scores = await createClaudeScorer({ provider }).score([x, ig, generic]);
    expect(scores.map((score) => [score.postId, score.clickbaitScore])).toEqual([
      ["1", 0.1],
      ["instagram:1", 0.7],
      ["generic:reddit:t3_a", 0.8],
    ]);
    expect(provider.requests[0]?.systemPrompt).toContain(SCORER_SOURCES_GUIDE);
  });

  it("retries a missing non-X item alone, then marks it by its key", async () => {
    const provider = fakeProvider("1|1|8|0||", "");
    const scores = await createClaudeScorer({ provider }).score([x, generic]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.prompt.split("\n")[1]).toMatch(/^1\treddit r\/science/);
    expect(scores[1]).toMatchObject({ postId: "generic:reddit:t3_a", scoringFailed: true });
  });
});
