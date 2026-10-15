import type { FetchResult } from "./site-collect.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_CHARS = 5_000_000;

/**
 * Fetch for a site rule, from an extension context holding the site's
 * host permission (no CORS). The browser session's cookies go along, so
 * a page the user is signed in to answers as it does for them (the
 * Sites footer says so). Never throws.
 */
export async function fetchText(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok)
      return { ok: false, status: response.status, message: response.statusText };
    // Refused before the download when the server says how big it is.
    if (Number(response.headers.get("content-length")) > MAX_FETCH_CHARS) {
      controller.abort();
      return { ok: false, message: "the page is too large" };
    }
    const text = await response.text();
    if (text.length > MAX_FETCH_CHARS) return { ok: false, message: "the page is too large" };
    return { ok: true, text, finalUrl: response.url || url };
  } catch (error) {
    return { ok: false, message: controller.signal.aborted ? "timed out" : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
