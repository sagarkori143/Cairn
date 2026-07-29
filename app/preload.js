/**
 * The only bridge between the renderers and the OS.
 *
 * Node stays switched off in the windows and everything crosses through this
 * narrow, named surface. That matters more than usual here: the HUD renders
 * text that came back from a model, which read it off whatever happened to be
 * on the user's screen. Treating that as untrusted is the whole point — with
 * node integration enabled, a crafted screenshot could reach the filesystem.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cairn", {
  /** Grab the display the mouse is on. Returns { ok, dataUrl, base64, bounds }. */
  capture: () => ipcRenderer.invoke("cairn:capture"),

  /** Ask the server. Returns { ok, result } or { ok: false, error }. */
  ask: (question, frame) => ipcRenderer.invoke("cairn:ask", { question, frame }),

  serverUrl: () => ipcRenderer.invoke("cairn:server-url"),

  /**
   * Transcribe recorded audio. Takes the raw bytes in whatever container the
   * recorder produced — the server identifies the format, so nothing needs
   * decoding or resampling on this side.
   */
  transcribe: (audio, mimeType) => ipcRenderer.invoke("cairn:transcribe", { audio, mimeType }),

  /** Draw a step on the real desktop. */
  draw: (payload) => ipcRenderer.send("cairn:draw", payload),
  clear: () => ipcRenderer.send("cairn:clear"),
  dismiss: () => ipcRenderer.send("cairn:dismiss"),
  resizeHud: (height) => ipcRenderer.send("cairn:resize-hud", { height }),

  /** Main → renderer. Returns an unsubscribe so listeners can't stack up. */
  onSummon: (fn) => {
    const h = () => fn();
    ipcRenderer.on("cairn:summon", h);
    return () => ipcRenderer.off("cairn:summon", h);
  },
  onDraw: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on("cairn:draw", h);
    return () => ipcRenderer.off("cairn:draw", h);
  },
  onClear: (fn) => {
    const h = () => fn();
    ipcRenderer.on("cairn:clear", h);
    return () => ipcRenderer.off("cairn:clear", h);
  },
});
