import type { ManagedSettings, SettingsStamp } from "@nmc/core";
import type { Note } from "../shared/i18n.js";
import type { SettingFormResult } from "./settings-form.js";

/**
 * Saves the Settings form as it changes — there is no Save button. A
 * committed value (a tick, a choice, a number field left) is saved at
 * once; typing in a number field is saved after a short pause. A field
 * that does not validate is shown as such and never saved: it keeps its
 * last valid value, while the other fields still save. Saves go out one
 * at a time; `flush` saves whatever waits (the window calls it before
 * it closes). Nothing is saved before the real settings have been shown
 * once: the form's starting values are only defaults.
 */

export const AUTOSAVE_DELAY_MS = 400;

export type AutoSaveState =
  | { kind: "saving" }
  | { kind: "saved" }
  /** Some fields do not validate; the rest is saved. */
  | { kind: "invalid" }
  | { kind: "failed"; error: string };

export interface AutoSaveDeps {
  /** The form's values over `base` (the last saved settings). */
  read(base: ManagedSettings): SettingFormResult;
  /** Fills the form with settings from outside. */
  fill(settings: ManagedSettings): void;
  save(settings: ManagedSettings): Promise<void>;
  showErrors(errors: Readonly<Record<string, Note>>): void;
  onState(state: AutoSaveState): void;
  delayMs?: number;
}

function sameSettings(a: ManagedSettings, b: ManagedSettings): boolean {
  return (Object.keys(a) as (keyof ManagedSettings)[]).every((key) => a[key] === b[key]);
}

export class SettingsAutoSave {
  readonly #deps: AutoSaveDeps;
  /** Null until the real settings have been shown: there is nothing to save over. */
  #saved: ManagedSettings | null = null;
  /** The stamped settings the form was last filled with. */
  #shown = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #work: Promise<void> = Promise.resolve();
  /** Saves queued or under way. */
  #queued = 0;
  #invalid = false;
  /** The last save failed: the form holds changes not saved anywhere. */
  #failed = false;

  constructor(deps: AutoSaveDeps) {
    this.#deps = deps;
  }

  /**
   * Edits not saved yet, a save under way or failed, or a field that
   * does not validate: the form must not be refilled from outside now.
   */
  get busy(): boolean {
    return this.#timer !== undefined || this.#queued > 0 || this.#invalid || this.#failed;
  }

  /**
   * Fills the form with the latest settings from outside unless it holds
   * edits of its own; they become the saved ones. A push answer may carry
   * the stamp just saved with other values (the other side could not
   * apply some), so the values count too.
   */
  show(stamp: SettingsStamp, settings: ManagedSettings): void {
    if (this.busy) return;
    const key = JSON.stringify([stamp, settings]);
    if (key === this.#shown) return;
    this.#shown = key;
    this.#saved = settings;
    this.#invalid = false;
    this.#failed = false;
    this.#deps.fill(settings);
  }

  /** A field is being typed in: saved once typing pauses. */
  typed(): void {
    if (this.#saved === null) return;
    this.#cancelTimer();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#deps.delayMs ?? AUTOSAVE_DELAY_MS);
  }

  /** Saves what waits now (a committed change, or the window closing). */
  flush(): Promise<void> {
    if (this.#saved === null) return this.#work;
    this.#cancelTimer();
    this.#queued += 1;
    this.#work = this.#work
      .then(() => this.#saveNow())
      .catch((error: unknown) => {
        this.#deps.onState({ kind: "failed", error: String(error) });
      });
    return this.#work;
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #saveNow(): Promise<void> {
    let outcome: AutoSaveState | null = null;
    try {
      outcome = await this.#save();
    } finally {
      // Settled before the outcome is told, so a listener sees `busy` as it now is.
      this.#queued -= 1;
    }
    if (outcome) this.#deps.onState(outcome);
  }

  async #save(): Promise<AutoSaveState | null> {
    const base = this.#saved;
    if (base === null) return null;
    const { settings, errors } = this.#deps.read(base);
    this.#deps.showErrors(errors);
    this.#invalid = Object.keys(errors).length > 0;
    // Nothing new (a field left unchanged, a bad entry only): no save, no new stamp.
    if (sameSettings(settings, base) && !this.#failed) {
      return this.#invalid ? { kind: "invalid" } : null;
    }
    this.#deps.onState({ kind: "saving" });
    try {
      await this.#deps.save(settings);
    } catch (error) {
      this.#failed = true;
      return { kind: "failed", error: String(error) };
    }
    this.#saved = settings;
    this.#failed = false;
    return this.#invalid ? { kind: "invalid" } : { kind: "saved" };
  }
}
