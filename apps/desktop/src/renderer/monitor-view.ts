import type { CollectSourceOutcome } from "@nmc/core";
import { describeLink, formatCount } from "../shared/format.js";
import { messages, type DesktopMessages } from "../shared/i18n.js";
import {
  isRunActive,
  type CollectionSite,
  type DesktopStatus,
  type FeedProgress,
} from "../shared/status.js";

/**
 * What the monitor shows for a status, as plain data; renderer.ts only
 * copies it into the page. One ring and one title say where things
 * stand, the run's steps or the feeds sit under them, then one lead
 * line and a short count summary. Titles are the reading window's own
 * words, so both windows name a state the same way.
 */

export type Tone = "plain" | "ok" | "warn" | "bad";

export type RingView =
  | { kind: "icon"; icon: "feed" | "plug" }
  | {
      kind: "progress";
      /** How much of the ring is filled, 0–100. */
      percent: number;
      value: string;
      caption: string;
      /** Spoken in place of the ring; null when the title already says it. */
      label: string | null;
    };

export interface PillView {
  text: string;
  state: "done" | "now" | "next" | "warn";
  /** Read out before the text ("Done: "); the icon alone is not enough. */
  spoken: string;
}

export interface SiteRowView {
  name: string;
  state: "done" | "now" | "next" | "warn" | "bad";
  /**
   * Read out before the name, as on the pills — but only for a site that
   * went wrong ("Incomplete: "): "Done", "Collecting" and "Waiting" are
   * already in its state, and saying them twice only makes it longer.
   */
  spoken: string;
  /** The site's state in words, with its items once it has finished. */
  status: string;
}

export interface SitesView {
  /** "Custom sites · 2/5 done", and how many went wrong. */
  title: string;
  problem: boolean;
  rows: SiteRowView[];
  /** Listed open at first: few enough not to push the buttons down. */
  open: boolean;
}

export interface MonitorView {
  /** Null: no ring (an error says so in words instead). */
  ring: RingView | null;
  title: string;
  tone: Tone;
  pills: PillView[];
  /** The collection's custom sites (null: none, or an extension that does not report them). */
  sites: SitesView | null;
  lead: string;
  /** Labelled counts under the buttons (empty: none to show). */
  summary: { label: string; value: string }[];
  /** Show the app's tagline (nothing has happened yet). */
  tagline: boolean;
  link: { text: string; tone: Tone };
}

/** The run's steps in order; checking the CLI comes before the first. */
const STEPS = [
  ["filtering", "stepFilter"],
  ["scoring", "stepScore"],
  ["verifying", "stepVerify"],
  ["rendering", "stepWrite"],
] as const;

/** A whole percentage of `whole`, at most 100. */
function percent(part: number, whole: number): number {
  return Math.round(Math.min(1, part / whole) * 100);
}

function spoken(m: DesktopMessages, state: SiteRowView["state"]): string {
  return state === "done"
    ? m.stepDone
    : state === "now"
      ? m.stepCurrent
      : state === "next"
        ? m.stepWaiting
        : m.stepIncomplete;
}

function pill(m: DesktopMessages, text: string, state: PillView["state"]): PillView {
  return { text, state, spoken: spoken(m, state) };
}

function runView(
  status: DesktopStatus,
  m: DesktopMessages,
): Pick<MonitorView, "ring" | "title" | "pills"> {
  const { stage, counts } = status.run;
  const count = (value: number) => formatCount(value, status.lang);
  const at = STEPS.findIndex(([step]) => step === stage);
  const verifying = stage === "verifying" && counts.verifyTotal > 0;
  const within = verifying ? Math.min(1, counts.verifyDone / counts.verifyTotal) : 0;
  const filled = percent(Math.max(at, 0) + within, STEPS.length);
  const posts = counts.afterHardFilter ?? counts.postsIn;
  const ring: RingView = verifying
    ? {
        kind: "progress",
        percent: filled,
        value: `${count(counts.verifyDone)}/${count(counts.verifyTotal)}`,
        caption: m.unitClaims(counts.verifyTotal),
        label: m.claims(counts.verifyDone, counts.verifyTotal),
      }
    : {
        kind: "progress",
        percent: filled,
        value: posts === null ? "" : count(posts),
        caption: posts === null ? "" : m.unitPosts(posts),
        label: posts === null ? null : m.posts(posts),
      };
  const title =
    stage === "scoring"
      ? m.prepScoring
      : stage === "verifying"
        ? m.prepVerifying
        : stage === "rendering"
          ? m.prepRendering
          : m.preparingTitle;
  const pills = STEPS.map(([, key], index) =>
    pill(m, m[key], index < at ? "done" : index === at ? "now" : "next"),
  );
  return { ring, title, pills };
}

