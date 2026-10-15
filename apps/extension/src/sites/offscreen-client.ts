import type { ExtractResult, SiteRule } from "@nmc/core";

/**
 * The worker's way to a DOM: MV3 service workers have no `DOMParser`,
 * so HTML is parsed in the extension's offscreen document (offscreen.ts),
 * which runs the core rule engine on it. Created on first use and kept
 * (a DOM_PARSER document is not closed for idleness); if it is gone
 * anyway (closed, crashed), the next query creates it again.
 */

export const OFFSCREEN_URL = "offscreen.html";

export interface OffscreenExtractQuery {
  kind: "offscreen-extract";
  html: string;
  pageUrl: string;
  rule: SiteRule;
}

export type OffscreenExtractAnswer =
  ({ ok: true } & ExtractResult) | { ok: false; message: string };

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: "Parse fetched pages of the user's own site rules with DOMParser.",
    })
    .catch((error: unknown) => {
      // Already open (worker restarted while it lived): that is the one we want.
      if (!/single offscreen|already/i.test(String(error))) {
        creating = null;
        throw error;
      }
    });
  await creating;
}

/** Sends the query; `undefined` when no document is there to answer. */
async function ask(query: OffscreenExtractQuery): Promise<OffscreenExtractAnswer | undefined> {
  try {
    return (await chrome.runtime.sendMessage(query)) as OffscreenExtractAnswer | undefined;
  } catch (error) {
    // Chrome rejects (rather than answering undefined) when nothing listens.
    if (/receiving end does not exist/i.test(String(error))) return undefined;
    throw error;
  }
}

/** Runs the rule on fetched HTML in the offscreen document. */
export async function extractInOffscreen(
  html: string,
  pageUrl: string,
  rule: SiteRule,
): Promise<ExtractResult> {
  await ensureOffscreen();
  const query: OffscreenExtractQuery = { kind: "offscreen-extract", html, pageUrl, rule };
  let answer = await ask(query);
  if (!answer) {
    // The document went away between uses: open it again, once.
    creating = null;
    await ensureOffscreen();
    answer = await ask(query);
  }
  if (!answer?.ok) throw new Error(answer?.message ?? "the offscreen document did not answer");
  return { items: answer.items, stats: answer.stats };
}
