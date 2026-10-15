import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsSchema } from "@nmc/core";
import type { DesktopStatus } from "../shared/status.js";
import { PipelineRunner } from "./pipeline-runner.js";
import { SessionController } from "./session-controller.js";
import { liveContents, sendToAll, type ContentsLike } from "./window-contents.js";

class FakeContents implements ContentsLike {
  destroyed = false;
  readonly sent: unknown[] = [];
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(_channel: string, payload: unknown): void {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    this.sent.push(payload);
  }
}

/** Like Electron's BrowserWindow: every property throws once closed. */
class FakeWindow {
  #destroyed = false;
  readonly #contents = new FakeContents();
  isDestroyed(): boolean {
    return this.#destroyed;
  }
  get webContents(): FakeContents {
    if (this.#destroyed) throw new TypeError("Object has been destroyed");
    return this.#contents;
  }
  close(): void {
    this.#contents.destroyed = true;
    this.#destroyed = true;
  }
}

describe("window contents", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("has no contents for a missing or closed window", () => {
    const win = new FakeWindow();
    expect(liveContents(win)).toBe(win.webContents);
    win.close();
    expect(liveContents(win)).toBeNull();
    expect(liveContents(null)).toBeNull();
  });

  it("keeps sending to the others when one window fails", () => {
    const broken: ContentsLike = {
      isDestroyed: () => false,
      send: () => {
        throw new Error("render process gone");
      },
    };
    const ok = new FakeContents();
    const logged: string[] = [];
    sendToAll([broken, null, ok], "nmc:status", 1, (line) => logged.push(line));
    expect(ok.sent).toEqual([1]);
    expect(logged).toHaveLength(1);
  });

  it("survives a host reconnecting after the monitor was closed", async () => {
    root = await mkdtemp(join(tmpdir(), "nmc-window-test-"));
    let monitor: FakeWindow | null = new FakeWindow();
    const contents = monitor.webContents;
    const controller = new SessionController({
      sessionsRoot: root,
      runner: new PipelineRunner(() => {
        throw new Error("not expected");
      }),
      loadSettings: async () => SettingsSchema.parse({}),
      renderTimeline: () => "",
      sendToHost: () => true,
      onStatus: (status: DesktopStatus) =>
        sendToAll([liveContents(monitor)], "nmc:status", status),
      onReady: () => undefined,
    });
    controller.setLink({ hosts: 1 });
    expect(contents.sent).toHaveLength(1);

    monitor.close(); // the user closed the monitor; `monitor` still points at it
    expect(() => controller.setLink({ hosts: 0 })).not.toThrow();
    expect(() => controller.setLink({ hosts: 1 })).not.toThrow();
    monitor = null;
    expect(() => controller.setLink({ hosts: 2 })).not.toThrow();
    expect(contents.sent).toHaveLength(1);
  });
});
