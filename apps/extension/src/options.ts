import { ModeBStrategySchema } from "@nmc/core";
import { bindModeBControls, requestModeBPermissions } from "./mode-b-view.js";
import { loadSettings, saveSettings } from "./settings.js";

const modeB = document.querySelector<HTMLInputElement>("#mode-b");
const modeBTarget = document.querySelector<HTMLInputElement>("#mode-b-target");
const modeBStrategy = document.querySelector<HTMLSelectElement>("#mode-b-strategy");
const modeBRun = document.querySelector<HTMLButtonElement>("#mode-b-run");
const modeBStatus = document.querySelector<HTMLElement>("#mode-b-status");
const modeBLastRun = document.querySelector<HTMLElement>("#mode-b-last-run");
const devCapture = document.querySelector<HTMLInputElement>("#dev-capture");
const captureTarget = document.querySelector<HTMLInputElement>("#capture-target");
const timelineSize = document.querySelector<HTMLInputElement>("#timeline-size");
const status = document.querySelector<HTMLElement>("#status");
const form = document.querySelector<HTMLFormElement>("#settings-form");

function clamped(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

async function init(): Promise<void> {
  if (
    !modeB ||
    !modeBTarget ||
    !modeBStrategy ||
    !modeBRun ||
    !modeBStatus ||
    !devCapture ||
    !captureTarget ||
    !timelineSize ||
    !form ||
    !status
  ) {
    return;
  }
  const settings = await loadSettings();
  modeB.checked = settings.modeBEnabled;
  modeBTarget.value = String(settings.modeBTarget);
  modeBStrategy.value = settings.modeBStrategy;
  devCapture.checked = settings.devCaptureEnabled;
  captureTarget.value = String(settings.captureTarget);
  timelineSize.value = String(settings.timelineSize);
  bindModeBControls({ button: modeBRun, status: modeBStatus, lastRun: modeBLastRun });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // Asked while the click still counts as a user gesture.
    const permission = modeB.checked ? requestModeBPermissions() : Promise.resolve(true);
    void (async () => {
      const granted = await permission;
      if (!granted) modeB.checked = false;
      const strategy = ModeBStrategySchema.safeParse(modeBStrategy.value);
      try {
        await saveSettings({
          modeBEnabled: modeB.checked,
          modeBTarget: clamped(modeBTarget.value, 1, 1_000, settings.modeBTarget),
          modeBStrategy: strategy.success ? strategy.data : settings.modeBStrategy,
          devCaptureEnabled: devCapture.checked,
          captureTarget: clamped(captureTarget.value, 1, 10_000, settings.captureTarget),
          timelineSize: clamped(timelineSize.value, 1, 100, settings.timelineSize),
        });
        status.textContent = granted
          ? "Saved."
          : "Saved, but Mode B stays off: the browser did not grant its “alarms” permission.";
      } catch {
        status.textContent = "Could not save settings — check the values and try again.";
      }
    })();
  });
}

void init();
