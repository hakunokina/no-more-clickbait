// @vitest-environment happy-dom
import { SYNCED_SETTING_FIELDS } from "@nmc/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fillPipelineFields,
  readPipelineFields,
  reflectVerifyEnabled,
  renderPipelineFields,
  showPipelineErrors,
  type PipelineControls,
} from "./pipeline-fields.js";
import {
  defaultSyncedSettings,
  readPipelineForm,
  SYNCED_SETTING_KEYS,
} from "./pipeline-form.js";

let controls: PipelineControls;

function control(key: string) {
  const found = controls.get(key);
  if (!found) throw new Error(`no control for ${key}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  document.body.append(container);
  controls = renderPipelineFields(container);
});

describe("pipeline fields (DOM)", () => {
  it("renders one labelled, described input per synced setting", () => {
    expect([...controls.keys()]).toEqual(SYNCED_SETTING_KEYS);
    const target = control("collectTarget").input;
    expect(target.type).toBe("number");
    expect([target.min, target.max, target.required]).toEqual(["1", "10000", true]);
    expect(target.closest("label")?.textContent).toContain(
      SYNCED_SETTING_FIELDS.collectTarget.label,
    );
    expect(target.getAttribute("aria-describedby")).toBe(
      "setting-collectTarget-hint setting-collectTarget-error",
    );
    expect(document.getElementById("setting-collectTarget-hint")?.textContent).toContain(
      "Range 1–10000, default 250.",
    );
    expect(control("verifyEnabled").input.type).toBe("checkbox");
  });

  it("fills values, clears old errors and round-trips through read", () => {
    const values = { ...defaultSyncedSettings(), maxClickbait: 5 };
    control("maxClickbait").error.textContent = "old";
    control("maxClickbait").input.setAttribute("aria-invalid", "true");
    fillPipelineFields(controls, values);
    expect(control("maxClickbait").error.textContent).toBe("");
    expect(control("maxClickbait").input.hasAttribute("aria-invalid")).toBe(false);
    expect(readPipelineForm(readPipelineFields(controls))).toEqual({
      ok: true,
      settings: values,
    });
  });

  it("disables the source-check fields while checks are off and drops their errors", () => {
    fillPipelineFields(controls, defaultSyncedSettings());
    const max = control("maxVerifications");
    max.error.textContent = "Enter a whole number from 1 to 20.";
    max.input.setAttribute("aria-invalid", "true");
    control("verifyEnabled").input.checked = false;
    reflectVerifyEnabled(controls);
    expect([max.input.disabled, control("minReadForVerify").input.disabled]).toEqual([
      true,
      true,
    ]);
    expect(max.wrapper.classList.contains("off")).toBe(true);
    expect([max.error.textContent, max.input.hasAttribute("aria-invalid")]).toEqual([
      "",
      false,
    ]);
    expect(control("maxClickbait").input.disabled).toBe(false);
    control("verifyEnabled").input.checked = true;
    reflectVerifyEnabled(controls);
    expect([max.input.disabled, max.wrapper.classList.contains("off")]).toEqual([false, false]);
  });

  it("marks invalid fields and focuses the first one, then clears on success", () => {
    fillPipelineFields(controls, defaultSyncedSettings());
    control("timelineSize").input.value = "0";
    control("maxClickbait").input.value = "11";
    showPipelineErrors(controls, readPipelineForm(readPipelineFields(controls)));
    expect(control("timelineSize").input.getAttribute("aria-invalid")).toBe("true");
    expect(control("maxClickbait").error.textContent).toBe(
      "Enter a whole number from 1 to 10.",
    );
    expect(control("collectTarget").error.textContent).toBe("");
    expect(document.activeElement).toBe(control("timelineSize").input);

    control("timelineSize").input.value = "20";
    control("maxClickbait").input.value = "6";
    showPipelineErrors(controls, readPipelineForm(readPipelineFields(controls)));
    expect(control("timelineSize").input.hasAttribute("aria-invalid")).toBe(false);
    expect(control("maxClickbait").error.textContent).toBe("");
  });

  it("lets a save through with checks off and shows the kept value in the disabled field", () => {
    const stored = { ...defaultSyncedSettings(), maxVerifications: 7 };
    fillPipelineFields(controls, stored);
    control("maxVerifications").input.value = "99";
    control("verifyEnabled").input.checked = false;
    reflectVerifyEnabled(controls);
    const result = readPipelineForm(readPipelineFields(controls), stored);
    showPipelineErrors(controls, result);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    fillPipelineFields(controls, result.settings);
    expect(control("maxVerifications").input.value).toBe("7");
    expect(control("maxVerifications").input.disabled).toBe(true);
  });
});
