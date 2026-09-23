/**
 * dsh-desktop preload: the narrow IPC transport boundary.
 *
 * The page never touches ipcRenderer directly. This script exposes exactly
 * three primitives on window.__DSH_DESKTOP__ — invoke, send, on — restricted
 * to the dsh-bridge channel family. All protocol logic (fetch carrier,
 * logical-stream carrier) lives in the page-realm preamble the
 * desktop-runtime plugin injects before the bootstrap batches.
 */
const { contextBridge, ipcRenderer } = require("electron");

// One channel carries every bridge event; the page opens one subscription per
// in-flight request, so the default 10-listener cap is too tight.
ipcRenderer.setMaxListeners(0);

const ALLOWED_PREFIX = "dsh-bridge:";

function assertChannel(channel) {
  if (typeof channel !== "string" || !channel.startsWith(ALLOWED_PREFIX)) {
    throw new Error(`dsh-desktop: channel ${JSON.stringify(channel)} is not in the bridge namespace`);
  }
  return true;
}

contextBridge.exposeInMainWorld("__DSH_DESKTOP__", {
  /** Request/response call into the main-process bridge. */
  invoke(channel, payload) {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, payload);
  },
  /** Fire-and-forget message into the main-process bridge. */
  send(channel, payload) {
    assertChannel(channel);
    ipcRenderer.send(channel, payload);
  },
  /** Subscribe to main-process bridge events; returns the unsubscriber. */
  on(channel, listener) {
    assertChannel(channel);
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
