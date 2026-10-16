import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { externalLinkTarget, isAllowedReaderUrl } from "./reader-policy.js";

const sessions = join(process.cwd(), "sessions-root");
const renderer = join(process.cwd(), "dist", "renderer");
const roots = [renderer, sessions];
const file = (...parts: string[]): string => pathToFileURL(join(...parts)).href;

describe("reading window request policy", () => {
  it("allows our pages, the session folders and the feed's media CDNs", () => {
    expect(isAllowedReaderUrl(file(renderer, "reader.html"), roots)).toBe(true);
    expect(isAllowedReaderUrl(file(sessions, "s1", "timeline.html"), roots)).toBe(true);
    expect(isAllowedReaderUrl("https://pbs.twimg.com/media/a.jpg", roots)).toBe(true);
    expect(isAllowedReaderUrl("https://video.twimg.com/v.mp4", roots)).toBe(true);
    expect(isAllowedReaderUrl("https://scontent-ist1-1.cdninstagram.com/v/a.jpg", roots)).toBe(
      true,
    );
    expect(isAllowedReaderUrl("https://instagram.fist4-1.fna.fbcdn.net/v/b.mp4", roots)).toBe(
      true,
    );
    expect(isAllowedReaderUrl("data:image/svg+xml,%3Csvg/%3E", roots)).toBe(true);
    expect(isAllowedReaderUrl(`nmc-img://img/${"a".repeat(64)}`, roots)).toBe(true);
  });

  it("blocks every other host, scheme and local file", () => {
    expect(isAllowedReaderUrl("https://evil.example/pixel.gif", roots)).toBe(false);
    expect(isAllowedReaderUrl("http://pbs.twimg.com/media/a.jpg", roots)).toBe(false);
    expect(isAllowedReaderUrl("https://pbs.twimg.com.evil.example/a.jpg", roots)).toBe(false);
    expect(
      isAllowedReaderUrl("https://scontent.cdninstagram.com.evil.example/a.jpg", roots),
    ).toBe(false);
    expect(isAllowedReaderUrl("https://evilfbcdn.net/a.jpg", roots)).toBe(false);
    expect(isAllowedReaderUrl("http://scontent.cdninstagram.com/a.jpg", roots)).toBe(false);
    expect(isAllowedReaderUrl(file(process.cwd(), "secrets.txt"), roots)).toBe(false);
    expect(isAllowedReaderUrl(file(`${sessions}-other`, "x.html"), roots)).toBe(false);
    expect(isAllowedReaderUrl(file(sessions, "..", "outside.html"), roots)).toBe(false);
    expect(isAllowedReaderUrl("not a url", roots)).toBe(false);
    expect(isAllowedReaderUrl("nmc-img://evil.example/a.jpg", roots)).toBe(false);
  });

  it("lets only https links out to the browser", () => {
    expect(externalLinkTarget("https://x.com/a/status/1")).toBe("https://x.com/a/status/1");
    expect(externalLinkTarget("http://x.com/")).toBeNull();
    expect(externalLinkTarget("javascript:alert(1)")).toBeNull();
    expect(externalLinkTarget("file:///C:/Windows/system32/calc.exe")).toBeNull();
  });
});
