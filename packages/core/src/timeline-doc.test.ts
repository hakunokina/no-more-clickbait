import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FunnelCounts } from "./metrics.js";
import type { Post, RankedPost } from "./schemas.js";
import {
  errorTimelineDoc,
  postWordCount,
  scoreLevel,
  scoreOutOfTen,
  TimelineDocSchema,
  toTimelineDoc,
} from "./timeline-doc.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "timeline-doc.json",
);

function post(id: string, overrides: Partial<Post> = {}): Post {
  return {
    id,
    source: "synthetic",
    authorHandle: `user_${id}`,
    text: `two words`,
    url: `https://example.invalid/posts/${id}`,
    publishedAt: "2026-01-01T00:00:00.000Z",
    media: [],
    promoted: false,
    ...overrides,
  };
}

function ranked(id: string, overrides: Partial<Post> = {}): RankedPost {
  return {
    post: post(id, overrides),
    score: {
      postId: id,
      clickbaitScore: 0.2,
      readWorthinessScore: 0.8,
      checkWorthyClaim: null,
    },
    verification: null,
  };
}

function funnel(shown: number, extra: Partial<FunnelCounts> = {}): FunnelCounts {
  const counts = {
    ads: 1,
    duplicates: 0,
    mediaOnly: 0,
    scoringFailed: 0,
    clickbait: 2,
    belowReadFloor: 0,
    contradicted: 0,
    rankedOut: 0,
    shown,
    ...extra,
  };
  return { scanned: Object.values(counts).reduce((a, b) => a + b, 0), ...counts };
}

const now = new Date("2026-01-01T10:00:00.000Z");

describe("scoreLevel", () => {
  it("maps 0..1 onto five word levels on the 0-10 scale", () => {
    expect([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1].map(scoreLevel)).toEqual([
      "very-low",
      "very-low",
      "low",
      "low",
      "medium",
      "medium",
      "high",
      "high",
      "very-high",
      "very-high",
    ]);
  });

  it("rounds down, like the Settings thresholds", () => {
    expect([0.19, 0.58, 0.79].map(scoreLevel)).toEqual(["very-low", "medium", "high"]);
  });
});

describe("scoreOutOfTen", () => {
  it("floors onto 0-10, immune to float error", () => {
    expect([0, 0.68, 0.7, 0.3, 0.91, 1].map(scoreOutOfTen)).toEqual([0, 6, 7, 3, 9, 10]);
    expect(scoreOutOfTen(7 / 10)).toBe(7);
    expect(scoreOutOfTen(0.1 * 3)).toBe(3);
  });
});

describe("toTimelineDoc", () => {
  it("ranks cards in order, adds levels and counts own + quoted words", () => {
    const doc = toTimelineDoc(
      {
        selected: [
          ranked("a"),
          ranked("b", {
            text: "one",
            quoted: { id: "q", authorHandle: "q", text: "three more words" },
          }),
        ],
        funnel: funnel(2),
        settings: { timelineSize: 2 },
        collection: { lastCapturedAt: "2026-01-01T09:00:00.000Z" },
      },
      now,
    );
    expect(doc.header).toEqual({
      generatedAt: "2026-01-01T10:00:00.000Z",
      capturedAt: "2026-01-01T09:00:00.000Z",
      timelineSize: 2,
      wordCount: 6,
    });
    expect(doc.cards.map((c) => [c.rank, c.post.id, c.levels])).toEqual([
      [1, "a", { readValue: "very-high", clickbait: "low" }],
      [2, "b", { readValue: "very-high", clickbait: "low" }],
    ]);
    expect(doc.status).toEqual({ state: "ok" });
  });

  it("reports short and empty timelines honestly", () => {
    const short = toTimelineDoc(
      { selected: [ranked("a")], funnel: funnel(1), settings: { timelineSize: 5 } },
      now,
    );
    expect(short.status).toEqual({ state: "short" });
    expect(short.header).not.toHaveProperty("capturedAt");
    const empty = toTimelineDoc(
      { selected: [], funnel: funnel(0), settings: { timelineSize: 5 } },
      now,
    );
    expect(empty.status).toEqual({ state: "empty" });
    expect(empty.header.wordCount).toBe(0);
  });

  it("refuses a contradicted card and a funnel that disagrees with the cards", () => {
    const contradicted: RankedPost = {
      ...ranked("a"),
      verification: {
        postId: "a",
        claim: "c",
        status: "false_or_disputed",
        confidence: 0.8,
        summary: "çelişiyor",
        sources: [{ url: "https://example.org/s", title: "s" }],
      },
    };
    expect(() =>
      toTimelineDoc(
        { selected: [contradicted], funnel: funnel(1), settings: { timelineSize: 1 } },
        now,
      ),
    ).toThrow(/contradicted/);
    expect(() =>
      toTimelineDoc({
        selected: [ranked("a")],
        funnel: funnel(2),
        settings: { timelineSize: 1 },
      }),
    ).toThrow(/funnel.shown/);
  });

  it("carries the per-source split and missing sources, omitting them when absent", () => {
    const bySource = [
      { label: "x", in: 3, shown: 2 },
      { label: "reddit", in: 2, shown: 0 },
    ];
    const missingSources = [{ label: "instagram", reason: "Instagram toplanamadı" }];
    const source = {
      selected: [ranked("a"), ranked("b")],
      funnel: funnel(2),
      settings: { timelineSize: 2 },
    };
    const doc = toTimelineDoc({ ...source, metrics: { bySource }, missingSources }, now);
    expect(doc.bySource).toEqual(bySource);
    expect(doc.missingSources).toEqual(missingSources);
    expect(TimelineDocSchema.parse(doc)).toEqual(doc);
    const plain = toTimelineDoc({ ...source, missingSources: [] }, now);
    expect(plain).not.toHaveProperty("bySource");
    expect(plain).not.toHaveProperty("missingSources");
  });

  it("refuses repeated source labels and a source both delivered and missing", () => {
    const source = {
      selected: [ranked("a"), ranked("b")],
      funnel: funnel(2),
      settings: { timelineSize: 2 },
    };
    const twice = [
      { label: "x", in: 3, shown: 2 },
      { label: "x", in: 2, shown: 0 },
    ];
    expect(() => toTimelineDoc({ ...source, metrics: { bySource: twice } }, now)).toThrow(
      /bySource labels must be unique/,
    );
    expect(() =>
      toTimelineDoc(
        { ...source, missingSources: [{ label: "reddit" }, { label: "reddit" }] },
        now,
      ),
    ).toThrow(/missingSources labels must be unique/);
    expect(() =>
      toTimelineDoc(
        {
          ...source,
          metrics: { bySource: [{ label: "x", in: 5, shown: 2 }] },
          missingSources: [{ label: "x" }],
        },
        now,
      ),
    ).toThrow(/both in bySource and missingSources/);
  });

  it("refuses a per-source split that does not add up to the funnel", () => {
    const source = {
      selected: [ranked("a"), ranked("b")],
      funnel: funnel(2),
      settings: { timelineSize: 2 },
    };
    expect(() =>
      toTimelineDoc(
        { ...source, metrics: { bySource: [{ label: "x", in: 4, shown: 2 }] } },
        now,
      ),
    ).toThrow(/funnel.scanned/);
    expect(() =>
      toTimelineDoc(
        { ...source, metrics: { bySource: [{ label: "x", in: 5, shown: 1 }] } },
        now,
      ),
    ).toThrow(/card count/);
  });
});

