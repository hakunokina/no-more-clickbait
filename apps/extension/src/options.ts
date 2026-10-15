import { loadSettings, saveSettings } from "./settings.js";

const modeB = document.querySelector<HTMLInputElement>("#mode-b");
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
  if (!modeB || !devCapture || !captureTarget || !timelineSize || !form || !status) return;
  const settings = await loadSettings();
  modeB.checked = settings.modeBEnabled;
  devCapture.checked = settings.devCaptureEnabled;
  captureTarget.value = String(settings.captureTarget);
  timelineSize.value = String(settings.timelineSize);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      try {
        await saveSettings({
          modeBEnabled: modeB.checked,
          devCaptureEnabled: devCapture.checked,
          captureTarget: clamped(captureTarget.value, 1, 10_000, settings.captureTarget),
          timelineSize: clamped(timelineSize.value, 1, 100, settings.timelineSize),
        });
        status.textContent = "Saved.";
      } catch {
        status.textContent = "Could not save settings — check the values and try again.";
      }
    })();
  });
}

void init();
