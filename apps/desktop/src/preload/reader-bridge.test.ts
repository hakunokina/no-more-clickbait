import { describe, expect, it } from "vitest";
import { installReaderBridge, isReaderPage, READER_PAGE_ARG } from "./reader-bridge.js";

const READER = "file:///C:/App/dist/renderer/reader.html";
const TIMELINE = "file:///C:/Users/x/AppData/Local/NoMoreClickbait/sessions/s/timeline.html";

function harness(href: string) {
  const world: Record<string, unknown> = {};
  const invoked: string[] = [];
  let click: ((event: { target: unknown }) => void) | null = null;
  const exposed = installReaderBridge({
    href,
    argv: ["electron", `${READER_PAGE_ARG}${READER}`],
    ipc: {
      invoke: async (channel) => void invoked.push(channel),
      on: () => undefined,
      off: () => undefined,
    },
    bridge: { exposeInMainWorld: (key, api) => (world[key] = api) },
    document: { addEventListener: (_type, listener) => (click = listener) },
  });
  /** A click on an element carrying `data-action`. */
  const press = (action: string): void =>
    click?.({ target: { closest: () => ({ getAttribute: () => action }) } });
  return { world, invoked, exposed, press };
}

describe("reading window bridge", () => {
  it("exposes nothing to a timeline page's main world", () => {
    const { world, exposed } = harness(TIMELINE);
    expect(exposed).toBe(false);
    expect(world["nmc"]).toBeUndefined();
  });

  it("handles a timeline page's collect / retry buttons from the isolated world", () => {
    const { invoked, press } = harness(TIMELINE);
    press("collect");
    press("retry");
    press("something-else");
    expect(invoked).toEqual(["nmc:start-collection", "nmc:retry-run"]);
  });

  it("gives our own reader page the narrow API", () => {
    const { world, exposed } = harness(READER);
    expect(exposed).toBe(true);
    expect(Object.keys(world["nmc"] as object).sort()).toEqual([
      "buildTimeline",
      "cancelRun",
      "getStatus",
      "onStatus",
      "openReader",
      "retryRun",
      "startCollection",
    ]);
  });

  it("matches our page exactly: no query, hash or look-alike path", () => {
    expect(isReaderPage(READER, READER)).toBe(true);
    for (const href of [
      `${READER}?x=1`,
      `${READER}#a`,
      `${TIMELINE}?${READER}`,
      "file:///C:/App/dist/renderer/reader.html.evil",
      "file:///C:/Other/reader.html",
      "not a url",
    ]) {
      expect(isReaderPage(href, READER)).toBe(false);
    }
    expect(isReaderPage(READER, null)).toBe(false);
    expect(harness(`${READER}#x`).world["nmc"]).toBeUndefined();
  });
});
