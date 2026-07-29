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
const SERVER = process.env.CAIRN_SERVER || "https://cairn-si3g.vercel.app";

/**
 * Press one of these anywhere to summon Cairn — the first that registers wins.
 *
 * Ctrl+Space is the best chord and the least dependable one: on Windows it is
 * also the IME toggle for Japanese, Chinese and Korean input, so on exactly the
 * machines this is most likely to be demonstrated on, it may already be taken.
 * Registering it and logging a failure was no use — the log goes nowhere in a
 * packaged app, so the key simply did nothing and the app looked broken.
 *
 * So it falls down the list instead, and whichever one took is shown in the
 * tray and in the panel rather than assumed.
 */
const HOTKEY_CHOICES = [
  "Control+Space",
  "Control+Shift+Space",
  "Alt+Space",
  "Control+Alt+C",
];

let activeHotkey = null;

/** Reads back the way a keyboard is labelled, not the way Electron spells it. */
function prettyHotkey(accelerator) {
  return (accelerator ?? "")
    .replace("Control", "Ctrl")
    .split("+")
    .join(" + ");
}

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
    width: 760,
    // Close to the ask bar's real height; fit() corrects it once the renderer
    // has measured itself, and starting near the answer avoids a visible jump.
    height: 200,
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

  // Dismiss on blur so the HUD never lingers over the app you moved on to —
  // except during voice, where the panel is hidden deliberately and losing it
  // to a blur would take the whole session with it.
  hud.on("blur", () => {
    if (voiceMode) return;
    if (hud?.isVisible()) hideAll();
  });
}

/**
 * True while the full-screen stage owns the display.
 *
 * Named for voice because that is where it started, but a typed question
 * raises it too: both hand the screen over while the answer is being worked
 * out, and everything that follows from that is the same either way — the
 * panel steps aside, the screenshot is taken without hiding the overlay, and
 * clearing the last walkthrough must not pull the stage down with it.
 *
 * While it is up, the usual "blur means they moved on, put it away" rule has
 * to be suspended — otherwise hiding the panel would immediately tear down the
 * thing it was hiding for.
 */
let voiceMode = false;

/*
 * Which screen this question belongs to.
 *
 * Fixed when the panel opens, and used for everything that follows: the
 * screenshot, the dim, the stage, the pointing. Each of those used to ask
 * independently which display the cursor was nearest, so moving the mouse to
 * another monitor mid-question could dim one screen and point at another. The
 * screen you summoned Cairn on is the one you were looking at.
 */
let activeDisplayId = null;

function activeDisplay() {
  return (
    screen.getAllDisplays().find((d) => d.id === activeDisplayId) ??
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  );
}

/** Parks the HUD near the bottom of whichever screen the mouse is on. */
function positionHud() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  activeDisplayId = display.id;
  const { x, y, width, height } = display.workArea;
  const [w, h] = hud.getSize();
  hud.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height - h - 60));
}

/*
 * Summoning is two steps, because it used to be one.
 *
 * The panel was shown first and reset afterwards, so it arrived at whatever
 * size the last answer had left it, then cleared, resized and moved to the
 * cursor's screen — visibly, twice, before settling. Now the reset happens
 * while it is still hidden and it is only shown once the renderer says the
 * size is final.
 */
let pendingShow = null;

function showHud() {
  if (!hud) return;

  if (hud.isVisible()) {
    hud.focus();
    hud.webContents.send("cairn:summon");
    return;
  }

  hud.webContents.send("cairn:summon");

  // A missing reply must never leave the panel unopenable, so this is a
  // backstop rather than the normal route.
  clearTimeout(pendingShow);
  pendingShow = setTimeout(revealHud, 220);
}

function revealHud() {
  clearTimeout(pendingShow);
  pendingShow = null;
  if (!hud || hud.isVisible()) return;

  positionHud();
  hud.showInactive(); // appear without stealing focus…
  hud.focus(); // …then take it deliberately, so typing lands here
  syncEscapeCapture();
}

