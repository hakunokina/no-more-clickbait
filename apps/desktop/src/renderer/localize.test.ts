// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { localizePage } from "./localize.js";

describe("localizePage", () => {
  it("words the page in the language, then shows it", () => {
    document.documentElement.lang = "en";
    document.documentElement.setAttribute("data-i18n-pending", "");
    document.body.innerHTML = '<button data-i18n="cancel">Cancel</button>';
    localizePage(document, "tr", "Başlık");
    expect(document.documentElement.lang).toBe("tr");
    expect(document.title).toBe("Başlık");
    expect(document.querySelector("button")?.textContent).not.toBe("Cancel");
    expect(document.documentElement.hasAttribute("data-i18n-pending")).toBe(false);
  });
});
