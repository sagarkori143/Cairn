/**
 * Cairn desktop — main process.
 *
 * This is the part a browser can't be. Three responsibilities:
 *
 *   1. A global hotkey that fires while you're inside any other application.
 *   2. Screen capture with no per-session permission sheet.
 *   3. A transparent, click-through, always-on-top window covering the whole
 *      desktop, so the pointer is drawn on your actual screen rather than on a
 *      mirrored copy of it.
 *
 * All intelligence lives on the server. This process holds no API keys — an
 * Electron app is a zip archive with a rename, so anything shipped inside it is
 * public. It captures pixels, sends them somewhere trusted, and draws what
 * comes back.
 */
const {
  app,
  BrowserWindow,
  globalShortcut,
  desktopCapturer,
  screen,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  shell,
  session,
} = require("electron");
const path = require("node:path");

/**
 * Where the brain lives.
 *
 * Defaults to the deployed instance so a packaged build works on a machine
 * that has never run this repo — the binary has to be useful to someone who
 * only downloaded an .exe. Override with CAIRN_SERVER to develop against a
 * local server.
 */
const SERVER = process.env.CAIRN_SERVER || "https://cairn-mu-amber.vercel.app";

/** Press this anywhere to summon Cairn. */
const HOTKEY = "Control+Alt+C";

let hud = null;
let overlay = null;
let tray = null;

/* --------------------------------------------------------------- windows */

/**
 * The overlay spans the entire virtual desktop — the union of every monitor —
 * rather than one screen. The probe found two displays at different scale
 * factors, and a single-screen overlay would simply fail to draw on the other
 * one.
 */
function virtualBounds() {
  const displays = screen.getAllDisplays();
  const left = Math.min(...displays.map((d) => d.bounds.x));
  const top = Math.min(...displays.map((d) => d.bounds.y));
  const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function createOverlay() {
  const b = virtualBounds();
  overlay = new BrowserWindow({
    ...b,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false, // never steals focus from the app you're actually using
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });

  // Clicks pass straight through to whatever is underneath. Without this the
  // overlay would swallow every click on the desktop it covers.
  overlay.setIgnoreMouseEvents(true, { forward: true });
  // "screen-saver" is the highest standard level — above normal always-on-top
  // windows, so it isn't hidden by other floating panels.
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep Cairn out of Cairn's own screenshots — see captureActiveScreen.
  overlay.setContentProtection(true);
  overlay.loadFile(path.join(__dirname, "renderer", "overlay.html"));
}

function createHud() {
  hud = new BrowserWindow({
    width: 640,
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  hud.setAlwaysOnTop(true, "screen-saver");
  // The HUD must never appear in a capture, or the model answers about Cairn
  // instead of the app underneath it.
  hud.setContentProtection(true);
  hud.loadFile(path.join(__dirname, "renderer", "hud.html"));

  // Dismiss on blur so the HUD never lingers over the app you moved on to.
  hud.on("blur", () => {
    if (hud?.isVisible()) hideAll();
  });
}

/** Parks the HUD near the bottom of whichever screen the mouse is on. */
function positionHud() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  const [w, h] = hud.getSize();
  hud.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height - h - 60));
}

function showHud() {
  if (!hud) return;
  positionHud();
  hud.showInactive(); // appear without stealing focus…
  hud.focus(); // …then take it deliberately, so typing lands here
  hud.webContents.send("cairn:summon");
}

function hideAll() {
  hud?.hide();
  overlay?.hide();
  overlay?.webContents.send("cairn:clear");
}

/* --------------------------------------------------------------- capture */

/**
 * Grabs the display the mouse is currently on, as a PNG data URL.
 *
 * Capturing the pointer's screen rather than "screen 1" is what makes a
 * multi-monitor setup work: you ask about the thing you're looking at, and
 * that's wherever your cursor is.
 *
 * Cairn must not appear in its own screenshot. If it does, the model reads the
 * HUD as part of your screen and answers about Cairn rather than about your
 * work — pointing its own cursor at its own window. Two independent defences,
 * because one silently failing would be hard to notice:
 *
 *   1. setContentProtection excludes these windows from capture at the OS
 *      level (WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+). No flicker; the
 *      windows stay visible to you and are simply absent from the frame.
 *   2. The overlay is hidden outright before the shot. It is a full-desktop
 *      dimming layer, so if defence 1 ever regressed on an older build, it
 *      wouldn't just add a stray window — it would darken the entire capture
 *      and wreck the model's reading of it.
 */
