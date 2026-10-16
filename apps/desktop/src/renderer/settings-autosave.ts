import type { ManagedSettings } from "@nmc/core";
import type { Note } from "../shared/i18n.js";
import type { SettingFormResult } from "./settings-form.js";

/**
 * Saves the Settings form as it changes — there is no Save button. A
 * committed value (a tick, a choice, a number field left) is saved at
 * once; typing in a number field is saved after a short pause. A field
 * that does not validate is shown as such and never saved: it keeps its
 * last valid value, while the other fields still save. Saves go out one
 * at a time; `flush` saves whatever waits (the window calls it before
 * it closes).
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
  #saved: ManagedSettings;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #work: Promise<void> = Promise.resolve();
  /** Saves queued or under way. */
  #queued = 0;
  #invalid = false;
  /** The last save failed: the form holds changes not saved anywhere. */
  #failed = false;

  constructor(deps: AutoSaveDeps, saved: ManagedSettings) {
    this.#deps = deps;
    this.#saved = saved;
  }

  /**
   * Edits not saved yet, a save under way or failed, or a field that
   * does not validate: the form must not be refilled from outside now.
   */
  get busy(): boolean {
    return this.#timer !== undefined || this.#queued > 0 || this.#invalid || this.#failed;
  }

  /** The form now shows `settings` (filled from outside): they are the saved ones. */
  reset(settings: ManagedSettings): void {
    this.#cancelTimer();
    this.#saved = settings;
    this.#invalid = false;
    this.#failed = false;
  }

  /** A field is being typed in: saved once typing pauses. */
  typed(): void {
    this.#cancelTimer();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#deps.delayMs ?? AUTOSAVE_DELAY_MS);
  }

  /** Saves what waits now (a committed change, or the window closing). */
  flush(): Promise<void> {
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
    const { settings, errors } = this.#deps.read(this.#saved);
    this.#deps.showErrors(errors);
    this.#invalid = Object.keys(errors).length > 0;
    // Nothing new (a field left unchanged, a bad entry only): no save, no new stamp.
    if (sameSettings(settings, this.#saved) && !this.#failed) {
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
