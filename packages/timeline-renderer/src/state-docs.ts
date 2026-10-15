import {
  errorTimelineDoc,
  feedSourceLabel,
  TimelineDocSchema,
  type TimelineDoc,
} from "@nmc/core";

/**
 * The renderer's four states derived from one full (ok) document, for
 * the local preview and the tests: the same cards, cut short or
 * dropped, with the funnel re-balanced so it still adds up.
 */
export interface StateDocs {
  ok: TimelineDoc;
  short: TimelineDoc;
  empty: TimelineDoc;
  error: TimelineDoc;
}

function withShown(doc: TimelineDoc, shown: number): TimelineDoc {
  if (!doc.funnel) throw new Error("the source doc needs a funnel");
  const dropped = doc.cards.length - shown + doc.funnel.rankedOut;
  const cards = doc.cards.slice(0, shown);
  const shownOf = (label: string) =>
    cards.filter((c) => feedSourceLabel(c.post) === label).length;
  return TimelineDocSchema.parse({
    ...doc,
    cards,
    ...(doc.bySource
      ? { bySource: doc.bySource.map((count) => ({ ...count, shown: shownOf(count.label) })) }
      : {}),
    // Fewer passed the read floor; nothing was ranked out of a short timeline.
    funnel: {
      ...doc.funnel,
      belowReadFloor: doc.funnel.belowReadFloor + dropped,
      rankedOut: 0,
      shown,
    },
    status: { state: shown === 0 ? "empty" : "short" },
  });
}

export function stateDocs(ok: TimelineDoc): StateDocs {
  const shortSize = Math.max(1, Math.min(ok.cards.length - 1, Math.ceil(ok.cards.length / 2)));
  return {
    ok,
    short: withShown(ok, shortSize),
    empty: withShown(ok, 0),
    error: errorTimelineDoc(
      {
        reason: "Claude 3 dakika içinde yanıt vermedi.",
        detail: "scorer: claude CLI zaman aşımı (180 sn)",
        timelineSize: ok.header.timelineSize,
        ...(ok.funnel ? { funnel: ok.funnel } : {}),
        ...(ok.header.capturedAt ? { capturedAt: ok.header.capturedAt } : {}),
      },
      new Date(ok.header.generatedAt),
    ),
  };
}