function hideAll() {
  hud?.hide();
  overlay?.hide();
  overlay?.webContents.send("cairn:clear");
  syncEscapeCapture();
}

/**
 * Escape has to reach Cairn when Cairn doesn't have focus.
 *
 * It was a keydown listener in the panel, which works only while the panel is
 * focused — and the panel is hidden for the whole voice flow, while the
 * overlay is deliberately unfocusable so it never steals clicks. So Escape did
 * nothing at exactly the moment it was wanted most: something talking over you
 * with no visible way to stop it.
 *
 * Taking a key globally is worth being careful about — Escape belongs to every
 * other app too. It is held only while something of Cairn's is actually on
 * screen and released the moment nothing is, so outside those few seconds
 * nothing is intercepted.
 */
let escapeHeld = false;

function syncEscapeCapture() {
  const wanted = Boolean(voiceMode || overlay?.isVisible() || hud?.isVisible());
  if (wanted === escapeHeld) return;

  escapeHeld = wanted;
  if (wanted) {
    globalShortcut.register("Escape", () => hud?.webContents.send("cairn:escape"));
  } else {
    globalShortcut.unregister("Escape");
  }
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
  const display = activeDisplay();

  // Under voice, defence 2 is skipped and the shot is taken with the overlay
  // still up. Hiding it would be a visible flash — the overlay is the entire
  // screen at that point — and this capture now happens while the user is
  // still speaking, so there is no moment when a blink would go unnoticed.
  // Measured before relying on it: with content protection on, a full-screen
  // dimming overlay changed the captured frame's mean luminance by 0.00.
  const hideForShot = !voiceMode;
  const overlayWasVisible = overlay?.isVisible() ?? false;
  if (overlayWasVisible && hideForShot) overlay.hide();

  // One compositor frame so the hide actually lands before we grab pixels.
  if (hideForShot) await new Promise((r) => setTimeout(r, 90));

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

    // Voice is the exception to leaving it hidden: the overlay is the only
    // thing on screen during a voice question, so staying hidden until the
    // answer lands blanks the display for the whole model call — the wait
    // looked like a crash. The frame is already captured by this point, so
    // showing it again cannot contaminate the shot.
    // Only meaningful when the shot did hide it; under voice it never left.
    if (overlayWasVisible && hideForShot && voiceMode) {
      overlay.showInactive();
      // Showing a window again drops it out of the topmost band, so without
      // this it returns behind whatever you were working in — present, drawing
      // correctly, and invisible.
      overlay.setAlwaysOnTop(true, "screen-saver");
    }

    return {
      dataUrl: match.thumbnail.toDataURL(),
      base64: match.thumbnail.toPNG().toString("base64"),
      displayId: display.id,
      bounds: display.bounds,
    };
  } catch (err) {
    // Outside voice, restore only on failure — on success the overlay is about
    // to be shown again with the answer, and flashing the previous one first
    // is noise.
    if (overlayWasVisible && hideForShot) overlay.showInactive();
    throw err;
  }
}

/* ------------------------------------------------------------ transcribe */

/**
 * Speech-to-text, via the server.
 *
 * This started as local Whisper, which was appealing — audio never leaving the
 * machine is a genuinely good property for a tool that already watches your
 * screen. It was replaced because accuracy came first: the small models that
 * are practical to ship mistranscribed accented English badly enough to be
 * unusable, and a misheard question is worse than a slow one. It quietly
 * produces a confident answer to something you never asked.
 *
 * Transcription runs server-side rather than here for the same reason the
 * vision call does: an Electron app is a zip archive with a different
 * extension, so any key shipped inside it is public. The client records audio
 * and posts the bytes; the credentials stay on the server.
 *
 * The audio goes over the wire in its original container. Deepgram sniffs the
 * format itself, so there is no resampling or transcoding to get wrong on this
 * side — which removes an entire class of bug that local inference required us
 * to own.
 */
