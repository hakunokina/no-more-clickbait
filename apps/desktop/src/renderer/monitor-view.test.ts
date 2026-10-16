import { describe, expect, it } from "vitest";
import { note } from "../shared/i18n.js";
import { initialStatus, type DesktopStatus } from "../shared/status.js";
import { monitorView } from "./monitor-view.js";

function status(mutate: (status: DesktopStatus) => void): DesktopStatus {
  const next = initialStatus();
  next.link = { listening: true, hosts: 1, error: null };
  mutate(next);
  return next;
}

describe("monitorView", () => {
  it("starts empty, with the tagline and a connected link", () => {
    const view = monitorView(status(() => undefined));
    expect(view).toMatchObject({
      ring: { kind: "icon", icon: "feed" },
      title: "No timeline yet",
      tagline: true,
      summary: [],
      link: { text: "Browser extension connected.", tone: "ok" },
    });
  });

  it("waits for the browser link before anything else when idle", () => {
    expect(monitorView(initialStatus())).toMatchObject({
      ring: { kind: "icon", icon: "plug" },
      title: "Waiting for the browser extension…",
      tagline: false,
      link: { text: "Opening the browser link…", tone: "plain" },
    });
    const failed = status(
      (s) => (s.link = { listening: false, hosts: 0, error: note("linkUnavailable") }),
    );
    expect(monitorView(failed).link.tone).toBe("bad");
    const noBrowser = status((s) => (s.link.hosts = 0));
    expect(monitorView(noBrowser)).toMatchObject({
      title: "No timeline yet",
      link: { tone: "warn" },
    });
  });

  it("fills the ring with every feed's posts and marks the feed under way", () => {
    const view = monitorView(
      status((s) => {
        s.collection = {
          state: "collecting",
          message: null,
          target: 250,
          count: null,
          sources: [
            { source: "x", count: 120 },
            { source: "instagram", count: null },
          ],
        };
      }),
    );
    expect(view.title).toBe("Collecting posts");
    expect(view.ring).toEqual({
      kind: "progress",
      percent: 24,
      value: "120",
      caption: "/ 500",
      label: "120 of 500 posts so far.",
    });
    expect(view.pills.map(({ text, state }) => [text, state])).toEqual([
      ["X 120 / 250", "now"],
      ["Instagram 0 / 250", "next"],
    ]);
    expect(view.pills[1]?.spoken).toBe("Up next: ");
  });

  it("counts X alone without feed pills; custom sites alone show no count", () => {
    const xAlone = monitorView(
      status((s) => {
        s.collection = { state: "collecting", message: null, target: 100, count: 25 };
      }),
    );
    expect(xAlone.ring).toMatchObject({ kind: "progress", percent: 25, value: "25" });
    expect(xAlone.pills).toEqual([]);
    const sitesOnly = monitorView(
      status((s) => {
        s.collection = {
          state: "collecting",
          message: null,
          target: 100,
          count: null,
          sources: [],
        };
      }),
    );
    expect(sitesOnly.ring).toEqual({ kind: "icon", icon: "feed" });
  });

  it("shows a pending collection with each feed's outcome and the build question", () => {
    const view = monitorView(
      status((s) => {
        s.pending = {
          sessionId: "2026-01-01T10-00-00-000Z-ab12",
          uniquePostCount: 290,
          mode: "B",
          reason: "not-logged-in",
          target: 250,
          sources: [
            { source: "x", uniquePostCount: 250, reason: "target-reached", target: 250 },
            { source: "instagram", uniquePostCount: 40, reason: "not-logged-in", target: 250 },
          ],
        };
      }),
    );
    expect(view).toMatchObject({
      title: "290 posts collected",
      ring: { kind: "progress", percent: 58, value: "290", caption: "posts", label: null },
    });
    expect(view.pills.map(({ text, state }) => [text, state])).toEqual([
      ["X 250 / 250", "done"],
      ["Instagram 40 / 250", "warn"],
    ]);
    // Not by colour or icon alone: a short feed is read out as incomplete.
    expect(view.pills[1]?.spoken).toBe("Incomplete: ");
    expect(view.lead).toContain("Build the timeline anyway?");
  });

  it("follows the run's steps; verifying fills the ring by checked claims", () => {
    const view = monitorView(
      status((s) => {
        s.run.stage = "verifying";
        s.run.sessionId = "2026-01-01T10-00-00-000Z-ab12";
        s.run.counts = {
          ...s.run.counts,
          postsIn: 290,
          afterHardFilter: 268,
          filteredOut: 171,
          verifyDone: 6,
          verifyTotal: 12,
        };
      }),
    );
    expect(view.title).toBe("Checking the claims worth verifying");
    expect(view.ring).toEqual({
      kind: "progress",
      percent: 63,
      value: "6/12",
      caption: "claims",
      label: "6 / 12 claims",
    });
    expect(view.pills.map(({ text, state }) => [text, state])).toEqual([
      ["Filtering", "done"],
      ["Scoring", "done"],
      ["Verifying", "now"],
      ["Writing", "next"],
    ]);
    expect(view.lead).toBe(
      "You can close this window; the tray lets you know when it is ready.",
    );
    expect(view.summary).toEqual([
      { label: "Collected", value: "268" },
      { label: "Filtered out", value: "171" },
      { label: "Verified claims", value: "6 / 12" },
    ]);
  });

  it("is ready with the kept posts, in Turkish too", () => {
    const ready = status((s) => {
      s.lang = "tr";
      s.run.stage = "ready";
      s.run.hasTimeline = true;
      s.run.counts = { ...s.run.counts, postsIn: 1290, selected: 42, filteredOut: 214 };
    });
    expect(monitorView(ready)).toMatchObject({
      title: "Akış hazır",
      tone: "ok",
      ring: { kind: "progress", percent: 100, value: "42", caption: "gönderi" },
      lead: "42 gönderi.",
      summary: [
        { label: "Kalan / görülen gönderi", value: "42 / 1.290" },
        { label: "Elenen", value: "214" },
      ],
    });
    ready.run.timelineGone = true;
    expect(monitorView(ready)).toMatchObject({ title: "Akış artık yok", summary: [] });
  });

  it("says a failed run keeps its posts, without a ring", () => {
    const view = monitorView(
      status((s) => {
        s.run.stage = "error";
        s.run.sessionId = "2026-01-01T10-00-00-000Z-ab12";
      }),
    );
    expect(view).toMatchObject({
      ring: null,
      tone: "bad",
      title: "The timeline could not be prepared",
      lead: "The collected posts are kept; trying again does not collect again.",
    });
  });

  it("lists each custom site with its state in words and its items", () => {
    const collecting = status((s) => {
      s.collection = {
        state: "collecting",
        message: null,
        target: 250,
        count: null,
        sources: [{ source: "x", count: 40 }],
        sites: [
          { siteId: "a", name: "Local News", status: "ok", itemCount: 12 },
          { siteId: "b", name: "b.example", status: "collecting", itemCount: 0 },
          { siteId: "c", name: "Slow Blog", status: "timeout", itemCount: 3 },
        ],
      };
    });
    expect(monitorView(collecting).sites).toEqual({
      title: "Custom sites · 2/3 done · 1 problem",
      problem: true,
      open: true,
      rows: [
        { name: "Local News", state: "done", spoken: "", status: "Done · 12 items" },
        { name: "b.example", state: "now", spoken: "", status: "Collecting" },
        {
          name: "Slow Blog",
          state: "warn",
          spoken: "Incomplete: ",
          status: "Timed out · 3 items",
        },
      ],
    });
  });

  it("folds five sites, in Turkish, and words every outcome", () => {
    const view = monitorView(
      status((s) => {
        s.lang = "tr";
        s.collection = {
          state: "collecting",
          message: null,
          target: null,
          count: null,
          sources: [],
          sites: [
            { siteId: "a", name: "A", status: "waiting", itemCount: 0 },
            { siteId: "b", name: "B", status: "ok", itemCount: 1 },
            { siteId: "c", name: "C", status: "empty", itemCount: 0 },
            { siteId: "d", name: "D", status: "error", itemCount: 0 },
            { siteId: "e", name: "E", status: "skipped", itemCount: 0 },
          ],
        };
      }),
    );
    expect(view.sites).toEqual({
      title: "Özel siteler · 4/5 bitti · 3 sorun",
      problem: true,
      open: false,
      rows: [
        { name: "A", state: "next", spoken: "", status: "Sırada" },
        { name: "B", state: "done", spoken: "", status: "Bitti · 1 öğe" },
        { name: "C", state: "warn", spoken: "Eksik: ", status: "Öğe yok" },
        { name: "D", state: "bad", spoken: "Eksik: ", status: "Okunamadı" },
        { name: "E", state: "warn", spoken: "Eksik: ", status: "Atlandı" },
      ],
    });
  });

  it("says a site's state once to a screen reader, never as prefix and state both", () => {
    const statuses = [
      "waiting",
      "collecting",
      "ok",
      "empty",
      "error",
      "timeout",
      "skipped",
    ] as const;
    for (const lang of ["en", "tr"] as const) {
      const view = monitorView(
        status((s) => {
          s.lang = lang;
          s.collection = {
            state: "collecting",
            message: null,
            target: null,
            count: null,
            sources: [],
            sites: statuses.map((st) => ({
              siteId: st,
              name: "Site",
              status: st,
              itemCount: 2,
            })),
          };
        }),
      );
      for (const row of view.sites?.rows ?? []) {
        // What the row reads out: prefix, name, state — no word of the prefix again.
        const words = (text: string) => text.toLowerCase().match(/\p{L}+/gu) ?? [];
        const state = new Set(words(row.status));
        expect(
          words(row.spoken).filter((word) => state.has(word)),
          `${lang} ${row.state}: ${row.spoken}${row.status}`,
        ).toEqual([]);
      }
    }
  });

  it("keeps the finished sites while the collection waits for Build, none without the data", () => {
    const pending = status((s) => {
      s.pending = {
        sessionId: "s1",
        uniquePostCount: 7,
        mode: "A",
        reason: "target-reached",
        target: null,
        sources: [],
      };
      s.collection.sites = [{ siteId: "a", name: "A", status: "ok", itemCount: 7 }];
    });
    expect(monitorView(pending).sites).toMatchObject({
      title: "Custom sites · 1/1 done",
      problem: false,
    });
    // An extension that does not report its sites: no list, as before.
    delete pending.collection.sites;
    expect(monitorView(pending).sites).toBeNull();
    // Nothing collecting or waiting: the list is not the monitor's to show.
    const ready = status((s) => {
      s.run.stage = "ready";
      s.collection.sites = [{ siteId: "a", name: "A", status: "ok", itemCount: 7 }];
    });
    expect(monitorView(ready).sites).toBeNull();
  });

  it("writes the verified claims' counts in the shown language", () => {
    const view = monitorView(
      status((s) => {
        s.lang = "tr";
        s.run.stage = "verifying";
        s.run.counts = { ...s.run.counts, verifyDone: 1200, verifyTotal: 1500 };
      }),
    );
    expect(view.summary).toContainEqual({ label: "Doğrulanan iddia", value: "1.200 / 1.500" });
  });
});
