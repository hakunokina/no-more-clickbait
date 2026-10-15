import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeChannel, type NativePort } from "./native-channel.js";

interface Port extends NativePort {
  posted: { type: string }[];
  disconnect: ReturnType<typeof vi.fn>;
}

function setup(retireTimeoutMs?: number) {
  const ports: Port[] = [];
  const channel = new NativeChannel<Port>(() => {
    const port: Port = {
      posted: [],
      postMessage: (message) => port.posted.push(message as { type: string }),
      disconnect: vi.fn(),
    };
    ports.push(port);
    return port;
  }, retireTimeoutMs);
  return { channel, ports };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NativeChannel", () => {
  it("opens a port with a ping and reuses it", () => {
    const { channel, ports } = setup();
    expect(channel.send({ type: "ping" })).toBe(true);
    expect(channel.port()).toBe(ports[0]);
    expect(ports).toHaveLength(1);
    expect(ports[0]?.posted.map((m) => m.type)).toEqual(["ping", "ping"]);
  });

  it("closes a retired port only once its host answered everything", () => {
    const { channel, ports } = setup();
    channel.send({ type: "collection-start-result", outcome: "started", target: 5 });
    const old = ports[0] as Port;
    channel.retire();
    expect(channel.current).toBeNull();

    // New messages go to a new host process right away.
    channel.send({ type: "ping" });
    expect(ports).toHaveLength(2);

    channel.received(old, { type: "pong" });
    // Pushes answer nothing.
    channel.received(old, {
      type: "link-status",
      desktopConnected: true,
      extensionConnected: true,
    });
    channel.received(old, { type: "start-collection" });
    channel.received(old, { type: "settings-push" });
    expect(old.disconnect).not.toHaveBeenCalled();
    channel.received(old, { type: "collection-recorded" });
    expect(old.disconnect).toHaveBeenCalledTimes(1);
    expect(ports[1]?.disconnect).not.toHaveBeenCalled();
  });

  it("closes an answered port at once and a silent one after the timeout", () => {
    vi.useFakeTimers();
    const { channel, ports } = setup(1_000);
    channel.port();
    channel.received(ports[0] as Port, { type: "pong" });
    channel.retire();
    expect(ports[0]?.disconnect).toHaveBeenCalledTimes(1);

    channel.port();
    channel.retire();
    expect(ports[1]?.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(ports[1]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("forgets a port the host closed and reports a failed send", () => {
    const { channel, ports } = setup();
    const first = channel.port();
    expect(channel.lost(first)).toBe(true);
    expect(channel.current).toBeNull();

    const second = channel.port();
    second.postMessage = () => {
      throw new Error("Attempting to use a disconnected port object");
    };
    expect(channel.send({ type: "ping" })).toBe(false);
    expect(channel.current).toBeNull();
    expect(ports).toHaveLength(2);
    // A stale port's disconnect is not the current one's.
    expect(channel.lost(first)).toBe(false);
  });
});
