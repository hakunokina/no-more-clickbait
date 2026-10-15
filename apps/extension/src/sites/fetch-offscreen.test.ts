import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchText } from "./fetch-text.js";
import { extractInOffscreen } from "./offscreen-client.js";
import { siteRule } from "./test-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("site fetch", () => {
  it("refuses a page the server announces as too large, before reading it", async () => {
    const text = vi.fn(() => Promise.resolve("never read"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          url: "https://news.example.invalid/world",
          headers: new Headers({ "content-length": "9000000" }),
          text,
        }),
      ),
    );
    expect(await fetchText("https://news.example.invalid/world")).toEqual({
      ok: false,
      message: "the page is too large",
    });
    expect(text).not.toHaveBeenCalled();
  });
});

describe("offscreen document", () => {
  it("opens the document again when nothing answers, then asks once more", async () => {
    const createDocument = vi.fn(() => Promise.resolve());
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Could not establish connection. Receiving end does not exist."),
      )
      .mockResolvedValueOnce({ ok: true, items: [], stats: undefined });
    vi.stubGlobal("chrome", {
      offscreen: { createDocument, Reason: { DOM_PARSER: "DOM_PARSER" } },
      runtime: { sendMessage },
    });
    await expect(
      extractInOffscreen("<p></p>", "https://news.example.invalid/world", siteRule()),
    ).resolves.toMatchObject({ items: [] });
    expect(createDocument).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
