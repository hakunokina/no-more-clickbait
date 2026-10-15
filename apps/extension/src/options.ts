import { loadSettings, saveSettings } from "./settings.js";

const modeB = document.querySelector<HTMLInputElement>("#mode-b");
const timelineSize = document.querySelector<HTMLInputElement>("#timeline-size");
const status = document.querySelector<HTMLElement>("#status");
const form = document.querySelector<HTMLFormElement>("#settings-form");

async function init(): Promise<void> {
  if (!modeB || !timelineSize || !form || !status) return;
  const settings = await loadSettings();
  modeB.checked = settings.modeBEnabled;
  timelineSize.value = String(settings.timelineSize);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const size = Number.parseInt(timelineSize.value, 10);
      await saveSettings({
        modeBEnabled: modeB.checked,
        timelineSize: Number.isFinite(size)
          ? Math.min(100, Math.max(1, size))
          : settings.timelineSize,
      });
      status.textContent = "Saved.";
    })();
  });
}

void init();
