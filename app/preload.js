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

  /** Save the current answer as a trail the team inherits. */
  saveTrail: (trail) => ipcRenderer.invoke("cairn:save-trail", trail),

  /** A short-lived key for streaming straight to the transcription service. */
  listenToken: () => ipcRenderer.invoke("cairn:listen-token"),

  /** Hand the screen to the full-screen voice experience, or take it back. */
  voiceMode: (on) => ipcRenderer.send("cairn:voice-mode", on),
  activeScreen: () => ipcRenderer.invoke("cairn:active-screen"),

  /** Drive the voice flow's visual stages: listening → heard → thinking. */
  stage: (payload) => ipcRenderer.send("cairn:stage", payload),
  onStage: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on("cairn:stage", h);
    return () => ipcRenderer.off("cairn:stage", h);
  },

  /** Stream caption text as the voice reaches each word. */
  caption: (payload) => ipcRenderer.send("cairn:caption", payload),
  onCaption: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on("cairn:caption", h);
    return () => ipcRenderer.off("cairn:caption", h);
  },

  /** Overlay only: borrow clicks while the pointer is over a control. */
  setClickThrough: (ignore) => ipcRenderer.send("cairn:click-through", ignore),

  /**
   * Escape, pressed while Cairn was on screen but unfocused. The main process
   * holds the key globally for those moments, because a hidden panel receives
   * no keystrokes of its own.
   */
  onEscape: (fn) => {
    const h = () => fn();
    ipcRenderer.on("cairn:escape", h);
    return () => ipcRenderer.off("cairn:escape", h);
  },

  /** Overlay asks to run the walkthrough again; the HUD owns the sequence. */
  requestReplay: () => ipcRenderer.send("cairn:replay"),
  onReplay: (fn) => {
    const h = () => fn();
    ipcRenderer.on("cairn:replay", h);
    return () => ipcRenderer.off("cairn:replay", h);
  },

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
