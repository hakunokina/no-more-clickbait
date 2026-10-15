import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tableMismatches, TimelineDocSchema, type TimelineDoc, type UiLang } from "@nmc/core";
import { describe, expect, it } from "vitest";
import { CARDS_SCRIPTS, TIMELINE_SCRIPTS } from "./client-script.js";
import { RENDER_MESSAGES } from "./messages.js";
import { renderTimeline, TIMELINE_CSPS } from "./render.js";
import { stateDocs } from "./state-docs.js";

const read = (name: string) =>
  readFileSync(new URL(`../../core/fixtures/${name}`, import.meta.url), "utf8");
const xRaw = read("timeline-doc.json");
const mixedRaw = read("timeline-doc-mixed.json");
const xOnly = TimelineDocSchema.parse(JSON.parse(xRaw));
const mixed = TimelineDocSchema.parse(JSON.parse(mixedRaw));
const render = (doc: TimelineDoc, lang: UiLang, actions = false) =>
  renderTimeline(doc, { timeZone: "Europe/Istanbul", lang, actions });
const hash = (text: string) =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** Every fixed Turkish string an English page must not show (feed text aside). */
function turkishOnly(): string[] {
  const { script: trScript, ...tr } = RENDER_MESSAGES.tr;
  const { script: enScript, ...en } = RENDER_MESSAGES.en;
  const pairs: [unknown, unknown][] = [
    ...Object.entries(tr).map(([key, value]) => [value, en[key as keyof typeof en]] as const),
    ...Object.entries(trScript).map(
      ([key, value]) => [value, enScript[key as keyof typeof enScript]] as const,
    ),
  ];
  return pairs
    .filter((pair): pair is [string, string] => typeof pair[0] === "string")
    .map(([value, other]) => (value === other ? "" : value.trim()))
    .filter((value) => value.length >= 5 && !xRaw.includes(value) && !mixedRaw.includes(value));
}

describe("renderer languages", () => {
  it("has the same messages in English and Turkish", () => {
    const { script: enScript, ...en } = RENDER_MESSAGES.en;
    const { script: trScript, ...tr } = RENDER_MESSAGES.tr;
    expect(tableMismatches(en, tr)).toEqual([]);
    expect(tableMismatches(enScript, trScript)).toEqual([]);
  });

  it("renders the X fixture in English (snapshot)", async () => {
    await expect(render(xOnly, "en")).toMatchFileSnapshot(
      "./__snapshots__/timeline-doc.en.html",
    );
  });

  it("renders the mixed fixture in English (snapshot)", async () => {
    await expect(render(mixed, "en")).toMatchFileSnapshot(
      "./__snapshots__/timeline-doc-mixed.en.html",
    );
  });

  it("defaults to English", () => {
    expect(renderTimeline(xOnly, { timeZone: "Europe/Istanbul" })).toBe(render(xOnly, "en"));
  });

  it("leaves no Turkish copy on an English page, in any state", () => {
    const words = turkishOnly();
    expect(words.length).toBeGreaterThan(40);
    for (const doc of [
      ...Object.values(stateDocs(xOnly)),
      ...Object.values(stateDocs(mixed)),
    ]) {
      const html = render(doc, "en", true);
      expect(html).toContain('<html lang="en">');
      // The error state's reason and detail are the caller's (the fixture's Turkish).
      const page =
        doc.status.state === "error"
          ? html.replace(doc.status.reason, "").replace(doc.status.detail ?? "", "")
          : html;
      for (const word of words) expect(page, word).not.toContain(word);
    }
  });

  it("gives each language's page its own script, by hash", () => {
    for (const lang of ["en", "tr"] as const) {
      const xPage = render(xOnly, lang);
      expect(xPage).toContain(`<script>${TIMELINE_SCRIPTS[lang]}</script>`);
      expect(TIMELINE_CSPS[lang]).toContain(`script-src ${hash(TIMELINE_SCRIPTS[lang])}`);
      expect(() => new Function(TIMELINE_SCRIPTS[lang])).not.toThrow();
      expect(() => new Function(CARDS_SCRIPTS[lang])).not.toThrow();
      expect(render(mixed, lang)).toContain(
        `<script>${TIMELINE_SCRIPTS[lang]}${CARDS_SCRIPTS[lang]}</script>`,
      );
    }
    expect(TIMELINE_SCRIPTS.en).toContain('"Read more"');
    expect(TIMELINE_SCRIPTS.en).not.toContain("Devamını oku");
  });

  it("formats dates in the page's language", () => {
    expect(render(xOnly, "en")).toMatch(
      /<title>Timeline for [A-Z][a-z]+day, [A-Z][a-z]+ \d+ ·/,
    );
    expect(render(xOnly, "tr")).toMatch(
      /<title>\d+ [A-ZÇĞİÖŞÜ][a-zçğıöşü]+ [A-ZÇĞİÖŞÜ][a-zçğıöşü]+ akışı ·/,
    );
  });
});
