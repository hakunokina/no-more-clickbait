import { normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** What the reading window may load and where its links may go (see reading-window.ts). */

const MEDIA_HOSTS = new Set(["pbs.twimg.com", "video.twimg.com"]);

export function isAllowedReaderUrl(url: string, fileRoots: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "data:" || parsed.protocol === "devtools:") return true;
  if (parsed.protocol === "https:") return MEDIA_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "file:") return false;
  let path: string;
  try {
    path = normalize(fileURLToPath(parsed)).toLowerCase();
  } catch {
    return false;
  }
  return fileRoots.some((root) => path.startsWith(normalize(root + sep).toLowerCase()));
}

/** Only plain https links leave the app, and only to the user's browser. */
export function externalLinkTarget(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