function feedPills(
  m: DesktopMessages,
  feeds: readonly FeedProgress[],
  target: number | null,
): PillView[] {
  // Feeds are scrolled one after the other: the last one reporting is under way.
  let current = 0;
  feeds.forEach((feed, index) => {
    if (feed.count !== null) current = index;
  });
  return feeds.map((feed, index) =>
    pill(
      m,
      m.feedCountsLine([feed], target),
      index < current ? "done" : index === current ? "now" : "next",
    ),
  );
}

function collectingRing(status: DesktopStatus, m: DesktopMessages): RingView {
  const { collection } = status;
  const feeds = collection.sources;
  // Custom sites alone: nothing is counted while they are read.
  if (feeds && feeds.length === 0) return { kind: "icon", icon: "feed" };
  const counted = feeds ? feeds.filter((feed) => feed.count !== null) : [];
  const sum = feeds
    ? counted.length === 0
      ? null
      : counted.reduce((total, feed) => total + (feed.count ?? 0), 0)
    : collection.count;
  if (sum === null) return { kind: "icon", icon: "feed" };
  const target = collection.target === null ? null : collection.target * (feeds?.length ?? 1);
  return {
    kind: "progress",
    percent: target ? percent(sum, target) : 0,
    value: formatCount(sum, status.lang),
    caption: target ? `/ ${formatCount(target, status.lang)}` : m.unitPosts(sum),
    label: m.soFar(sum, target),
  };
}

function outcomePills(
  m: DesktopMessages,
  outcomes: readonly CollectSourceOutcome[],
): PillView[] {
  return outcomes.map((outcome) =>
    pill(
      m,
      m.feedCountsLine(
        [{ source: outcome.source, count: outcome.uniquePostCount }],
        outcome.target ?? null,
      ),
      outcome.reason === "target-reached" ? "done" : "warn",
    ),
  );
}

/** Up to this many sites are listed open; more fold under their title. */
const OPEN_SITES = 3;

const SITE_STATES: Readonly<Record<CollectionSite["status"], SiteRowView["state"]>> = {
  waiting: "next",
  collecting: "now",
  ok: "done",
  empty: "warn",
  error: "bad",
  timeout: "warn",
  skipped: "warn",
};

function sitesView(status: DesktopStatus, m: DesktopMessages): SitesView | null {
  const sites = status.collection.sites ?? [];
  if (sites.length === 0) return null;
  const rows = sites.map((site): SiteRowView => {
    const state = SITE_STATES[site.status];
    const finished = state !== "now" && state !== "next";
    // Items count once the site is done; a failed site with none needs no "0 items".
    const items = site.status === "ok" || (finished && site.itemCount > 0);
    return {
      name: site.name,
      state,
      spoken: state === "warn" || state === "bad" ? spoken(m, state) : "",
      status: items
        ? `${m.siteStatus(site.status)} · ${m.siteItems(site.itemCount)}`
        : m.siteStatus(site.status),
    };
  });
  const done = rows.filter((row) => row.state !== "now" && row.state !== "next").length;
  const problems = rows.filter((row) => row.state === "warn" || row.state === "bad").length;
  const title = m.sitesTitle(done, rows.length);
  return {
    title: problems > 0 ? `${title} · ${m.sitesProblems(problems)}` : title,
    problem: problems > 0,
    rows,
    open: rows.length <= OPEN_SITES,
  };
}

