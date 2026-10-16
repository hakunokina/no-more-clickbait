import type { UiLang } from "@nmc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, SETTINGS_WAIT_MS } from "./settings-load.js";

describe("loadSettings", () => {
  let rendered: string[];
  let unreadable: UiLang[];

  beforeEach(() => {
    vi.useFakeTimers();
    rendered = [];
    unreadable = [];
  });
  afterEach(() => vi.useRealTimers());

  function load(
    get: () => Promise<string>,
    systemLocales: readonly string[] = ["tr-TR", "en-US"],
  ) {
    loadSettings({
      get,
      render: (status) => rendered.push(status),
      unreadable: (lang) => unreadable.push(lang),
      systemLocales,
    });
  }

  it("renders the status main answers with, and never gives up after", async () => {
    load(() => Promise.resolve("status"));
    await vi.advanceTimersByTimeAsync(SETTINGS_WAIT_MS * 2);
    expect(rendered).toEqual(["status"]);
    expect(unreadable).toEqual([]);
  });

  it("shows the page in the system's language when the settings cannot be read", async () => {
    load(() => Promise.reject(new Error("no")));
    await vi.advanceTimersByTimeAsync(0);
    expect(unreadable).toEqual(["tr"]);
    // Once: the wait running out later does not show it again.
    await vi.advanceTimersByTimeAsync(SETTINGS_WAIT_MS);
    expect(unreadable).toEqual(["tr"]);

    load(() => Promise.reject(new Error("no")), ["en-GB"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(unreadable).toEqual(["tr", "en"]);
  });

  it("stops waiting for a main that never answers, then still renders a late status", async () => {
    let answer!: (status: string) => void;
    load(() => new Promise<string>((resolve) => (answer = resolve)));
    await vi.advanceTimersByTimeAsync(SETTINGS_WAIT_MS - 1);
    expect(unreadable).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(unreadable).toEqual(["tr"]);
    answer("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(rendered).toEqual(["late"]);
    expect(unreadable).toEqual(["tr"]);
  });

  it("gives up once when the refusal comes after the wait ran out", async () => {
    let refuse!: (error: Error) => void;
    load(() => new Promise<string>((_, reject) => (refuse = reject)));
    await vi.advanceTimersByTimeAsync(SETTINGS_WAIT_MS);
    refuse(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(unreadable).toEqual(["tr"]);
  });
});
