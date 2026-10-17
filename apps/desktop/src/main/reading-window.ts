import { BrowserWindow, session, shell, type Session } from "electron";
import { externalLinkTarget, isAllowedReaderUrl } from "./reader-policy.js";

/**
 * The reading window: our own status page while a timeline is being
 * prepared (reader.html), then the finished `timeline.html` from the
 * session folder. That file holds untrusted feed content, so:
 * - sandbox + context isolation, no Node, a separate in-memory session;
 * - every request is allow-listed: files under our renderer dir or the
 *   sessions root, https images from pbs.twimg.com and video from
 *   video.twimg.com, Instagram media from *.cdninstagram.com and
 *   *.fbcdn.net (the renderer's CSP says the same), data: URIs, and
 *   generic cards' images as nmc-img:, which only this session serves
 *   (the app fetches them itself, see reader-images.ts);
 * - no permission is ever granted, no in-window navigation, no popups:
 *   https links open in the user's browser, anything else is dropped.
 */

let readerSession: Session | null = null;

function lockedDownSession(
  fileRoots: readonly string[],
  images: ReadingWindowImages | undefined,
): Session {
  if (readerSession) return readerSession;
  const ses = session.fromPartition("nmc-reader");
  if (images) ses.protocol.handle(images.scheme, (request) => images.handle(request));
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedReaderUrl(details.url, fileRoots) });
  });
  readerSession = ses;
  return ses;
}

/** Generic cards' images: a scheme served in the reading window's session only. */
export interface ReadingWindowImages {
  scheme: string;
  handle(request: Request): Promise<Response>;
  /** The page shown now: a timeline's path (its images), or null (our own page, none). */
  show(timelinePath: string | null): void;
}

export interface ReadingWindowOptions {
  preload: string;
  /** Passed to the preload's argv (it tells our own page from a timeline). */
  preloadArguments?: string[];
  /** Window / taskbar icon file. */
  icon: string;
  /** Our own status page (preparing / error / empty states). */
  appPage: string;
  /** Directories the window may load files from. */
  fileRoots: readonly string[];
  images?: ReadingWindowImages;
}

export class ReadingWindow {
  readonly #options: ReadingWindowOptions;
  #window: BrowserWindow | null = null;
  #showing: "app" | "timeline" = "app";
  /** The file shown now. */
  #file: string | null = null;
  /** The user asked for a new timeline here: show it as soon as it is ready. */
  #waiting = false;

  constructor(options: ReadingWindowOptions) {
    this.#options = options;
  }

  get webContents(): Electron.WebContents | null {
    return this.#window && !this.#window.isDestroyed() ? this.#window.webContents : null;
  }

  /** Opens (or focuses) the window on the timeline, or on the status page. */
  open(timelinePath: string | null): void {
    const win = this.#ensure();
    if (timelinePath) this.#load(win, "timeline", timelinePath);
    else this.#load(win, "app", this.#options.appPage);
    win.show();
    win.focus();
  }

  /** A new timeline was requested from the UI: switch to the status page. */
  expectTimeline(): void {
    this.#waiting = true;
    const win = this.#window;
    if (win && !win.isDestroyed() && this.#showing === "timeline") {
      this.#load(win, "app", this.#options.appPage);
    }
  }

  /**
   * A timeline is ready. Shown right away when the user is waiting for
   * it here; an older timeline the user is reading is not swapped out
   * (the tray notification offers the new one).
   */
  timelineReady(timelinePath: string): boolean {
    const win = this.#window;
    if (!win || win.isDestroyed()) return false;
    if (!this.#waiting && this.#showing === "timeline") return false;
    this.#waiting = false;
    this.#load(win, "timeline", timelinePath);
    return true;
  }

  /** The timeline file was written again (a language change): show the new one if it is open. */
  reloadTimeline(timelinePath: string): void {
    const win = this.#window;
    if (!win || win.isDestroyed()) return;
    if (this.#showing === "timeline" && this.#file === timelinePath) {
      this.#load(win, "timeline", timelinePath);
    }
  }

  #load(win: BrowserWindow, showing: "app" | "timeline", file: string): void {
    this.#showing = showing;
    this.#file = file;
    this.#options.images?.show(showing === "timeline" ? file : null);
    void win.loadFile(file);
  }

  #ensure(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const win = new BrowserWindow({
      width: 720,
      height: 900,
      minWidth: 360,
      minHeight: 480,
      show: false,
      title: "No More Clickbait",
      icon: this.#options.icon,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.#options.preload,
        additionalArguments: this.#options.preloadArguments ?? [],
        session: lockedDownSession(this.#options.fileRoots, this.#options.images),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    const contents = win.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      const target = externalLinkTarget(url);
      if (target) void shell.openExternal(target);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const target = externalLinkTarget(url);
      if (target) void shell.openExternal(target);
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    win.on("closed", () => {
      this.#window = null;
      this.#file = null;
      this.#waiting = false;
    });
    this.#window = win;
    return win;
  }
}
