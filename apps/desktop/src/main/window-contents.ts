/**
 * Electron-free helpers for talking to windows that may be gone. A
 * closed BrowserWindow throws "Object has been destroyed" on *any*
 * property access, `webContents` included, so the window itself must be
 * checked first; a status pushed from a socket callback (a host
 * reconnecting) after the monitor was closed used to take main down.
 */

export interface ContentsLike {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

/** The window's contents, or null when there is no live window. */
export function liveContents<C extends ContentsLike>(
  win: { isDestroyed(): boolean; readonly webContents: C } | null | undefined,
): C | null {
  if (!win || win.isDestroyed()) return null;
  const contents = win.webContents;
  return contents.isDestroyed() ? null : contents;
}

/**
 * Sends to every live target. One failing window (torn down between the
 * check and the send) is logged and skipped; it never stops the others
 * or throws into the caller.
 */
export function sendToAll(
  targets: readonly (ContentsLike | null)[],
  channel: string,
  payload: unknown,
  log?: (line: string) => void,
): void {
  for (const contents of targets) {
    if (!contents || contents.isDestroyed()) continue;
    try {
      contents.send(channel, payload);
    } catch (error) {
      log?.(`${channel} not delivered: ${String(error)}`);
    }
  }
}
