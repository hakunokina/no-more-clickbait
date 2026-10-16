import { ManagedSettingsSchema, type ManagedSettings } from "@nmc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note, type Note } from "../shared/i18n.js";
import {
  AUTOSAVE_DELAY_MS,
  SettingsAutoSave,
  type AutoSaveState,
} from "./settings-autosave.js";
import { readSettingForm, settingFormValues } from "./settings-form.js";

const defaults = ManagedSettingsSchema.parse({});

describe("SettingsAutoSave", () => {
  /** What the form shows (raw values, as the inputs hold them). */
  let values: Record<string, string | boolean>;
  let saved: ManagedSettings[];
  let states: AutoSaveState["kind"][];
  let shownErrors: Readonly<Record<string, Note>>;
  let save: (settings: ManagedSettings) => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    values = settingFormValues(defaults);
    saved = [];
    states = [];
    shownErrors = {};
    save = (settings) => {
      saved.push(settings);
      return Promise.resolve();
    };
  });
  afterEach(() => vi.useRealTimers());

  function autosave(): SettingsAutoSave {
    return new SettingsAutoSave(
      {
        read: (base) => readSettingForm(values, base),
        save: (settings) => save(settings),
        showErrors: (errors) => {
          shownErrors = errors;
        },
        onState: (state) => states.push(state.kind),
      },
      defaults,
    );
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
    auto.reset(pushed);
    values = settingFormValues(pushed);
    await auto.flush();
    expect(saved).toEqual([]);
  });
});
