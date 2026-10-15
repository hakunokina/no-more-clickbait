#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { TimelineDocSchema } from "@nmc/core";
import { renderTimeline } from "./render.js";

/**
 * nmc-timeline: an nmc-run result folder (its timeline-doc.json) →
 * timeline.html in the same folder, to open in a browser.
 *
 *   pnpm --filter @nmc/timeline-renderer nmc-timeline <run-dir | timeline-doc.json> [--out <file.html>]
 *
 * The page holds feed content (personal data): it stays next to the run
 * result, outside the repo. Stdout carries the path and counts only.
 */

const { values, positionals } = parseArgs({
  options: { out: { type: "string" } },
  allowPositionals: true,
});
const target = positionals[0];
if (!target || positionals.length > 1) {
  console.error("usage: nmc-timeline <run-dir | timeline-doc.json> [--out <file.html>]");
  process.exit(2);
}

const input = resolve(target);
const docFile = (await stat(input)).isDirectory() ? join(input, "timeline-doc.json") : input;
const parsed = TimelineDocSchema.safeParse(JSON.parse(await readFile(docFile, "utf8")));
if (!parsed.success) {
  console.error(`${docFile} is not a valid TimelineDoc:`);
  for (const issue of parsed.error.issues.slice(0, 10)) {
    console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}
const outFile = values.out ? resolve(values.out) : join(dirname(docFile), "timeline.html");
await writeFile(outFile, renderTimeline(parsed.data), "utf8");
console.log(
  JSON.stringify({ state: parsed.data.status.state, cards: parsed.data.cards.length }),
);
console.log(`timeline: ${outFile}`);
