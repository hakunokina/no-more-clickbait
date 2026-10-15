import { describe, expect, it } from "vitest";
import { monitorActions } from "./actions.js";
import { initialStatus, type DesktopStatus } from "./status.js";

function status(mutate: (status: DesktopStatus) => void): DesktopStatus {
  const next = initialStatus();
  next.link.listening = true;
  next.run.sessionId = "2026-01-01T10-00-00-000Z-ab12";
  mutate(next);
  return next;
}

describe("monitorActions", () => {
  it("collects when nothing else is to do (disabled until the link listens)", () => {
    expect(monitorActions(status(() => undefined))).toMatchObject({
      primary: "collect",
      collectLink: false,
    });
    expect(monitorActions(initialStatus())).toMatchObject({
      primary: "collect",
      disabled: true,
    });
  });

  it("cancels a collection, then shows it is cancelling", () => {
    const collecting = status((s) => (s.collection.state = "collecting"));
    expect(monitorActions(collecting)).toEqual({
      primary: "cancel",
      label: "Cancel collection",
      disabled: false,
      collectLink: false,
    });
    const cancelling = status((s) => (s.collection.state = "cancelling"));
    expect(monitorActions(cancelling)).toMatchObject({
      label: "Cancelling…",
      disabled: true,
    });
  });

  it("only collects again after a collection was cancelled, even after a failed run", () => {
    // The controller clears an old error/cancel when a collection starts.
    const afterCancel = status((s) => {
      s.collection.message = "Collection cancelled; no timeline was built.";
    });
    expect(monitorActions(afterCancel)).toMatchObject({
      primary: "collect",
      collectLink: false,
    });
  });

  it("builds the cancelled run's posts again, with collecting as the secondary link", () => {
    const cancelled = status((s) => {
      s.run.stage = "cancelled";
      s.run.counts.postsIn = 84;
    });
    expect(monitorActions(cancelled)).toEqual({
      primary: "rebuild",
      label: "Build timeline from 84 posts",
      disabled: false,
      collectLink: true,
    });
  });

  it("offers Try again only after an error, for the same posts", () => {
    const failed = status((s) => (s.run.stage = "error"));
    expect(monitorActions(failed)).toMatchObject({
      primary: "retry",
      label: "Try again with the same posts",
      collectLink: true,
    });
  });

  it("builds a pending collection; a running pipeline can only be cancelled", () => {
    const pending = status((s) => {
      s.pending = {
        sessionId: "2026-01-01T10-00-00-000Z-ab12",
        uniquePostCount: 3,
        mode: "B",
        reason: "not-logged-in",
        target: 100,
      };
    });
    expect(monitorActions(pending)).toMatchObject({
      primary: "build",
      label: "Build timeline anyway",
      collectLink: true,
    });
    const running = status((s) => (s.run.stage = "scoring"));
    expect(monitorActions(running)).toMatchObject({
      primary: "cancel",
      label: "Cancel run",
      collectLink: false,
    });
  });
});