async function captureActiveScreen() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  const overlayWasVisible = overlay?.isVisible() ?? false;
  if (overlayWasVisible) overlay.hide();

  // One compositor frame so the hide actually lands before we grab pixels.
  await new Promise((r) => setTimeout(r, 90));

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        // Cap the long edge: a raw 4K frame is several megabytes and buys no
        // accuracy, since UI text stays legible well below native resolution.
        width: Math.min(display.size.width, 1600),
        height: Math.min(display.size.height, 1000),
      },
    });

    const match =
      sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
    if (!match) throw new Error("No screen available to capture.");

    // With CAIRN_DEBUG_CAPTURE set, drop the exact frame the model will see to
    // disk. The only reliable way to confirm Cairn kept itself out of shot is
    // to look at the picture.
    if (process.env.CAIRN_DEBUG_CAPTURE) {
      try {
        require("node:fs").writeFileSync(
          path.join(require("node:os").tmpdir(), "cairn-last-capture.png"),
          match.thumbnail.toPNG(),
        );
      } catch {
        /* debug aid only — never break a real capture over it */
      }
    }

    return {
      dataUrl: match.thumbnail.toDataURL(),
      base64: match.thumbnail.toPNG().toString("base64"),
      displayId: display.id,
      bounds: display.bounds,
    };
  } catch (err) {
    // Only restore on failure — on success the overlay is about to be shown
    // again with the new answer, and flashing the previous one first is noise.
    if (overlayWasVisible) overlay.showInactive();
    throw err;
  }
}

/* ------------------------------------------------------------ transcribe */

/**
 * Speech-to-text, entirely on this machine.
 *
 * Electron ships without Google's API keys, so the browser SpeechRecognition
 * API — which is what the web version uses — fails here. Rather than send audio
 * to a paid service, Cairn runs Whisper locally.
 *
 * That turns a limitation into the better answer for a tool like this. Cairn
 * already watches your screen; asking users to also stream their voice to a
 * third party is a lot to ask. Nothing recorded here ever leaves the machine —
 * only the resulting text, and only then alongside a screenshot they chose to
 * send.
 *
 * `whisper-tiny.en` is the deliberate pick: ~40MB and roughly a second for a
 * short question. Larger models are more accurate on accents and noise, but the
 * questions people ask a screen assistant are short and domain-obvious, and
 * doubling the wait to better resolve a word the vision model can infer from
 * context anyway is a bad trade.
 */
let whisper = null;
let whisperLoading = null;

async function getWhisper(onProgress) {
  if (whisper) return whisper;
  if (whisperLoading) return whisperLoading;

  whisperLoading = (async () => {
    // @huggingface/transformers is ESM-only; this file is CommonJS, so it has
    // to come in through a dynamic import.
    const { pipeline, env } = await import("@huggingface/transformers");

    // Keep weights beside the app's own data so they survive restarts and are
    // removed with the app, rather than landing in a global npm cache.
    env.cacheDir = path.join(app.getPath("userData"), "models");
    env.allowRemoteModels = true;

    whisper = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
      dtype: "q8", // quantised: about a quarter the size, no meaningful accuracy loss here
      progress_callback: (p) => {
        if (p.status === "progress" && onProgress) {
          onProgress({ file: p.file, percent: Math.round(p.progress ?? 0) });
        }
      },
    });
    return whisper;
  })();

  try {
    return await whisperLoading;
  } finally {
    whisperLoading = null;
  }
}

ipcMain.handle("cairn:transcribe", async (event, { samples }) => {
  try {
    const model = await getWhisper((p) => event.sender.send("cairn:model-progress", p));
    // The renderer already resampled to 16kHz mono, which is what Whisper wants.
    const out = await model(new Float32Array(samples));
    const text = (out?.text ?? "").trim();
    return { ok: true, text };
  } catch (err) {
    console.error("[cairn] transcription failed:", err);
    return { ok: false, error: "Couldn't make out that audio. Try typing instead." };
  }
});

