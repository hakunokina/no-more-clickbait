import type { DesktopStatus } from "../shared/status.js";
import type { DesktopApi } from "./preload.js";

/**
 * The reading window's bridge, Electron-free so it is testable. The
 * window shows two kinds of page:
 * - our own reader.html (preparing / pending / error states): it gets
 *   the narrow `ReaderApi` as `window.nmc`;
 * - the finished timeline.html, which holds untrusted feed content: its
 *   main world gets nothing. Its "Yeni akış topla" / "Tekrar dene"
 *   buttons (`data-action="collect" | "retry"`, packages/timeline-renderer
 *   `actions: true`) are handled here, from the isolated world.
 *
 * Which page is ours is decided by an exact URL match with the file URL
 * main passes in (`READER_PAGE_ARG`); main applies the same rule to
 * every call it receives (ipc-policy.ts).
 */

export type ReaderApi = Pick<
  DesktopApi,
  | "getStatus"
  | "onStatus"
  | "startCollection"
  | "cancelRun"
  | "retryRun"
  | "buildTimeline"
  | "openReader"
>;

export const READER_PAGE_ARG = "--nmc-reader-page=";

/** The reader page's file URL from the preload's argv, if main passed it. */
export function readerPageFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((entry) => entry.startsWith(READER_PAGE_ARG));
  return arg ? arg.slice(READER_PAGE_ARG.length) : null;
}

/** Exact match (no query, no hash, no prefix): only our own page counts. */
export function isReaderPage(href: string, readerPage: string | null): boolean {
  if (!readerPage) return false;
  try {
    return new URL(href).href === new URL(readerPage).href;
  } catch {
    return false;
  }
}

interface Invoker {
  invoke(channel: string): Promise<unknown>;
  on(channel: string, listener: (event: unknown, status: DesktopStatus) => void): void;
  off(channel: string, listener: (event: unknown, status: DesktopStatus) => void): void;
}

interface Exposer {
  exposeInMainWorld(key: string, api: unknown): void;
}

interface ClickTarget {
  addEventListener(type: "click", listener: (event: { target: unknown }) => void): void;
}

export function createReaderApi(ipc: Invoker): ReaderApi {
  return {
    getStatus: () => ipc.invoke("nmc:get-status") as ReturnType<ReaderApi["getStatus"]>,
    onStatus(listener) {
      const handler = (_event: unknown, status: DesktopStatus): void => listener(status);
      ipc.on("nmc:status", handler);
      return () => ipc.off("nmc:status", handler);
    },
    startCollection: () => ipc.invoke("nmc:start-collection") as Promise<void>,
    cancelRun: () => ipc.invoke("nmc:cancel-run") as Promise<boolean>,
    retryRun: () => ipc.invoke("nmc:retry-run") as Promise<void>,
    buildTimeline: () => ipc.invoke("nmc:build-timeline") as Promise<void>,
    openReader: () => ipc.invoke("nmc:open-reader") as Promise<void>,
  };
}

/** Wires the bridge for the page at `href`; returns whether `window.nmc` was exposed. */
export function installReaderBridge(options: {
  href: string;
  argv: readonly string[];
  ipc: Invoker;
  bridge: Exposer;
  document: ClickTarget;
}): boolean {
  const ours = isReaderPage(options.href, readerPageFromArgv(options.argv));
  if (ours) options.bridge.exposeInMainWorld("nmc", createReaderApi(options.ipc));
  else {
    options.document.addEventListener("click", (event) => {
      const element = event.target as { closest?: (selector: string) => unknown } | null;
      const target = element?.closest?.("[data-action]") as {
        getAttribute(name: string): string | null;
      } | null;
      const action = target?.getAttribute("data-action");
      if (action === "collect") void options.ipc.invoke("nmc:start-collection");
      else if (action === "retry") void options.ipc.invoke("nmc:retry-run");
    });
  }
  return ours;
}
