import { ModeBPacingSchema, ModeBSurfaceSchema } from "@nmc/core";
import { bindModeBControls, requestModeBPermissions } from "./mode-b-view.js";
import {
  fillPipelineFields,
  readPipelineFields,
  reflectVerifyEnabled,
  renderPipelineFields,
  showPipelineErrors,
} from "./pipeline-fields.js";
import {
  applyPipelineSettings,
  defaultSyncedSettings,
  readPipelineForm,
} from "./pipeline-form.js";
import { loadSettings, saveSettings } from "./settings.js";
import { createSettingsSyncer, describeSyncResult, sendNativeOnce } from "./settings-sync.js";

const modeB = document.querySelector<HTMLInputElement>("#mode-b");
const modeBStrategy = document.querySelector<HTMLSelectElement>("#mode-b-strategy");
const modeBPacing = document.querySelector<HTMLSelectElement>("#mode-b-pacing");
const modeBRun = document.querySelector<HTMLButtonElement>("#mode-b-run");
const modeBStatus = document.querySelector<HTMLElement>("#mode-b-status");
const modeBLastRun = document.querySelector<HTMLElement>("#mode-b-last-run");
const devCapture = document.querySelector<HTMLInputElement>("#dev-capture");
const pipelineFields = document.querySelector<HTMLElement>("#pipeline-fields");
const pipelineDefaults = document.querySelector<HTMLButtonElement>("#pipeline-defaults");
const status = document.querySelector<HTMLElement>("#status");
const syncStatus = document.querySelector<HTMLElement>("#sync-status");
const form = document.querySelector<HTMLFormElement>("#settings-form");

async function init(): Promise<void> {
  if (
    !modeB ||
    !modeBStrategy ||
    !modeBPacing ||
    !modeBRun ||
    !modeBStatus ||
    !devCapture ||
    !pipelineFields ||
    !pipelineDefaults ||
    !form ||
    !status ||
    !syncStatus
  ) {
    return;
  }
  let settings = await loadSettings();
  modeB.checked = settings.modeBEnabled;
  modeBStrategy.value = settings.modeBStrategy;
  modeBPacing.value = settings.modeBPacing;
  devCapture.checked = settings.devCaptureEnabled;
  const controls = renderPipelineFields(pipelineFields);
  fillPipelineFields(controls, settings);
  controls.get("verifyEnabled")?.input.addEventListener("change", () => {
    reflectVerifyEnabled(controls);
  });
  pipelineDefaults.addEventListener("click", () => {
    fillPipelineFields(controls, defaultSyncedSettings());
    status.textContent = "Defaults restored in the form — press Save to keep them.";
  });
  bindModeBControls({ button: modeBRun, status: modeBStatus, lastRun: modeBLastRun });
  const syncSettings = createSettingsSyncer(sendNativeOnce);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const pipeline = readPipelineForm(readPipelineFields(controls), settings);
    showPipelineErrors(controls, pipeline);
    if (!pipeline.ok) {
      status.textContent = "Not saved — fix the highlighted values first.";
      syncStatus.textContent = "";
      return;
    }
    // Shows the kept value in a disabled field whose entry was ignored.
    fillPipelineFields(controls, pipeline.settings);
    // Asked while the click still counts as a user gesture.
    const permission = modeB.checked ? requestModeBPermissions() : Promise.resolve(true);
    void (async () => {
      const granted = await permission;
      if (!granted) modeB.checked = false;
      const strategy = ModeBSurfaceSchema.safeParse(modeBStrategy.value);
      const pacing = ModeBPacingSchema.safeParse(modeBPacing.value);
      try {
        settings = {
          ...applyPipelineSettings(settings, pipeline.settings),
          modeBEnabled: modeB.checked,
          modeBStrategy: strategy.success ? strategy.data : settings.modeBStrategy,
          modeBPacing: pacing.success ? pacing.data : settings.modeBPacing,
          devCaptureEnabled: devCapture.checked,
        };
        await saveSettings(settings);
        status.textContent = granted
          ? "Saved."
          : "Saved, but Mode B stays off: the browser did not grant its “alarms” permission.";
      } catch {
        status.textContent = "Could not save settings — check the values and try again.";
        return;
      }
      syncStatus.textContent = "";
      const synced = await syncSettings(settings);
      syncStatus.textContent = describeSyncResult(synced);
    })();
  });
}

void init();
