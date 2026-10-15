import { SettingsSchema, SYNCED_SETTING_FIELDS } from "@nmc/core";
import { describe, expect, it } from "vitest";
import {
  applyPipelineSettings,
  defaultSyncedSettings,
  readPipelineForm,
  SYNCED_SETTING_KEYS,
  type PipelineFormInput,
} from "./pipeline-form.js";

function formOf(overrides: Partial<PipelineFormInput> = {}): PipelineFormInput {
  const defaults = defaultSyncedSettings();
  const input = {} as PipelineFormInput;
  for (const key of SYNCED_SETTING_KEYS) {
    const value = defaults[key];
    input[key] = typeof value === "boolean" ? value : String(value);
  }
  return { ...input, ...overrides };
}

describe("pipeline settings form", () => {
  it("has one field per synced setting, in the schema's order", () => {
    expect(SYNCED_SETTING_KEYS).toEqual(Object.keys(SYNCED_SETTING_FIELDS));
  });

  it("defaults to the schema defaults (verify from read value 4, timeline 50)", () => {
    expect(defaultSyncedSettings()).toEqual({
      collectTarget: 250,
      timelineSize: 50,
      maxClickbait: 7,
      minReadValue: 2,
      minReadForVerify: 4,
      maxVerifications: 20,
      verifyEnabled: true,
    });
  });

  it("accepts the bounds themselves and trims whitespace", () => {
    const result = readPipelineForm(
      formOf({
        maxClickbait: " 1 ",
        minReadValue: "0",
        minReadForVerify: "10",
        timelineSize: "100",
      }),
    );
    expect(result).toEqual({
      ok: true,
      settings: expect.objectContaining({
        maxClickbait: 1,
        minReadValue: 0,
        minReadForVerify: 10,
        timelineSize: 100,
      }),
    });
  });

  it("reports every out-of-range or non-integer field instead of clamping", () => {
    const result = readPipelineForm(
      formOf({
        maxClickbait: "0",
        minReadValue: "11",
        timelineSize: "2.5",
        maxVerifications: "",
        collectTarget: "1e3",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      [
        "collectTarget",
        "maxClickbait",
        "maxVerifications",
        "minReadValue",
        "timelineSize",
      ].sort(),
    );
    expect(result.errors.maxClickbait).toBe("Enter a whole number from 1 to 10.");
    expect(result.errors.collectTarget).toBe("Enter a whole number from 1 to 10000.");
  });

  it("reads the checkbox as a boolean", () => {
    const result = readPipelineForm(formOf({ verifyEnabled: false }));
    expect(result.ok && result.settings.verifyEnabled).toBe(false);
  });

  it("writes the one collection target to collectTarget and mirrors the deprecated modeBTarget", () => {
    // Stored before collectTarget existed: the schema seeds it from modeBTarget.
    const stored = SettingsSchema.parse({ modeBTarget: 80, devCaptureEnabled: true });
    expect(stored.collectTarget).toBe(80);

    const form = readPipelineForm(formOf({ collectTarget: "300" }));
    if (!form.ok) throw new Error("form should be valid");
    const saved = applyPipelineSettings(stored, form.settings);
    expect(saved).toMatchObject({
      collectTarget: 300,
      modeBTarget: 300,
      devCaptureEnabled: true,
    });

    // modeBTarget keeps its own upper bound.
    const big = readPipelineForm(formOf({ collectTarget: "5000" }));
    if (!big.ok) throw new Error("form should be valid");
    expect(applyPipelineSettings(stored, big.settings)).toMatchObject({
      collectTarget: 5000,
      modeBTarget: 1000,
    });
  });
});
