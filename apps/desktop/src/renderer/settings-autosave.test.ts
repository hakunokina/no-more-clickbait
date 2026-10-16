import { ManagedSettingsSchema, UNSTAMPED, type ManagedSettings } from "@nmc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note, type Note } from "../shared/i18n.js";
import {
  AUTOSAVE_DELAY_MS,
  SettingsAutoSave,
  type AutoSaveState,
} from "./settings-autosave.js";
import { readSettingForm, settingFormValues } from "./settings-form.js";

const defaults = ManagedSettingsSchema.parse({});
const later = { updatedAt: "2026-10-16T10:00:00.000Z", source: "extension" } as const;

describe("SettingsAutoSave", () => {
  /** What the form shows (raw values, as the inputs hold them). */
  let values: Record<string, string | boolean>;
  let saved: ManagedSettings[];
  let filled: ManagedSettings[];
  let states: AutoSaveState["kind"][];
  let shownErrors: Readonly<Record<string, Note>>;
  let save: (settings: ManagedSettings) => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    values = settingFormValues(defaults);
    saved = [];
    filled = [];
    states = [];
    shownErrors = {};
    save = (settings) => {
      saved.push(settings);
      return Promise.resolve();
    };
  });
  afterEach(() => vi.useRealTimers());

  function unshown(): SettingsAutoSave {
    return new SettingsAutoSave({
      read: (base) => readSettingForm(values, base),
      fill: (settings) => {
        filled.push(settings);
        values = settingFormValues(settings);
      },
      save: (settings) => save(settings),
      showErrors: (errors) => {
        shownErrors = errors;
      },
      onState: (state) => states.push(state.kind),
    });
  }

  /** Shown the defaults as the real settings, as the first status does. */
  function autosave(): SettingsAutoSave {
    const auto = unshown();
    auto.show(UNSTAMPED, defaults);
    filled = [];
    return auto;
  }

  it("saves a committed change at once", async () => {
    const auto = autosave();
    values = { ...values, collectFromInstagram: true, collectFromX: false };
    await auto.flush();
    expect(saved).toEqual([{ ...defaults, collectFromInstagram: true, collectFromX: false }]);
    expect(states).toEqual(["saving", "saved"]);
    expect(auto.busy).toBe(false);
  });

  it("saves typing once it pauses, as one save", async () => {
    const auto = autosave();
    for (const text of ["1", "12", "120"]) {
      values = { ...values, collectTarget: text };
      auto.typed();
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 50);
    }
    expect(saved).toEqual([]);
    expect(auto.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(saved).toEqual([{ ...defaults, collectTarget: 120 }]);
    expect(auto.busy).toBe(false);
  });

  it("saves what is still being typed when the window closes", async () => {
    const auto = autosave();
    values = { ...values, maxClickbait: "3" };
    auto.typed();
    await auto.flush();
    expect(saved).toEqual([{ ...defaults, maxClickbait: 3 }]);
    // The pause timer is gone: no second save later.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(saved).toHaveLength(1);
  });

  it("never saves an invalid value, not even on close; the valid fields still save", async () => {
    const auto = autosave();
    values = { ...values, collectTarget: "0" };
    await auto.flush();
    expect(saved).toEqual([]);
    expect(states).toEqual(["invalid"]);
    expect(shownErrors["collectTarget"]).toEqual(note("wholeNumber", 1, 10_000));
    // Invalid input stays on screen: a push from outside must not wipe it.
    expect(auto.busy).toBe(true);

    values = { ...values, verifyEnabled: false };
    await auto.flush();
    expect(saved).toEqual([{ ...defaults, verifyEnabled: false }]);
    expect(saved[0]?.collectTarget).toBe(defaults.collectTarget);

    values = { ...values, collectTarget: "90" };
    await auto.flush();
    expect(saved.at(-1)).toEqual({ ...defaults, verifyEnabled: false, collectTarget: 90 });
    expect(shownErrors).toEqual({});
    expect(auto.busy).toBe(false);
  });

  it("does not save when nothing changed (a field left as it was)", async () => {
    const auto = autosave();
    await auto.flush();
    expect(saved).toEqual([]);
    expect(states).toEqual([]);
  });

  it("saves one at a time, the later change last", async () => {
    let release: () => void = () => undefined;
    save = (settings) => {
      saved.push(settings);
      return saved.length === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    };
    const auto = autosave();
    values = { ...values, collectFromInstagram: true };
    const first = auto.flush();
    values = { ...values, instagramFollowedOnly: true };
    const second = auto.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toHaveLength(1);
    expect(auto.busy).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(saved.at(-1)).toEqual({
      ...defaults,
      collectFromInstagram: true,
      instagramFollowedOnly: true,
    });
  });

  it("stays busy after a failed save and retries it with the next change", async () => {
    save = () => Promise.reject(new Error("disk full"));
    const auto = autosave();
    values = { ...values, collectFromInstagram: true };
    await auto.flush();
    expect(states).toEqual(["saving", "failed"]);
    expect(auto.busy).toBe(true);
    save = (settings) => {
      saved.push(settings);
      return Promise.resolve();
    };
    await auto.flush();
    expect(saved).toEqual([{ ...defaults, collectFromInstagram: true }]);
    expect(auto.busy).toBe(false);
  });

  it("takes settings filled from outside as the saved ones", async () => {
    const auto = autosave();
    const pushed = { ...defaults, timelineSize: 30 };
    auto.show(later, pushed);
    expect(filled).toEqual([pushed]);
    await auto.flush();
    expect(saved).toEqual([]);
  });

  it("saves nothing before the real settings are shown, not even on close", async () => {
    const auto = unshown();
    // A tick on the form's starting (default) values must not overwrite the real settings.
    values = { ...values, collectFromInstagram: true };
    auto.typed();
    await auto.flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(saved).toEqual([]);
    expect(states).toEqual([]);
    expect(auto.busy).toBe(false);

    const real = { ...defaults, collectFromInstagram: false, timelineSize: 30 };
    auto.show(later, real);
    expect(filled).toEqual([real]);
    values = { ...values, verifyEnabled: false };
    await auto.flush();
    expect(saved).toEqual([{ ...real, verifyEnabled: false }]);
  });

  it("refills on the same stamp with other values, but not twice for the same", () => {
    const auto = autosave();
    const pushed = { ...defaults, timelineSize: 30 };
    auto.show(later, pushed);
    auto.show(later, pushed);
    expect(filled).toEqual([pushed]);
    // The extension could not apply a value: same stamp, other settings.
    const applied = { ...pushed, collectFromInstagram: !pushed.collectFromInstagram };
    auto.show(later, applied);
    expect(filled).toEqual([pushed, applied]);
  });

  it("does not refill while the form holds edits of its own", async () => {
    const auto = autosave();
    values = { ...values, maxClickbait: "3" };
    auto.typed();
    auto.show(later, { ...defaults, timelineSize: 30 });
    expect(filled).toEqual([]);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(saved).toEqual([{ ...defaults, maxClickbait: 3 }]);

    // Settled: the waiting settings can show now.
    auto.show(later, { ...defaults, timelineSize: 30 });
    expect(filled).toEqual([{ ...defaults, timelineSize: 30 }]);
  });
});
