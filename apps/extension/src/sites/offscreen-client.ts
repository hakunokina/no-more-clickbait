import type { ExtractResult, SiteRule } from "@nmc/core";

/**
 * The worker's way to a DOM: MV3 service workers have no `DOMParser`,
 * so HTML is parsed in the extension's offscreen document (offscreen.ts),
 * which runs the core rule engine on it. Created on first use and kept;
 * the browser closes it on its own when idle.
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

/** Runs the rule on fetched HTML in the offscreen document. */
export async function extractInOffscreen(
  html: string,
  pageUrl: string,
  rule: SiteRule,
): Promise<ExtractResult> {
  await ensureOffscreen();
  const query: OffscreenExtractQuery = { kind: "offscreen-extract", html, pageUrl, rule };
  let answer = (await chrome.runtime.sendMessage(query)) as OffscreenExtractAnswer | undefined;
  if (!answer) {
    // The document may have been closed by the browser between uses.
    creating = null;
    await ensureOffscreen();
    answer = (await chrome.runtime.sendMessage(query)) as OffscreenExtractAnswer | undefined;
  }
  if (!answer?.ok) throw new Error(answer?.message ?? "the offscreen document did not answer");
  return { items: answer.items, stats: answer.stats };
}
