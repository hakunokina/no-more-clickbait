import { ManagedSettingsSchema } from "@nmc/core";
import { describe, expect, it } from "vitest";
import { say } from "../shared/i18n.js";
import { readSettingForm, settingFieldModels, settingFormValues } from "./settings-form.js";

describe("settings form model", () => {
  it("covers exactly the managed settings, with core's copy and bounds", () => {
    const models = settingFieldModels();
    expect(models.map((m) => m.key).sort()).toEqual(
      Object.keys(ManagedSettingsSchema.parse({})).sort(),
    );
    const collect = models.find((m) => m.key === "collectTarget");
    expect(collect).toMatchObject({
      kind: "integer",
      min: 1,
      max: 10_000,
      label: "Posts to collect",
    });
    const pacing = models.find((m) => m.key === "modeBPacing");
    expect(pacing).toMatchObject({ kind: "choice" });
    for (const model of models) expect(model.description.length).toBeGreaterThan(10);
  });

  it("words every field in Turkish too, choices included", () => {
    const tr = settingFieldModels("tr");
    expect(tr.map((m) => m.key)).toEqual(settingFieldModels().map((m) => m.key));
    expect(tr.find((m) => m.key === "collectTarget")?.label).toBe("Toplanacak gönderi");
    expect(tr.find((m) => m.key === "uiLanguage")).toMatchObject({
      kind: "choice",
      label: "Dil",
      options: [
        { value: "system", label: "Sistem dili" },
        { value: "en", label: "English" },
        { value: "tr", label: "Türkçe" },
      ],
    });
  });

  it("round-trips a settings object through raw form values", () => {
    const settings = ManagedSettingsSchema.parse({
      maxClickbait: 4,
      verifyEnabled: false,
      modeBPacing: "fast",
      devCaptureEnabled: true,
    });
    expect(
      readSettingForm(settingFormValues(settings), ManagedSettingsSchema.parse({})),
    ).toEqual({ settings, errors: {} });
  });

  it("reports each bad field on its own and keeps its last valid value", () => {
    const base = ManagedSettingsSchema.parse({ maxClickbait: 6, collectTarget: 90 });
    const values = settingFormValues(base);
    const result = readSettingForm(
      {
        ...values,
        maxClickbait: "11",
        collectTarget: "2.5",
        timelineSize: "",
        modeBStrategy: "background-tab",
        // A valid change next to the bad ones is still taken.
        collectFromInstagram: true,
      },
      base,
    );
    expect(Object.keys(result.errors).sort()).toEqual([
      "collectTarget",
      "maxClickbait",
      "modeBStrategy",
      "timelineSize",
    ]);
    expect(result.settings).toEqual({ ...base, collectFromInstagram: true });
    const error = result.errors["maxClickbait"] ?? null;
    expect(say("en", error)).toContain("between 1 and 10");
    expect(say("tr", error)).toBe("1 ile 10 arasında bir tam sayı gir.");
  });
});
