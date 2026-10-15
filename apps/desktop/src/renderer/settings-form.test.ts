import { ManagedSettingsSchema } from "@nmc/core";
import { describe, expect, it } from "vitest";
import { parseSettingForm, settingFieldModels, settingFormValues } from "./settings-form.js";

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

  it("round-trips a settings object through raw form values", () => {
    const settings = ManagedSettingsSchema.parse({
      maxClickbait: 4,
      verifyEnabled: false,
      modeBPacing: "fast",
      devCaptureEnabled: true,
    });
    expect(parseSettingForm(settingFormValues(settings))).toEqual({ ok: true, settings });
  });

  it("reports each bad field on its own", () => {
    const values = settingFormValues(ManagedSettingsSchema.parse({}));
    const result = parseSettingForm({
      ...values,
      maxClickbait: "11",
      collectTarget: "2.5",
      timelineSize: "",
      modeBStrategy: "background-tab",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual([
        "collectTarget",
        "maxClickbait",
        "modeBStrategy",
        "timelineSize",
      ]);
      expect(result.errors["maxClickbait"]).toContain("between 1 and 10");
    }
  });
});
