import type { DesktopApi } from "../preload/preload.js";

declare global {
  interface Window {
    nmc: DesktopApi;
  }
}

const button = document.querySelector<HTMLButtonElement>("#check-llm");
const status = document.querySelector<HTMLElement>("#llm-status");

button?.addEventListener("click", () => {
  if (!status || !button) return;
  button.disabled = true;
  status.textContent = "Checking…";
  status.className = "";
  window.nmc
    .checkLlmStatus()
    .then((availability) => {
      if (availability.ok) {
        status.textContent = `Ready — claude CLI ${availability.version}`;
        status.className = "ok";
      } else {
        status.textContent =
          availability.reason === "not-found"
            ? "claude CLI not found on PATH. Install it and log in, then check again."
            : availability.reason === "not-authenticated"
              ? "claude CLI is installed but not logged in. Log in with the CLI first."
              : `CLI check failed: ${availability.detail}`;
        status.className = "bad";
      }
    })
    .catch((error: unknown) => {
      status.textContent = `CLI check failed: ${String(error)}`;
      status.className = "bad";
    })
    .finally(() => {
      button.disabled = false;
    });
});
