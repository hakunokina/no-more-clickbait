// @vitest-environment happy-dom
import { ManagedSettingsSchema, type ManagedSettings } from "@nmc/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSettingsForm,
  SETTING_GROUPS,
  settingFieldModels,
  type SettingsFormHandle,
} from "./settings-form.js";

const DEFAULTS = ManagedSettingsSchema.parse({});

function field(key: string): HTMLElement {
  const found = document.getElementById(`setting-${key}`);
  if (!found) throw new Error(`missing field ${key}`);
  return found;
}

function wrap(key: string): HTMLElement {
  return field(key).closest(".f") as HTMLElement;
}

function toggle(key: string, checked: boolean): void {
  const box = field(key) as HTMLInputElement;
  box.checked = checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
}

let form: SettingsFormHandle;

function build(settings: Partial<ManagedSettings> = {}): void {
  document.body.innerHTML = '<div id="host"></div>';
  form = buildSettingsForm(document.getElementById("host")!);
  form.fill({ ...DEFAULTS, ...settings });
}

describe("settings form (DOM)", () => {
  beforeEach(() => build());

  it("places every core field in exactly one section, in the groups' order", () => {
    const keys = SETTING_GROUPS.flatMap((group) => [...group.keys]);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(
      settingFieldModels()
        .map((model) => model.key)
        .sort(),
    );
    const sections = [...document.querySelectorAll("section.sec")];
    expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
      "Where to collect",
      "What makes the cut",
      "Fact checks",
      "Mode B",
      "Browser and language",
      "Developer",
    ]);
    expect(sections[0]?.querySelector(".f:last-child")?.contains(field("collectTarget"))).toBe(
      true,
    );
  });

  it("hides Mode B's pace and place while it is off, and keeps their values", () => {
    build({ modeBEnabled: false, modeBPacing: "fast", modeBStrategy: "offscreen-window" });
    expect(wrap("modeBPacing").hidden).toBe(true);
    expect(wrap("modeBStrategy").hidden).toBe(true);
    // Off, then saved: the hidden values go out as they were.
    expect(form.read(DEFAULTS).settings).toMatchObject({
      modeBEnabled: false,
      modeBPacing: "fast",
      modeBStrategy: "offscreen-window",
    });
    toggle("modeBEnabled", true);
    expect(wrap("modeBPacing").hidden).toBe(false);
    expect(wrap("modeBStrategy").hidden).toBe(false);
    const fast = field("modeBPacing").querySelector<HTMLInputElement>('input[value="fast"]');
    expect(fast?.checked).toBe(true);
    expect(form.read(DEFAULTS).settings).toMatchObject({
      modeBEnabled: true,
      modeBPacing: "fast",
    });
    // The risk shows as a warning while Mode B is on.
    expect(
      document.getElementById("setting-modeBEnabled-hint")?.classList.contains("call--warn"),
    ).toBe(true);
  });

  it("greys out “only accounts I follow” while Instagram is off, saying why, value untouched", () => {
    build({ collectFromInstagram: false, instagramFollowedOnly: true });
    const followed = field("instagramFollowedOnly") as HTMLInputElement;
    expect(followed.disabled).toBe(true);
    expect(followed.checked).toBe(true);
    const why = document.getElementById("setting-instagramFollowedOnly-why");
    expect(why?.hidden).toBe(false);
    expect(why?.textContent).toBe("Applies when “Collect from Instagram” is on.");
    expect(followed.getAttribute("aria-describedby")).toContain(why?.id);
    expect(form.read(DEFAULTS).settings.instagramFollowedOnly).toBe(true);
    toggle("collectFromInstagram", true);
    expect(followed.disabled).toBe(false);
    expect(why?.hidden).toBe(true);
    form.setLanguage("tr");
    expect(why?.textContent).toBe("“Instagram'dan topla” açıkken geçerli.");
  });

  it("uses a slider for 0–10 values and steps number fields within their bounds", () => {
    build({ maxClickbait: 4, collectTarget: 9_995 });
    const slider = field("maxClickbait") as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(wrap("maxClickbait").querySelector(".val")?.textContent).toBe("4");
    const target = field("collectTarget") as HTMLInputElement;
    expect(target.type).toBe("number");
    let changes = 0;
    form.element.addEventListener("change", () => (changes += 1));
    const [, increase] = wrap("collectTarget").querySelectorAll("button");
    increase?.click();
    expect(target.value).toBe("10000");
    expect(changes).toBe(1);
    expect(form.read(DEFAULTS).settings.collectTarget).toBe(10_000);
  });

  it("reads and fills a segmented choice", () => {
    build({ uiLanguage: "tr" });
    const group = field("uiLanguage");
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.querySelector<HTMLInputElement>('input[value="tr"]')?.checked).toBe(true);
    expect(form.read(DEFAULTS).settings.uiLanguage).toBe("tr");
  });
});
