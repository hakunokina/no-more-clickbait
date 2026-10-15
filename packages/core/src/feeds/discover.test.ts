// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverFeeds } from "./discover.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "sites");

describe("discoverFeeds", () => {
  it("lists announced RSS/Atom feeds once each, resolved against the page", () => {
    const html = readFileSync(join(fixtures, "news.html"), "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(discoverFeeds(doc, "https://haber.example.invalid/gundem")).toEqual([
      { url: "https://haber.example.invalid/gundem/rss.xml", kind: "rss", title: "Gündem RSS" },
      { url: "https://haber.example.invalid/atom.xml", kind: "atom" },
    ]);
  });

  it("finds nothing on a page without feed links", () => {
    const html = readFileSync(join(fixtures, "forum.html"), "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(discoverFeeds(doc, "https://forum.example.invalid/")).toEqual([]);
  });

  it("ignores non-http feed addresses and honours <base href>", () => {
    document.head.innerHTML =
      '<base href="https://cdn.example.invalid/site/">' +
      '<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">' +
      '<link rel="alternate feed" type="application/rss+xml" href="feed.xml">';
    expect(discoverFeeds(document, "https://site.example.invalid/")).toEqual([
      { url: "https://cdn.example.invalid/site/feed.xml", kind: "rss" },
    ]);
  });
});
