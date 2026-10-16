import { readFileSync } from "node:fs";
import { tableMismatches } from "@nmc/core";
import { describe, expect, it } from "vitest";
import {
  describeLink,
  describeRun,
  describeUnfinished,
  formatCost,
  formatDuration,
} from "./format.js";
import { DESKTOP_MESSAGES, messages, note, runErrorNote, say } from "./i18n.js";
import { initialStatus, type DesktopStatus } from "./status.js";

function status(mutate: (status: DesktopStatus) => void): DesktopStatus {
  const next = initialStatus();
  mutate(next);
  return next;
}

describe("desktop messages", () => {
  it("has the same keys and arguments in English and Turkish", () => {
    expect(tableMismatches(DESKTOP_MESSAGES.en, DESKTOP_MESSAGES.tr)).toEqual([]);
  });

  it("has every static key the window pages use, as plain text", () => {
    for (const page of ["index.html", "reader.html", "settings.html"]) {
      const html = readFileSync(new URL(`../renderer/${page}`, import.meta.url), "utf8");
      const keys = [...html.matchAll(/data-i18n(?:-label)?="([^"]+)"/g)].map(
        (match) => match[1] ?? "",
      );
      expect(keys.length, page).toBeGreaterThan(0);
      // Hidden until localizePage words it (no English flash for Turkish),
      // by the page's own style or the stylesheet it links.
      const css = html.includes('<link rel="stylesheet" href="ui.css" />')
        ? readFileSync(new URL("../renderer/ui.css", import.meta.url), "utf8")
        : "";
      expect(html, page).toContain('<html lang="en" data-i18n-pending>');
      expect(html + css, page).toContain("[data-i18n-pending] body { visibility: hidden; }");
      for (const key of keys) {
        for (const lang of ["en", "tr"] as const) {
          const value = (DESKTOP_MESSAGES[lang] as Record<string, unknown>)[key];
          expect(typeof value, `${page} ${key} ${lang}`).toBe("string");
        }
      }
    }
  });

  it("words a note in either language, its arguments formatted there", () => {
    const stopped = note("stoppedEarly", 1200, 2500, "not-logged-in");
    expect(say("en", stopped)).toBe(
      "The collection stopped early (not logged in to X in this browser) with 1,200 of 2,500 posts.",
    );
    expect(say("tr", stopped)).toBe(
      "Toplama erken durdu (bu tarayıcıda X oturumu açık değil); 1.200 / 2.500 gönderi var.",
    );
    // An unknown stop reason is shown as it came.
    expect(say("tr", note("endedEmpty", "new-reason"))).toContain("(new-reason)");
    expect(say("en", null)).toBe("");
    // Notes are plain data: they survive IPC.
    expect(structuredClone(stopped)).toEqual(stopped);
  });

  it("names the feeds browsed in the reader's pending Mode A lead", () => {
    const en = messages("en").pendingLeadA;
    const tr = messages("tr").pendingLeadA;
    expect(en(null)).toContain("while you browsed X?");
    expect(en(["x", "instagram"])).toContain("while you browsed X and Instagram?");
    expect(en([])).toContain("while you browsed your custom sites?");
    expect(tr(null)).toMatch(/^X'te gezinirken/);
    expect(tr(["instagram"])).toMatch(/^Instagram'da gezinirken/);
    expect(tr(["x", "instagram"])).toMatch(/^X ve Instagram'da gezinirken/);
    expect(tr([])).toMatch(/^Özel sitelerinde gezinirken/);
  });

  it("reads a saved run error back into its note, English or not", () => {
    // By key, even when the English wording changed since.
    expect(runErrorNote({ note: "errCliFailed", message: "reworded" })).toEqual(
      note("errCliFailed"),
    );
    // Older records: by the English message.
    expect(runErrorNote({ message: say("en", note("errCliFailed")) })).toEqual(
      note("errCliFailed"),
    );
    expect(runErrorNote({ note: "notARunError", message: "something else" })).toEqual(
      note("errLastRunFailed"),
    );
    expect(runErrorNote(undefined)).toEqual(note("errLastRunFailed"));
  });

  it("formats the monitor's figures in the windows' language", () => {
    expect(formatCost(0.1234, "en")).toBe("$0.123");
    expect(formatCost(12.5, "en")).toBe("$12.50");
    expect(formatCost(0.1234, "tr")).toBe("$0,123");
    expect(formatDuration(125_000, "en")).toBe("2 min 5 s");
    expect(formatDuration(125_000, "tr")).toBe("2 dk 5 sn");
    expect(formatDuration(null, "tr")).toBe("—");
  });

  it("describes the run, the link and unfinished collections in Turkish", () => {
    const collecting = status((s) => {
      s.lang = "tr";
      s.collection = { state: "collecting", message: null, target: 1500, count: 1200 };
    });
    expect(describeRun(collecting)).toBe("Tarayıcıda toplanıyor… 1.200 / 1.500 gönderi");
    expect(describeLink(status((s) => (s.lang = "tr")))).toBe("Tarayıcı bağlantısı açılıyor…");
    expect(
      describeLink(
        status((s) => {
          s.lang = "tr";
          s.link.error = note("linkUnavailable");
        }),
      ),
    ).toBe(messages("tr").linkUnavailable);
    const unfinished = status((s) => {
      s.lang = "tr";
      s.unfinished = { count: 2, newestAt: null };
    });
    expect(describeUnfinished(unfinished)).toBe(
      "Daha önceki 2 toplama tamamlanmadı. Gönderileri diskte duruyor; akışa dönüştürülmedi.",
    );
    expect(describeRun(status(() => undefined))).toBe("Idle");
  });
});
