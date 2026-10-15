import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GenericItemSchema } from "../schemas.js";
import { decodeHtmlEntities, FeedParseError, htmlToText, parseFeed } from "./parse-feed.js";
import { parseXml, XmlParseError, xmlText } from "./xml.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "feeds");
const feed = (name: string): string => readFileSync(join(fixtures, name), "utf8");

describe("parseFeed — RSS 2.0", () => {
  const items = parseFeed(feed("rss2.xml"), {
    sourceLabel: "custom:Kuzeykent",
    feedUrl: "https://haber.example.invalid/gundem/rss.xml",
  });

  it("reads items into valid generic items, skipping linkless and repeated ones", () => {
    for (const item of items) expect(GenericItemSchema.parse(item)).toEqual(item);
    expect(items.map((item) => item.url)).toEqual([
      "https://haber.example.invalid/gundem/kopru-ihalesi",
      "https://haber.example.invalid/gundem/park-alani",
      "https://haber.example.invalid/gundem/guid-link",
    ]);
  });

  it("reduces HTML to text, keeps the author's name and the date", () => {
    expect(items[0]).toEqual({
      platform: "generic",
      id: expect.stringMatching(/^u[0-9a-f]{16}$/),
      sourceLabel: "custom:Kuzeykent",
      title: "Köprü ihalesi & yeni takvim",
      text: "Belediye meclisi ihaleyi iptal etti.",
      url: "https://haber.example.invalid/gundem/kopru-ihalesi",
      domain: "haber.example.invalid",
      kind: "link",
      author: "Ayşe Yılmaz",
      publishedAt: "2026-10-15T05:30:00.000Z",
      image: { url: "https://haber.example.invalid/img/kopru.jpg" },
      promoted: false,
    });
  });

  it("handles escaped HTML, unknown entities, enclosures, bad dates and bare addresses", () => {
    expect(items[1]).toMatchObject({
      text: "Yeni yeşil alan iki mahalleyi birleştiriyor … &bomb;",
      author: "Mehmet Demir",
      image: { url: "https://haber.example.invalid/img/park.jpg" },
    });
    expect(items[1]?.publishedAt).toBeUndefined();
    expect(items[2]?.author).toBeUndefined();
    expect(items[2]?.image?.url).toBe("https://haber.example.invalid/img/g.jpg");
  });
});

describe("parseFeed — Atom and RSS 1.0", () => {
  it("reads Atom entries: alternate link, html/xhtml text, enclosure and thumbnail", () => {
    const items = parseFeed(feed("atom.xml"), {
      sourceLabel: "custom:Blog",
      feedUrl: "https://blog.example.invalid/feed.atom",
    });
    expect(items.map((item) => [item.title, item.text, item.url, item.image?.url])).toEqual([
      [
        "İlk yazı",
        "Özet bağlantı",
        "https://blog.example.invalid/yazilar/ilk",
        "https://blog.example.invalid/img/ilk.png",
      ],
      [
        // type="text": angle brackets are text, not tags
        "Düz metin <başlık>",
        "XHTML içerik",
        "https://blog.example.invalid/yazilar/ikinci",
        "https://blog.example.invalid/img/2.jpg",
      ],
    ]);
    expect(items[0]).toMatchObject({
      author: "Deniz Ak",
      publishedAt: "2026-10-14T08:00:00.000Z",
    });
    expect(items[1]?.publishedAt).toBe("2026-10-13T08:00:00.000Z");
  });

  it("reads RSS 1.0 (RDF) items", () => {
    const items = parseFeed(feed("rss1.rdf"), {
      sourceLabel: "custom:Eski",
      feedUrl: "https://eski.example.invalid/rss",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "RDF öğesi",
      url: "https://eski.example.invalid/a",
      publishedAt: "2026-10-01T12:00:00.000Z",
    });
  });

  it("throws a FeedParseError for broken XML or a document that is not a feed", () => {
    const options = { sourceLabel: "x", feedUrl: "https://a.example.invalid/" };
    expect(() => parseFeed("<rss><channel></rss>", options)).toThrow(FeedParseError);
    expect(() => parseFeed("<html><body/></html>", options)).toThrow(
      "not an RSS or Atom feed (root element <html>)",
    );
    expect(() => parseFeed("", options)).toThrow(/not well-formed XML: no root element/);
  });

  it("never resolves an opaque guid against the feed URL", () => {
    const options = { sourceLabel: "x", feedUrl: "https://f.example.invalid/rss.xml" };
    const item = (guid: string): string =>
      `<item><title>T</title><description>D</description>${guid}</item>`;
    // Opaque ids (isPermaLink missing or "false") without a link are
    // skipped — GenericItem.url is required, so there is no linkless
    // feed item — instead of fabricating "…/rss.xml/post-123".
    for (const guid of ["<guid>post-123</guid>", '<guid isPermaLink="false">post-123</guid>']) {
      expect(
        parseFeed(`<rss version="2.0"><channel>${item(guid)}</channel></rss>`, options),
      ).toEqual([]);
    }
    // An absolute http(s) guid still backs the link, whatever the flag says…
    expect(
      parseFeed(
        `<rss version="2.0"><channel>${item('<guid isPermaLink="true">https://f.example.invalid/a</guid>')}</channel></rss>`,
        options,
      ).map((entry) => entry.url),
    ).toEqual(["https://f.example.invalid/a"]);
    expect(
      parseFeed(
        `<rss version="2.0"><channel>${item("<guid>https://f.example.invalid/b</guid>")}</channel></rss>`,
        options,
      ).map((entry) => entry.url),
    ).toEqual(["https://f.example.invalid/b"]);
    // …but "false" means "not a permalink" even for an absolute URL,
    // and a relative guid is never resolved against the feed URL.
    for (const guid of [
      '<guid isPermaLink="false">https://f.example.invalid/c</guid>',
      '<guid isPermaLink="true">/gundem/d</guid>',
    ]) {
      expect(
        parseFeed(`<rss version="2.0"><channel>${item(guid)}</channel></rss>`, options),
      ).toEqual([]);
    }
  });
});