describe("errorTimelineDoc", () => {
  it("builds an error document, with or without counts", () => {
    const doc = errorTimelineDoc(
      { reason: "Claude'a ulaşılamadı.", detail: "CliNotFoundError", timelineSize: 10 },
      now,
    );
    expect(doc.status).toEqual({
      state: "error",
      reason: "Claude'a ulaşılamadı.",
      detail: "CliNotFoundError",
    });
    expect(doc.funnel).toBeNull();
    expect(doc.cards).toEqual([]);
    expect(TimelineDocSchema.safeParse({ ...doc, status: { state: "ok" } }).success).toBe(
      false,
    );
  });
});

describe("synthetic timeline-doc.json fixture (renderer input)", () => {
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  const doc = TimelineDocSchema.parse(raw);

  it("is a valid TimelineDoc whose funnel adds up", () => {
    const { scanned, ...buckets } = doc.funnel ?? { scanned: -1 };
    expect(Object.values(buckets).reduce((a, b) => a + b, 0)).toBe(scanned);
    expect(doc.header.wordCount).toBe(
      doc.cards.reduce((sum, card) => sum + postWordCount(card.post), 0),
    );
  });

  it("covers every shape the renderer draws", () => {
    const media = doc.cards.flatMap((c) => c.post.media);
    const photosPerCard = doc.cards.map(
      (c) => c.post.media.filter((m) => m.type === "photo").length,
    );
    expect(new Set(photosPerCard)).toEqual(new Set([0, 1, 3, 4]));
    expect(media.some((m) => m.type === "video" && m.durationMs && m.variants?.length)).toBe(
      true,
    );
    expect(media.some((m) => m.type === "gif" && m.variants?.length)).toBe(true);
    expect(media.some((m) => m.type === "link" && m.card?.image)).toBe(true);
    expect(media.some((m) => m.type === "link" && !m.card)).toBe(true);
    expect(media.filter((m) => m.type !== "link").every((m) => m.width && m.height)).toBe(true);
    expect(doc.cards.some((c) => c.post.quoted?.media?.length)).toBe(true);
    expect(doc.cards.some((c) => c.post.quoted && !c.post.quoted.authorName)).toBe(true);
    expect(doc.cards.some((c) => c.post.repostedBy)).toBe(true);
    expect(doc.cards.some((c) => !c.post.authorAvatarUrl)).toBe(true);
    expect(doc.cards.some((c) => c.post.text.length > 600)).toBe(true);
    expect(doc.cards.map((c) => c.verification?.status ?? null)).toEqual(
      expect.arrayContaining(["verified", "unverifiable", null]),
    );
  });

  it("holds synthetic content only (reserved domains and synthetic accounts)", () => {
    const text = JSON.stringify(raw);
    for (const match of text.matchAll(/https:\/\/([^/"]+)/g)) {
      expect(match[1]).toMatch(
        /(\.example\.invalid|^pbs\.twimg\.com|^video\.twimg\.com|^x\.com)$/,
      );
    }
    for (const card of doc.cards) expect(card.post.authorHandle).toMatch(/^synthetic_/);
  });
});