function summary(status: DesktopStatus, m: DesktopMessages): MonitorView["summary"] {
  const { counts } = status.run;
  const count = (value: number | null) => formatCount(value, status.lang);
  const rows: MonitorView["summary"] = [];
  const collected = counts.afterHardFilter ?? counts.postsIn;
  if (counts.selected !== null) {
    rows.push({
      label: m.statKept,
      value: `${count(counts.selected)} / ${count(counts.postsIn)}`,
    });
  } else if (collected !== null) {
    rows.push({ label: m.statCollected, value: count(collected) });
  }
  if (counts.filteredOut !== null) {
    rows.push({ label: m.statFilteredOut, value: count(counts.filteredOut) });
  }
  if (counts.verifyTotal > 0) {
    rows.push({
      label: m.statVerified,
      value: `${count(counts.verifyDone)} / ${count(counts.verifyTotal)}`,
    });
  }
  return rows;
}

function linkTone(status: DesktopStatus): Tone {
  const { link } = status;
  if (link.error) return "bad";
  if (!link.listening) return "plain";
  return link.hosts === 0 ? "warn" : "ok";
}

export function monitorView(status: DesktopStatus): MonitorView {
  const m = messages(status.lang);
  const { run, collection, pending } = status;
  const base: MonitorView = {
    ring: null,
    title: "",
    tone: "plain",
    pills: [],
    sites: null,
    lead: "",
    summary: [],
    tagline: false,
    link: { text: describeLink(status), tone: linkTone(status) },
  };
  const counted = { ...base, summary: summary(status, m) };

  if (isRunActive(run.stage)) {
    return { ...counted, ...runView(status, m), lead: m.preparingLead };
  }
  if (collection.state === "requested") {
    return { ...base, ring: { kind: "icon", icon: "feed" }, title: m.collectRequested };
  }
  if (collection.state === "collecting" || collection.state === "cancelling") {
    const feeds = collection.sources;
    return {
      ...base,
      ring: collectingRing(status, m),
      title: collection.state === "cancelling" ? m.collectCancelling : m.collectingTitle,
      pills: feeds && feeds.length > 0 ? feedPills(m, feeds, collection.target) : [],
      sites: sitesView(status, m),
    };
  }
  if (pending) {
    const outcomes = pending.sources ?? [];
    const target =
      outcomes.length > 0
        ? outcomes.reduce((total, outcome) => total + (outcome.target ?? 0), 0)
        : (pending.target ?? 0);
    return {
      ...base,
      ring: {
        kind: "progress",
        percent: target > 0 ? percent(pending.uniquePostCount, target) : 100,
        value: formatCount(pending.uniquePostCount, status.lang),
        caption: m.unitPosts(pending.uniquePostCount),
        label: null,
      },
      title: m.pendingTitle(pending.uniquePostCount),
      pills: outcomePills(m, outcomes),
      sites: sitesView(status, m),
      lead:
        outcomes.length > 0
          ? m.pendingFeeds(pending.mode, outcomes)
          : pending.mode === "A"
            ? m.pendingModeA(pending.uniquePostCount)
            : m.pendingModeB(pending.reason, pending.uniquePostCount),
    };
  }
  if (run.stage === "error") {
    return {
      ...counted,
      title: m.runError,
      tone: "bad",
      lead: run.sessionId === null ? "" : m.keptPosts,
    };
  }
  if (run.stage === "cancelled") {
    return {
      ...counted,
      ring: { kind: "icon", icon: "feed" },
      title: m.runCancelled,
      lead: run.sessionId === null ? "" : m.cancelledLead,
    };
  }
  if (run.stage === "ready") {
    if (run.timelineGone) {
      return {
        ...base,
        ring: { kind: "icon", icon: "feed" },
        title: m.goneTitle,
        lead: m.goneLead,
      };
    }
    const kept = run.counts.selected;
    return {
      ...counted,
      ring:
        kept === null
          ? { kind: "icon", icon: "feed" }
          : {
              kind: "progress",
              percent: 100,
              value: formatCount(kept, status.lang),
              caption: m.unitPosts(kept),
              label: null,
            },
      title: m.readyTitle,
      tone: "ok",
      lead: kept === null ? "" : m.readyCount(kept),
    };
  }
  // Nothing under way: the link must be open before anything can be collected.
  if (!status.link.listening || status.link.error) {
    return { ...base, ring: { kind: "icon", icon: "plug" }, title: m.linkWaiting };
  }
  return {
    ...base,
    ring: { kind: "icon", icon: "feed" },
    title: m.emptyTitle,
    lead: m.emptyLead,
    tagline: true,
  };
}