describe("parseFeed — card fields", () => {
  const options = { sourceLabel: "custom:F", feedUrl: "https://f.example.invalid/rss.xml" };
  const rss = (channel: string): string =>
    `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>${channel}</channel></rss>`;
  const entry = (extra: string, n = 1): string =>
    `<item><title>T${n}</title><link>https://f.example.invalid/${n}</link>${extra}</item>`;

  it("takes the channel language, an item's dc:language over it, and drops a malformed tag", () => {
    const items = parseFeed(
      rss(
        `<language>tr-TR</language>${entry("")}${entry("<dc:language>en</dc:language>", 2)}${entry("<dc:language>not a tag!</dc:language>", 3)}`,
      ),
      options,
    );
    expect(items.map((item) => item.lang)).toEqual(["tr-TR", "en", "tr-TR"]);
    expect(parseFeed(rss(entry("")), options)[0]?.lang).toBeUndefined();
  });

  it("reads Atom xml:lang from the entry, else the feed", () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="de"><entry><title>A</title><link href="https://f.example.invalid/a"/></entry><entry xml:lang="fr"><title>B</title><link href="https://f.example.invalid/b"/></entry></feed>`;
    expect(parseFeed(atom, options).map((item) => item.lang)).toEqual(["de", "fr"]);
  });

  it("marks entries as links, or video with a video enclosure", () => {
    const items = parseFeed(
      rss(
        `${entry("")}${entry('<enclosure url="https://f.example.invalid/v.mp4" type="video/mp4" length="1"/>', 2)}${entry('<media:group><media:content url="https://f.example.invalid/v.mp4" medium="video"/></media:group>', 3)}`,
      ),
      options,
    );
    expect(items.map((item) => item.kind)).toEqual(["link", "video", "video"]);
  });

  it("carries the image's own alt text: img alt, media:content's media:description", () => {
    const items = parseFeed(
      rss(
        `${entry('<description>&lt;img src="/i.jpg" alt="Köprü &amp;amp; nehir"&gt; Metin</description>')}${entry('<media:content url="https://f.example.invalid/m.jpg" medium="image"><media:description>Gün batımı</media:description></media:content>', 2)}${entry('<description>&lt;img src="/d.jpg" alt=""&gt;</description>', 3)}${entry('<media:thumbnail url="https://f.example.invalid/t.jpg"/><description>Haber özeti</description>', 4)}`,
      ),
      options,
    );
    expect(items.map((item) => item.image)).toEqual([
      { url: "https://f.example.invalid/i.jpg", altText: "Köprü & nehir" },
      { url: "https://f.example.invalid/m.jpg", altText: "Gün batımı" },
      { url: "https://f.example.invalid/d.jpg" },
      // The entry's description is not the image's alt text.
      { url: "https://f.example.invalid/t.jpg" },
    ]);
    for (const item of items) expect(GenericItemSchema.parse(item)).toEqual(item);
  });
});

describe("parseXml", () => {
  it("reads attributes, CDATA, entities and skips comments, PIs and the DOCTYPE", () => {
    const root = parseXml(
      String.fromCharCode(0xfeff) +
        `<?xml version="1.0"?><!DOCTYPE a [<!ENTITY e "x">]><!-- c --><a k='v &amp; w' n="1">` +
        `t &lt;1&gt; &#x41;&#66; &e; &#xD800;<![CDATA[<b>&amp;</b>]]><b/></a>`,
    );
    expect(root.name).toBe("a");
    expect(root.attrs).toEqual({ k: "v & w", n: "1" });
    expect(xmlText(root)).toBe("t <1> AB &e; &#xD800;<b>&amp;</b>");
    expect(root.children.at(-1)).toEqual({ name: "b", attrs: {}, children: [] });
  });

  it("rejects mismatched, unclosed and unquoted markup", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(XmlParseError);
    expect(() => parseXml("<a>")).toThrow("<a> is not closed");
    expect(() => parseXml("<a k=v></a>")).toThrow(/not quoted/);
    expect(() => parseXml("<a><!-- open")).toThrow(/unclosed comment/);
    expect(() => parseXml(`${"<a>".repeat(65)}${"</a>".repeat(65)}`)).toThrow(
      "nesting too deep",
    );
  });
});

describe("HTML helpers", () => {
  it("stays fast on hostile, never-closed markup", () => {
    const started = Date.now();
    expect(htmlToText(`${"<!--<script".repeat(20_000)}`)).toBe("");
    expect(htmlToText(`ok${"<img src='x' ".repeat(20_000)}`)).toBe("ok");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("drops scripts and tags, keeps block breaks as spaces", () => {
    expect(htmlToText("<p>a</p><p>b<script>x()</script></p><style>p{}</style>c<br>d")).toBe(
      " a  b   c d",
    );
    expect(decodeHtmlEntities("&quot;a&quot; &nbsp;&hellip; &#8217; &Unknown;")).toBe(
      '"a"  … ’ &Unknown;',
    );
  });
});
