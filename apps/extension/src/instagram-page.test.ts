// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  containsFeedConnection,
  hasFeedRoot,
  InstagramSsrCollector,
  isInstagramFeedQueryUrl,
  isInstagramHomePath,
} from "./instagram-page.js";

const ORIGIN = "https://www.instagram.com";
const KEY = "xdt_api__v1__feed__timeline__connection";

// Made-up feed shapes: no real ids, names or captions.
const blob = (connection: unknown): string =>
  JSON.stringify({
    require: [
      [
        "ScheduledServerJS",
        "handle",
        null,
        [{ __bbox: { result: { data: { [KEY]: connection } } } }],
      ],
    ],
  });

describe("isInstagramFeedQueryUrl", () => {
  it("matches only the page's own /graphql/query, whatever the doc_id", () => {
    expect(isInstagramFeedQueryUrl("/graphql/query", ORIGIN)).toBe(true);
    expect(
      isInstagramFeedQueryUrl("https://www.instagram.com/graphql/query/?x=1", ORIGIN),
    ).toBe(true);
    expect(isInstagramFeedQueryUrl("/api/graphql", ORIGIN)).toBe(false);
    expect(isInstagramFeedQueryUrl("https://evil.example/graphql/query", ORIGIN)).toBe(false);
    expect(isInstagramFeedQueryUrl("http://www.instagram.com/graphql/query", ORIGIN)).toBe(
      false,
    );
    expect(isInstagramFeedQueryUrl("http://[bad", ORIGIN)).toBe(false);
  });

  it("treats only the root path as the home feed", () => {
    expect(isInstagramHomePath("/")).toBe(true);
    expect(isInstagramHomePath("/explore/")).toBe(false);
    expect(isInstagramHomePath("/direct/inbox/")).toBe(false);
  });
});

describe("hasFeedRoot / containsFeedConnection", () => {
  it("keeps bodies with an object root, prefix or not; drops a null root", () => {
    expect(hasFeedRoot(`for (;;);{"data":{"${KEY}":{"edges":[]}}}`)).toBe(true);
    expect(hasFeedRoot(`{"data":{"${KEY}" : {}}}`)).toBe(true);
    expect(hasFeedRoot(`{"data":{"${KEY}":null}}`)).toBe(false);
    expect(hasFeedRoot(`{"data":{"other":{}}}`)).toBe(false);
  });

  it("finds the connection at any depth, never a null one", () => {
    expect(containsFeedConnection(JSON.parse(blob({ edges: [] })))).toBe(true);
    expect(containsFeedConnection(JSON.parse(blob(null)))).toBe(false);
    expect(containsFeedConnection({ [KEY]: [] })).toBe(false);
    expect(containsFeedConnection("text")).toBe(false);
  });
});

describe("InstagramSsrCollector", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    window.history.replaceState(null, "", "/");
  });

  const scripts = (): string =>
    [
      `<script type="application/json">${blob({ edges: [] })}</script>`,
      `<script type="application/json">${blob(null)}</script>`,
      `<script type="application/json">{"mentions":"${KEY}"}</script>`,
      `<script type="application/json">{"other":1}</script>`,
      `<script type="application/json">not json ${KEY}</script>`,
    ].join("");

  it("sends each embedded feed block once per run, and again after a restart", () => {
    window.history.replaceState(null, "", "/");
    document.head.innerHTML = scripts();
    const sent: [string, string][] = [];
    const collector = new InstagramSsrCollector(document, (operation, body) => {
      sent.push([operation, body]);
    });
    collector.watch();
    expect(sent).toEqual([]); // not running yet
    collector.start();
    collector.start();
    expect(sent).toEqual([["ssr", blob({ edges: [] })]]);
    collector.stop();
    collector.start();
    expect(sent).toHaveLength(2);
  });

  it("keeps the blocks picked at load even when the page drops them later", () => {
    document.head.innerHTML = scripts();
    const sent: string[] = [];
    const collector = new InstagramSsrCollector(document, (operation) => sent.push(operation));
    collector.watch();
    document.head.innerHTML = "";
    collector.start();
    expect(sent).toEqual(["ssr"]);
  });

  it("ignores pages other than the home feed", () => {
    window.history.replaceState(null, "", "/explore/");
    document.head.innerHTML = scripts();
    const sent: string[] = [];
    const collector = new InstagramSsrCollector(document, (operation) => sent.push(operation));
    collector.watch();
    collector.start();
    expect(sent).toEqual([]);
  });
});