/** Lets the HUD warm the model up before the first question rather than during it. */
ipcMain.handle("cairn:warm-whisper", async (event) => {
  try {
    await getWhisper((p) => event.sender.send("cairn:model-progress", p));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ------------------------------------------------------------------- ipc */

ipcMain.handle("cairn:capture", async () => {
  try {
    return { ok: true, ...(await captureActiveScreen()) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/**
 * Proxies the question to the server. Deliberately a pass-through: the client
 * knows nothing about models, prompts, or keys, so swapping the backend never
 * means shipping a new binary.
 */
ipcMain.handle("cairn:ask", async (_e, { question, frame }) => {
  try {
    const res = await fetch(`${SERVER}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, frame, mediaType: "image/png" }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `Server said ${res.status}` };
    return { ok: true, result: data };
  } catch {
    return {
      ok: false,
      error: `Can't reach Cairn's server at ${SERVER}. Is it running?`,
    };
  }
});

/** Hands the overlay a step to draw, and reveals it. */
ipcMain.on("cairn:draw", (_e, payload) => {
  if (!overlay) return;
  const b = virtualBounds();
  overlay.setBounds(b);
  overlay.showInactive();
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.webContents.send("cairn:draw", { ...payload, virtual: b });
});

ipcMain.on("cairn:clear", () => {
  overlay?.webContents.send("cairn:clear");
  overlay?.hide();
});

ipcMain.on("cairn:dismiss", hideAll);

ipcMain.on("cairn:resize-hud", (_e, { height }) => {
  if (!hud) return;
  const [w] = hud.getSize();
  hud.setSize(w, Math.min(Math.max(Math.round(height), 140), 620));
  positionHud();
});

ipcMain.handle("cairn:server-url", () => SERVER);

/* ------------------------------------------------------------------ tray */

function createTray() {
  // A tiny cairn drawn inline, so the binary needs no icon asset alongside it.
  const icon = nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," +
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
           <ellipse cx="12" cy="19" rx="8" ry="2.6" fill="#5b6072"/>
           <ellipse cx="12" cy="15.5" rx="6.4" ry="2.4" fill="#8b90a3"/>
           <ellipse cx="12" cy="11.6" rx="4.8" ry="2.1" fill="#c9cdd8"/>
           <ellipse cx="12" cy="8.2" rx="3.2" ry="1.8" fill="#ff8f4c"/>
         </svg>`,
      ).toString("base64"),
  );
  tray = new Tray(icon);
  tray.setToolTip(`Cairn — press ${HOTKEY}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Ask Cairn  (${HOTKEY})`, click: showHud },
      { type: "separator" },
      { label: "Open trails in browser", click: () => shell.openExternal(SERVER) },
      { label: `Server: ${SERVER}`, enabled: false },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showHud);
}

/* ------------------------------------------------------------------- app */

// One instance only. A second copy would fight over the global hotkey and
// silently lose, which looks like the hotkey being broken.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showHud);

  app.whenReady().then(() => {
    /*
     * Grant the microphone, and nothing else.
     *
     * Electron denies media by default. Rather than allow everything, this
     * approves only what Cairn needs and refuses the rest — the HUD renders
     * text produced from whatever happened to be on the user's screen, so it
     * should hold the narrowest set of capabilities that still works.
     */
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === "media" || permission === "audioCapture");
    });

    createOverlay();
    createHud();
    createTray();

    if (!globalShortcut.register(HOTKEY, showHud)) {
      console.error(`[cairn] could not register ${HOTKEY} — another app may hold it`);
    }

    // Keep the overlay covering the desktop when monitors are added, removed,
    // or rearranged mid-session.
    screen.on("display-added", () => overlay?.setBounds(virtualBounds()));
    screen.on("display-removed", () => overlay?.setBounds(virtualBounds()));
    screen.on("display-metrics-changed", () => overlay?.setBounds(virtualBounds()));
  });

  // No dock, no taskbar, no window on launch: Cairn lives in the tray and
  // appears only when summoned.
  app.on("window-all-closed", (e) => e.preventDefault());
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
