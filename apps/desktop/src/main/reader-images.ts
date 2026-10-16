import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { TimelineDocSchema } from "@nmc/core";
import { desktopImageSources, NMC_IMAGE_SCHEME } from "@nmc/timeline-renderer";
import { fetchImage, type FetchedImage } from "./image-fetch.js";
import { sniffImage, type ImageType } from "./image-sniff.js";
import { TIMELINE_DOC_FILE } from "./session-controller.js";

/**
 * Generic cards' images in the reading window. The page names an image
 * only by its key (`nmc-img://img/<sha256 of the URL>`); the scheme is
 * served in the reading window's session alone, and only for the keys
 * of the timeline shown now — read from its timeline.json, never from
 * the page — so a page cannot make the app fetch any other URL.
 *
 * Images are fetched by image-fetch.ts and kept on disk outside the
 * session folders (a key per file), the least recently shown dropped
 * first once the cache is over its size. Anything refused or failed
 * is a 404: the page then shows the card without an image.
 */

export const DEFAULT_IMAGE_CACHE_BYTES = 100 * 1024 * 1024;

const KEY = /^[0-9a-f]{64}$/;
const KEY_URL = new RegExp(`^${NMC_IMAGE_SCHEME}://img/([0-9a-f]{64})$`);

/** key → URL of the images a timeline page may show, from the timeline.json beside it. */
export async function timelineImageSources(timelinePath: string): Promise<Map<string, string>> {
  const raw = await readFile(join(dirname(timelinePath), TIMELINE_DOC_FILE), "utf8");
  return desktopImageSources(TimelineDocSchema.parse(JSON.parse(raw)));
}

export interface ReaderImagesOptions {
  cacheDir: string;
  fetchImage?: (url: string) => Promise<FetchedImage>;
  maxCacheBytes?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

interface Served {
  bytes: Uint8Array;
  type: ImageType;
}

export class ReaderImages {
  readonly #options: ReaderImagesOptions;
  #allowed: Promise<ReadonlyMap<string, string>> = Promise.resolve(new Map());
  readonly #loading = new Map<string, Promise<Served | null>>();
  #pruning: Promise<void> = Promise.resolve();

  constructor(options: ReaderImagesOptions) {
    this.#options = options;
  }

  /** The page shown now may load these images (key → URL), and no others. */
  allow(sources: ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>): void {
    this.#allowed = Promise.resolve(sources).catch((error: unknown) => {
      this.#log(
        `images: page sources unreadable (${error instanceof Error ? error.name : "error"})`,
      );
      return new Map<string, string>();
    });
  }

  /** The scheme's answer to `url`: the image, or 404. */
  async respond(url: string): Promise<Response> {
    const key = KEY_URL.exec(url)?.[1];
    const source = key ? (await this.#allowed).get(key) : undefined;
    const image = key && source ? await this.#image(key, source) : null;
    if (!image) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(image.bytes), {
      headers: { "content-type": image.type, "x-content-type-options": "nosniff" },
    });
  }

  /** One load per key at a time. */
  #image(key: string, url: string): Promise<Served | null> {
    let loading = this.#loading.get(key);
    if (!loading) {
      loading = this.#load(key, url).finally(() => this.#loading.delete(key));
      this.#loading.set(key, loading);
    }
    return loading;
  }

  async #load(key: string, url: string): Promise<Served | null> {
    const path = join(this.#options.cacheDir, key);
    const cached = await this.#read(path);
    if (cached) return cached;
    const fetched = await (this.#options.fetchImage ?? fetchImage)(url);
    if (!fetched.ok) {
      this.#log(`image not shown: ${fetched.reason}`);
      return null;
    }
    await this.#store(path, fetched.bytes);
    return { bytes: fetched.bytes, type: fetched.type };
  }

  async #read(path: string): Promise<Served | null> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch {
      return null;
    }
    const image = sniffImage(bytes);
    if (!image) return null;
    // Shown again: the last to go when the cache is pruned.
    const now = this.#now();
    await utimes(path, now, now).catch(() => undefined);
    return { bytes, type: image.type };
  }

  async #store(path: string, bytes: Uint8Array): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.#options.cacheDir, { recursive: true });
      await writeFile(temp, bytes);
      const now = this.#now();
      await utimes(temp, now, now);
      await rename(temp, path);
    } catch (error) {
      // Shown all the same, only not kept.
      this.#log(`image not cached: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
      await unlink(temp).catch(() => undefined);
      return;
    }
    await this.#prune();
  }

  /** Least recently shown first, until the cache fits again; one pass at a time. */
  #prune(): Promise<void> {
    this.#pruning = this.#pruning.then(() => this.#pruneNow()).catch(() => undefined);
    return this.#pruning;
  }

  async #pruneNow(): Promise<void> {
    const dir = this.#options.cacheDir;
    const max = this.#options.maxCacheBytes ?? DEFAULT_IMAGE_CACHE_BYTES;
    const names = (await readdir(dir)).filter((name) => KEY.test(name));
    const files = (
      await Promise.all(
        names.map(async (name) => {
          const info = await stat(join(dir, name)).catch(() => null);
          return info ? { name, size: info.size, used: info.mtimeMs } : null;
        }),
      )
    ).filter((file) => file !== null);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((a, b) => a.used - b.used);
    for (const file of files) {
      if (total <= max) break;
      await unlink(join(dir, file.name)).catch(() => undefined);
      total -= file.size;
    }
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  #log(line: string): void {
    this.#options.log?.(line);
  }
}
