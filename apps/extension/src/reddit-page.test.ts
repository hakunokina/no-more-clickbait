// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTextContentType,
  keepRedditBody,
  normaliseRedditPath,
  normaliseRedditQuery,
  RedditDomCollector,
  redditResponseTarget,
} from "./reddit-page.js";

const ORIGIN = "https://www.reddit.com";

// Made-up shreddit markup: invented ids, titles and names, no real data.
const post = (id: string): string =>
  `<shreddit-post id="${id}" post-title="Synthetic ${id}" subreddit-prefixed-name="r/example"></shreddit-post>`;

describe("redditResponseTarget", () => {
  it("always keeps /svc/shreddit/ and GraphQL responses, labelled by normalised path", () => {
    expect(
      redditResponseTarget(
        "/svc/shreddit/community-more-posts/hot/?after=abc&name=example",
        ORIGIN,
      ),
    ).toEqual({ label: "/svc/shreddit/community-more-posts/hot/?after&name", always: true });
    expect(redditResponseTarget("https://gql-fed.reddit.com/", ORIGIN)).toEqual({
      label: "gql-fed.reddit.com/",
      always: true,
    });
  });

  it("keeps other reddit.com responses only when they carry posts", () => {
    const target = redditResponseTarget("/r/example/comments/t3_abc/", ORIGIN);
    expect(target).toEqual({ label: "/r/{x}/comments/{id}/", always: false });
    if (!target) throw new Error("expected a target");
    expect(keepRedditBody(target, "<div>nothing</div>")).toBe(false);
    expect(keepRedditBody(target, post("t3_1"))).toBe(true);
  });

  it("ignores other sites and look-alike hosts", () => {
    expect(redditResponseTarget("https://example.com/svc/shreddit/x", ORIGIN)).toBeNull();
    expect(redditResponseTarget("https://notreddit.com/svc/shreddit/x", ORIGIN)).toBeNull();
    expect(redditResponseTarget("http://www.reddit.com/svc/shreddit/x", ORIGIN)).toBeNull();
  });

  it("generalises subreddit and user names in labels", () => {
    expect(normaliseRedditPath("/svc/shreddit/r/example/u/someone/user/other")).toBe(
      "/svc/shreddit/r/{x}/u/{x}/user/{x}",
    );
    // A name that happens to be a route word is still a name.
    expect(normaliseRedditPath("/r/popular/hot/")).toBe("/r/{x}/hot/");
  });

  it("keeps only comments/{id} of a post path: slug and comment ids dropped", () => {
    expect(normaliseRedditPath("/r/example/comments/abc123/a_post_title/")).toBe(
      "/r/{x}/comments/{id}/*",
    );
    expect(normaliseRedditPath("/comments/abc123/a_post_title/def456/")).toBe(
      "/comments/{id}/*",
    );
    expect(normaliseRedditPath("/comments/abc123")).toBe("/comments/{id}");
  });

  it("turns unknown path segments into {x}", () => {
    expect(normaliseRedditPath("/svc/shreddit/feeds/home-feed")).toBe(
      "/svc/shreddit/feeds/home-feed",
    );
    expect(normaliseRedditPath("/svc/shreddit/Secret_Title/t3_abc")).toBe(
      "/svc/shreddit/{x}/{id}",
    );
  });

  it("keeps query key names only", () => {
    expect(normaliseRedditQuery("?after=t3_abc&name=example&after=x")).toBe("?after&name");
    expect(normaliseRedditQuery("?a%20secret%20title=1&Secret_Name&other")).toBe("?{x}");
    expect(normaliseRedditQuery("")).toBe("");
  });

  it("lets no title, subreddit or user name into any label", () => {
    const secrets = ["Secret_Post_Title", "SecretSub", "secret_user"];
    const urls = [
      "/r/SecretSub/comments/abc123/Secret_Post_Title/",
      "/r/SecretSub/comments/abc123/Secret_Post_Title/def456/?context=3",
      "/user/secret_user/submitted/?sort=new",
      "/u/secret_user/",
      "/svc/shreddit/community-more-posts/hot/?name=SecretSub&after=t3_x",
      "/svc/shreddit/SecretSub/Secret_Post_Title",
      "/search/?q=Secret_Post_Title",
      "/?secret_user=SecretSub",
      "https://gql-fed.reddit.com/r/SecretSub?Secret_Post_Title",
    ];
    for (const url of urls) {
      const label = redditResponseTarget(url, ORIGIN)?.label ?? "";
      for (const secret of secrets)
        expect(label.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("reads only text bodies", () => {
    expect(isTextContentType("text/html; charset=utf-8")).toBe(true);
    expect(isTextContentType("application/json")).toBe(true);
    expect(isTextContentType("image/webp")).toBe(false);
    expect(isTextContentType(null)).toBe(false);
  });
});

describe("RedditDomCollector", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("snapshots the parsed page once, then batches each added post once", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main>${post("t3_1")}<shreddit-ad-post id="ad-1"></shreddit-ad-post><p>other</p></main>`;
    const sent: [string, string][] = [];
    const collector = new RedditDomCollector(document, (operation, body) => {
      sent.push([operation, body]);
    });
    collector.start();
    expect(sent.map(([operation]) => operation)).toEqual(["dom-initial"]);
    expect(sent[0]?.[1]).toContain('id="t3_1"');
    expect(sent[0]?.[1]).toContain("shreddit-ad-post");

    const page = document.createElement("section");
    page.innerHTML = `${post("t3_2")}${post("t3_3")}`;
    document.querySelector("main")?.append(page);
    // A post moved within the page is not new.
    const first = document.querySelector("shreddit-post");
    if (first) document.body.append(first);
    await vi.advanceTimersByTimeAsync(0); // mutation records
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent.map(([operation]) => operation)).toEqual(["dom-initial", "dom-added"]);
    const added = sent[1]?.[1] ?? "";
    expect(added).toContain('id="t3_2"');
    expect(added).toContain('id="t3_3"');
    expect(added).not.toContain('id="t3_1"');
    collector.stop();
  });

  it("snapshots the page again after stop and start (a new capture folder)", () => {
    document.body.innerHTML = post("t3_1");
    const sent: string[] = [];
    const collector = new RedditDomCollector(document, (operation) => sent.push(operation));
    collector.start();
    collector.stop();
    collector.start();
    expect(sent).toEqual(["dom-initial", "dom-initial"]);
    collector.stop();
  });

  it("sends nothing after stop", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const collector = new RedditDomCollector(document, (operation) => sent.push(operation));
    collector.start();
    collector.stop();
    document.body.innerHTML = post("t3_9");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);
  });
});
