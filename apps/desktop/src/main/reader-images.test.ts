import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimelineDocSchema } from "@nmc/core";
import { nmcImageKey } from "@nmc/timeline-renderer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FetchedImage } from "./image-fetch.js";
import { ReaderImages, timelineImageSources } from "./reader-images.js";
import { sniffImage } from "./image-sniff.js";
import { gif, png } from "./test-images.js";

const A = "https://news.example.invalid/a.png";
const B = "https://news.example.invalid/b.png";
const C = "https://news.example.invalid/c.png";
const src = (url: string) => `nmc-img://img/${nmcImageKey(url)}`;
const sources = (...urls: string[]) => new Map(urls.map((url) => [nmcImageKey(url), url]));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nmc-images-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fake download: each URL's image (a PNG of the given width), counted. */
function fakeFetch(images: Record<string, Buffer>) {
  const calls: string[] = [];
  const fetchImage = async (url: string): Promise<FetchedImage> => {
    calls.push(url);
    const bytes = images[url];
    const image = bytes && sniffImage(bytes);
    return bytes && image ? { ok: true, bytes, ...image } : { ok: false, reason: "status" };
  };
  return { fetchImage, calls };
}

function clock() {
  let t = Date.parse("2026-10-16T10:00:00Z");
  return () => new Date((t += 60_000));
}

describe("ReaderImages", () => {
  it("serves only the shown timeline's keys: anything else is a 404 without a download", async () => {
    const net = fakeFetch({ [A]: png(40, 30), [B]: png(50, 30) });
    const images = new ReaderImages({
      cacheDir: join(dir, "cache"),
      fetchImage: net.fetchImage,
    });
    images.allow(sources(A));

    const ok = await images.respond(src(A));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await ok.arrayBuffer()).equals(png(40, 30))).toBe(true);

    // B is a real image, but not this page's; nor are malformed or foreign URLs.
    for (const url of [
      src(B),
      `nmc-img://img/${"0".repeat(64)}`,
      `nmc-img://img/${nmcImageKey(A).toUpperCase()}`,
      `nmc-img://other/${nmcImageKey(A)}`,
      `nmc-img://img/${nmcImageKey(A)}/x`,
      A,
    ]) {
      expect((await images.respond(url)).status, url).toBe(404);
    }
    expect(net.calls).toEqual([A]);

    // A new page replaces the allowed set.
    images.allow(sources(B));
    expect((await images.respond(src(A))).status).toBe(404);
    expect((await images.respond(src(B))).status).toBe(200);
    images.allow(new Map());
    expect((await images.respond(src(B))).status).toBe(404);
  });

  it("waits for the page's sources, and allows nothing when they cannot be read", async () => {
    const net = fakeFetch({ [A]: png(40, 30) });
    const images = new ReaderImages({
      cacheDir: join(dir, "cache"),
      fetchImage: net.fetchImage,
    });
    let ready: (value: Map<string, string>) => void = () => undefined;
    images.allow(new Promise<Map<string, string>>((resolve) => (ready = resolve)));
    const pending = images.respond(src(A));
    ready(sources(A));
    expect((await pending).status).toBe(200);

    const lines: string[] = [];
    const broken = new ReaderImages({
      cacheDir: join(dir, "cache"),
      fetchImage: net.fetchImage,
      log: (line) => lines.push(line),
    });
    broken.allow(Promise.reject(new Error("timeline.json missing")));
    expect((await broken.respond(src(A))).status).toBe(404);
    expect(lines).toEqual(["images: page sources unreadable (Error)"]);
  });

  it("answers a refused download with a 404 and keeps nothing", async () => {
    const lines: string[] = [];
    const images = new ReaderImages({
      cacheDir: join(dir, "cache"),
      fetchImage: async () => ({ ok: false, reason: "tiny" }),
      log: (line) => lines.push(line),
    });
    images.allow(sources(A));
    expect((await images.respond(src(A))).status).toBe(404);
    expect(lines).toEqual(["image not shown: tiny"]);
    await expect(readdir(join(dir, "cache"))).rejects.toThrow();
  });

  it("keeps images on disk: a second view, or a later app start, downloads nothing", async () => {
    const net = fakeFetch({ [A]: gif(40, 30) });
    const cacheDir = join(dir, "cache");
    const first = new ReaderImages({ cacheDir, fetchImage: net.fetchImage });
    first.allow(sources(A));
    const [one, two] = await Promise.all([first.respond(src(A)), first.respond(src(A))]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(await readdir(cacheDir)).toEqual([nmcImageKey(A)]);
    expect(net.calls).toEqual([A]);

    const later = new ReaderImages({ cacheDir, fetchImage: net.fetchImage });
    later.allow(sources(A));
    const again = await later.respond(src(A));
    expect(again.headers.get("content-type")).toBe("image/gif");
    expect(Buffer.from(await again.arrayBuffer()).equals(gif(40, 30))).toBe(true);
    expect(net.calls).toEqual([A]);

    // A cache file that is no image (damaged) is downloaded again.
    await writeFile(join(cacheDir, nmcImageKey(A)), "<svg/>");
    expect((await later.respond(src(A))).status).toBe(200);
    expect(net.calls).toEqual([A, A]);
    expect(sniffImage(await readFile(join(cacheDir, nmcImageKey(A))))?.type).toBe("image/gif");
  });

  it("drops the least recently shown images once the cache is over its size", async () => {
    const files = { [A]: png(10, 10), [B]: png(20, 10), [C]: png(30, 10) };
    const size = files[A].byteLength;
    const net = fakeFetch(files);
    const cacheDir = join(dir, "cache");
    const images = new ReaderImages({
      cacheDir,
      fetchImage: net.fetchImage,
      maxCacheBytes: size * 2,
      now: clock(),
    });
    images.allow(sources(A, B, C));
    await images.respond(src(A));
    await images.respond(src(B));
    // A is shown again: B is now the least recently shown.
    await images.respond(src(A));
    await images.respond(src(C));
    expect((await readdir(cacheDir)).sort()).toEqual([nmcImageKey(A), nmcImageKey(C)].sort());
    expect(net.calls).toEqual([A, B, C]);
    await images.respond(src(B));
    expect(net.calls).toEqual([A, B, C, B]);
    expect((await readdir(cacheDir)).sort()).toEqual([nmcImageKey(B), nmcImageKey(C)].sort());
  });
});

describe("timelineImageSources", () => {
  it("reads the shown page's images from the timeline.json beside it", async () => {
    const fixture = new URL(
      "../../../../packages/core/fixtures/timeline-doc-mixed.json",
      import.meta.url,
    );
    const doc = TimelineDocSchema.parse(JSON.parse(await readFile(fixture, "utf8")));
    await writeFile(join(dir, "timeline.json"), JSON.stringify(doc));
    const image = "https://news.example.invalid/img/sentetik-faiz.jpg";
    expect(await timelineImageSources(join(dir, "timeline.html"))).toEqual(
      new Map([[nmcImageKey(image), image]]),
    );
    await expect(timelineImageSources(join(dir, "missing", "timeline.html"))).rejects.toThrow();
  });
});