ipcMain.handle("cairn:transcribe", async (_e, { audio, mimeType }) => {
  try {
    const res = await fetch(`${SERVER}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": mimeType || "audio/webm" },
      body: Buffer.from(audio),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `Server said ${res.status}` };
    return { ok: true, text: data.text ?? "", confidence: data.confidence ?? 0 };
  } catch {
    return {
      ok: false,
      error: `Can't reach Cairn's server at ${SERVER}. Type your question instead.`,
    };
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

/**
 * Promotes a live answer into team memory.
 *
 * This is the half that makes Cairn more than a screen reader: the next person
 * to hit the same wall gets this back instantly, without a model call. The
 * server refuses if it has no persistent storage, so the client doesn't need to
 * know which mode it's in — it offers the save and reports what came back.
 */
ipcMain.handle("cairn:save-trail", async (_e, trail) => {
  try {
    const res = await fetch(`${SERVER}/api/trails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trail),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `Server said ${res.status}` };
    return { ok: true, trail: data.trail };
  } catch {
    return { ok: false, error: `Can't reach Cairn's server at ${SERVER}.` };
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
  syncEscapeCapture();
});

/**
 * Hands the screen to the voice experience, and takes it back afterwards.
 *
 * The overlay is shown up front so the listening state has somewhere to live
 * before any answer exists.
 */
ipcMain.on("cairn:voice-mode", (_e, on) => {
  voiceMode = Boolean(on);
  if (voiceMode) {
    hud?.hide();
    const b = virtualBounds();
    overlay?.setBounds(b);
    overlay?.showInactive();
    overlay?.setAlwaysOnTop(true, "screen-saver");

    // Paint the listening state here rather than waiting for the renderer to
    // ask which screen it is on and send its own first frame. Everything after
    // this — a token, a socket, the microphone — takes long enough that the
    // click needs to have visibly landed before any of it starts.
    const display = activeDisplay();
    overlay?.webContents.send("cairn:stage", {
      kind: "listening",
      level: 0,
      hint: "Getting ready",
      bounds: display.bounds,
      virtual: b,
    });
  } else if (hud && !hud.isVisible()) {
    positionHud();
    hud.showInactive();
    hud.focus();
  }
  syncEscapeCapture();
});

/**
 * Fetches a short-lived Deepgram key so the renderer can stream audio directly.
 *
 * Live transcription needs a WebSocket held open for the length of an
 * utterance, which a serverless function cannot do — so the server can't relay
 * the audio. Instead it mints a key scoped to transcription and expiring in
 * under a minute. The long-lived key stays on the server; the worst a leaked
 * temporary one buys is a few seconds of someone else's dictation.
 */
ipcMain.handle("cairn:listen-token", async () => {
  try {
    const res = await fetch(`${SERVER}/api/listen-token`);
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `Server said ${res.status}` };
    return { ok: true, ...data };
  } catch {
    return { ok: false, error: `Can't reach Cairn's server at ${SERVER}.` };
  }
});

/** Which screen the voice experience should draw on. */
ipcMain.handle("cairn:active-screen", () => {
  const display = activeDisplay();
  return { bounds: display.bounds, virtual: virtualBounds() };
});

/** Stage of the voice flow: listening → heard → thinking. */
ipcMain.on("cairn:stage", (_e, payload) => {
  overlay?.webContents.send("cairn:stage", payload);
});

/** Caption text, streamed word by word as the voice speaks it. */
ipcMain.on("cairn:caption", (_e, payload) => {
  overlay?.webContents.send("cairn:caption", payload);
});

ipcMain.on("cairn:clear", () => {
  overlay?.webContents.send("cairn:clear");
  // Asking a question clears the last answer's drawing first. Under voice that
  // happens while the overlay is the only thing on screen, so hiding the window
  // here blanked the display for the entire model call — and left the capture
  // that follows believing the overlay was never visible, so nothing restored
  // it either. The voice flow hides it through its own "off" path.
  if (!voiceMode) overlay?.hide();
  syncEscapeCapture();
});

/**
 * Lets the overlay become clickable for a moment.
 *
 * The overlay is click-through so it never swallows a click meant for the app
 * underneath — but that also makes anything drawn on it unclickable, including
 * the replay button. Electron keeps forwarding mouse *movement* while ignoring
 * clicks, so the overlay can notice the pointer entering a control and ask for
 * clicks back just for that moment, then hand them straight over again.
 */
ipcMain.on("cairn:click-through", (_e, ignore) => {
  overlay?.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});

ipcMain.on("cairn:dismiss", hideAll);

ipcMain.on("cairn:hud-ready", revealHud);

ipcMain.on("cairn:resize-hud", (_e, { height }) => {
  if (!hud) return;

  const next = Math.min(Math.max(Math.round(height), 140), 620);
  const bounds = hud.getBounds();
  if (bounds.height === next) return;

  /*
   * setBounds, not setSize.
   *
   * A window created with resizable:false has its minimum and maximum size
   * pinned to the size it was made at, and setSize honours that — so the panel
   * could grow to fit an answer but never shrink back, not even to the height
   * it started at. Every later question inherited the tallest panel ever shown,
   * and summoning it dropped a box of empty glass onto the screen. setBounds
   * is not bound by those limits, and the window stays non-resizable by hand.
   */
  hud.setBounds({ ...bounds, height: next });

  // While hidden there is nothing to keep in place, and revealHud positions it
  // on the way in — repositioning here would only move a window nobody sees.
  if (hud.isVisible()) positionHud();
});

ipcMain.handle("cairn:server-url", () => SERVER);

/** Whichever chord actually registered, or null if every one was taken. */
ipcMain.handle("cairn:hotkey", () => (activeHotkey ? prettyHotkey(activeHotkey) : null));

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
  tray.on("click", showHud);
  refreshTray();
}

/**
 * Starting with Windows.
 *
 * Only offered from a packaged build: in development the executable is
 * Electron itself, and registering that would launch a bare Electron at every
 * login long after this checkout is gone. It records the exe's current path,
 * so moving a portable Cairn after enabling this leaves a dead entry — which
 * is why it is a choice in the tray and not something switched on by default.
 */
function autoStartEnabled() {
  return app.isPackaged && app.getLoginItemSettings().openAtLogin;
}

function setAutoStart(on) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [] });
  refreshTray();
}

/** Rebuilt rather than mutated, because the labels carry live state. */
function refreshTray() {
  if (!tray) return;

  const key = activeHotkey ? prettyHotkey(activeHotkey) : null;
  tray.setToolTip(key ? `Cairn — press ${key}` : "Cairn — click to ask");

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: key ? `Ask Cairn  (${key})` : "Ask Cairn", click: showHud },
      ...(activeHotkey
        ? []
        : [{ label: "No hotkey available — every choice was taken", enabled: false }]),
      { type: "separator" },
      {
        label: "Start with Windows",
        type: "checkbox",
        checked: autoStartEnabled(),
        enabled: app.isPackaged,
        click: (item) => setAutoStart(item.checked),
      },
      { type: "separator" },
      { label: "Open trails in browser", click: () => shell.openExternal(SERVER) },
      { label: `Server: ${SERVER}`, enabled: false },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
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

    for (const choice of HOTKEY_CHOICES) {
      if (globalShortcut.register(choice, showHud)) {
        activeHotkey = choice;
        break;
      }
      console.warn(`[cairn] ${choice} is taken, trying the next one`);
    }
    if (!activeHotkey) {
      console.error("[cairn] no hotkey available — the tray icon still opens Cairn");
    }
    refreshTray();

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
