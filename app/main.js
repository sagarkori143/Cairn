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
  dialog,
  net,
} = require("electron");
const path = require("node:path");

/**
 * Says why a request failed, rather than that it did.
 *
 * Every call below used to catch the error and throw it away, so a wrong system
 * clock, a blocked domain, a captive portal, a proxy and a genuine outage all
 * produced the same sentence — and the person holding the app, the only one who
 * could fix any of it, was told nothing. The server being fine is not much use
 * to somebody whose machine cannot reach it.
 */
function describeNetworkError(err) {
  const text = `${err?.message ?? err} ${err?.cause?.code ?? ""}`.toUpperCase();
  const saw = (...needles) => needles.some((n) => text.includes(n));

  if (saw("ERR_NAME_NOT_RESOLVED", "ENOTFOUND", "EAI_AGAIN"))
    return "the address wouldn't resolve — DNS is failing, or this network blocks it";
  if (saw("ERR_INTERNET_DISCONNECTED", "ENETUNREACH"))
    return "this machine is offline";
  if (saw("ERR_CERT", "CERT_", "UNABLE_TO_VERIFY", "ERR_SSL", "SELF_SIGNED"))
    return "the secure connection was rejected — usually a wrong system clock, or antivirus inspecting HTTPS";
  if (saw("ERR_PROXY", "ERR_TUNNEL_CONNECTION_FAILED"))
    return "a proxy refused the connection";
  if (saw("ABORT", "TIMED", "ETIMEDOUT"))
    return "the server didn't answer in time";
  if (saw("ECONNREFUSED", "ERR_CONNECTION_REFUSED"))
    return "the connection was refused";
  if (saw("ERR_BLOCKED", "ERR_ACCESS_DENIED"))
    return "something on this machine blocked it — antivirus or a firewall";

  return err?.message ? `it failed with: ${err.message}` : "it failed for an unknown reason";
}

/** Long enough for a vision answer, short enough not to hang forever. */
const CALL_TIMEOUT = 45000;

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
 * The rectangle the overlay occupies: exactly one display.
 *
 * It used to span the whole virtual desktop as a single window, which is where
 * a long-standing misalignment came from. A window gets one DPI context, and
 * these two monitors do not share a scale factor — 1.25 on the laptop against
 * 1.0 on the external — so a single window covering both could map its CSS
 * pixels onto one of them or the other, never both. Everything drew correctly
 * on one screen and landed offset on the other, which put the cursor beside the
 * control instead of on it.
 *
 * One window, one screen, one scale factor, and the coordinate maths reduces to
 * a multiply. It also answers the question directly: the dim covers the whole
 * screen the question was asked on, and no part of any other.
 */
function stageBounds() {
  return { ...activeDisplay().bounds };
}

/**
 * Puts the overlay over one whole screen.
 *
 * Verified with a per-monitor-DPI-aware probe rather than by eye: asking for
 * the laptop's 1536x960 device-independent pixels produces a window measuring
 * 1920x1200 true physical pixels at that screen's origin — the whole panel,
 * exactly. A DPI-unaware probe reports the same window as 1536x960, which
 * looks like a bug and is not one; anything checking this has to declare its
 * own DPI awareness first or it will be measuring Windows' compatibility
 * scaling instead of the window.
 */
function fitOverlay() {
  if (!overlay) return null;
  const b = stageBounds();
  overlay.setBounds(b);
  return b;
}

function createOverlay() {
  const b = stageBounds();
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
  // Left capturable on purpose, and switched off only for the instant a frame
  // is taken — see withCairnHiddenFromCapture.
  overlay.loadFile(path.join(__dirname, "renderer", "overlay.html"));
}

function createHud() {
  hud = new BrowserWindow({
    // 736 of panel plus the 30px margin each side that the shadow falls into.
    width: 796,
    // Close to the ask bar's real height; fit() corrects it once the renderer
    // has measured itself, and starting near the answer avoids a visible jump.
    height: 236,
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
  hud.loadFile(path.join(__dirname, "renderer", "hud.html"));

  /*
   * Nothing is summoned before the renderer can hear it.
   *
   * On launch the panel was asked to appear in the same breath as being
   * created, so the summon arrived at a document that had not run its script
   * yet and no listener caught it. The fallback timer then showed the panel at
   * its creation height, the renderer finished loading, measured itself, and
   * resized in full view — appear, jump, settle.
   */
  hud.webContents.once("did-finish-load", () => {
    hudLoaded = true;
    if (summonWhenLoaded) {
      summonWhenLoaded = false;
      showHud();
    }
  });

  /*
   * Nothing dismisses this but Escape.
   *
   * It used to hide on blur, on the reasoning that losing focus meant you had
   * moved on. That reasoning is exactly backwards for what this does: a
   * walkthrough tells you to click something, and clicking it moves focus to
   * the app being explained — so following the instruction cancelled the
   * instructions, mid-sentence, with the cursor still pointing at the thing.
   *
   * Focus is a bad proxy for intent here. Escape is stated in the panel, works
   * from anywhere, and stops everything at once; that is the way out.
   */
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
let hudLoaded = false;
let summonWhenLoaded = false;
let lastInk = null;

function showHud() {
  if (!hud) return;

  // Too early — the renderer cannot reset or measure itself yet, and showing
  // it now means doing both afterwards where they can be seen.
  if (!hudLoaded) {
    summonWhenLoaded = true;
    return;
  }

  if (hud.isVisible()) {
    hud.focus();
    hud.webContents.send("cairn:summon");
    // Both, and in this order. The summon clears the panel back to invisible
    // ready to be faded in, so without the second message a hotkey pressed
    // while it was already on screen would simply blank it.
    hud.webContents.send("cairn:shown");
    return;
  }

  // Placed before it is sampled, or the reading comes from wherever the panel
  // happened to be last time. Positioning a hidden window costs nothing, and
  // revealHud does it again on the way in.
  positionHud();

  /*
   * Last time's answer, applied before this one is on screen.
   *
   * Sampling takes a few hundred milliseconds, so styling only on the result
   * meant the panel appeared in one state and changed into another once the
   * reading landed — which is a flicker, and was the one people saw. The
   * backdrop behind a panel is nearly always what it was last time, so that is
   * assumed up front and corrected silently if it turns out to have changed.
   */
  if (lastInk) hud.webContents.send("cairn:backdrop", { ink: lastInk });

  // Started here, before the panel is on screen, and deliberately not awaited.
  //
  // It used to run just after revealing, wrapped in the same content-protection
  // toggle the screenshots use — and flipping that flag on a window that has
  // just appeared makes Windows recompose it, which is the flicker that looked
  // like the panel arriving twice. Grabbing the frame while the panel is still
  // hidden needs no flag at all, and the frame is the honest one: what is
  // behind the panel, rather than the panel.
  readBackdrop();

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

  /*
   * The window is made transparent before it is shown, and given back its
   * alpha a couple of frames later.
   *
   * A hidden window keeps whatever it last painted. Chromium does not produce
   * frames for it, so telling the renderer to blank itself while hidden
   * changes the DOM and not the pixels — and showing the window presents that
   * stale frame, the fully drawn panel from last time, for about one frame
   * before the new one arrives.
   *
   * That was the flicker, and it is invisible to everything except the screen:
   * sampling the pixels showed luminance jump to 35, fall back to the
   * desktop's 25 twelve milliseconds later, and only then begin the fade.
   * Window rectangles said it appeared once; computed opacity said it faded in
   * cleanly. Both were describing intent rather than output.
   *
   * There was a longer pause in front of this for a while, on the theory that
   * the flicker needed time to settle out of. It did not — this is what the
   * flicker was — so the wait is gone and the summon is immediate again.
   */
  hud.setOpacity(0);
  positionHud();
  hud.showInactive(); // appear without stealing focus…
  hud.focus(); // …then take it deliberately, so typing lands here
  syncEscapeCapture();

  setTimeout(() => {
    if (!hud) return;
    hud.setOpacity(1);
    // Only now, with the stale frame replaced, is there any point playing an
    // entrance. The animation lives on a class rather than on load, because
    // the window loads once and is shown many times.
    hud.webContents.send("cairn:shown");
  }, 40);
}

/**
 * Works out whether the panel is sitting on something light or something dark.
 *
 * The glass itself never changes — only the lettering on it does. Tinting the
 * material light or dark to suit the background made it stop reading as glass
 * and start reading as two different cards, so the panel stays one piece of
 * frosted material that takes its colour from whatever is behind it, and the
 * text switches shade to stay legible on top.
 */
async function readBackdrop() {
  if (!hud) return;

  try {
    const display = activeDisplay();

    // No content-protection flag here: this is called while the panel is
    // hidden, so the frame already excludes it, and toggling the flag on a
    // window that is on screen makes Windows recompose it visibly.
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 480, height: 300 },
    });
    const shot =
      sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
    if (!shot || !hud) return;

    // Where the panel will sit, as a fraction of the display, then in
    // thumbnail px. positionHud has already placed it, even while hidden.
    const b = hud.getBounds();
    const d = display.bounds;
    const size = shot.thumbnail.getSize();
    const rect = {
      x: Math.round(((b.x - d.x) / d.width) * size.width),
      y: Math.round(((b.y - d.y) / d.height) * size.height),
      width: Math.round((b.width / d.width) * size.width),
      height: Math.round((b.height / d.height) * size.height),
    };

    // A panel half off-screen would crop to nothing and throw.
    rect.x = Math.max(0, Math.min(rect.x, size.width - 2));
    rect.y = Math.max(0, Math.min(rect.y, size.height - 2));
    rect.width = Math.max(2, Math.min(rect.width, size.width - rect.x));
    rect.height = Math.max(2, Math.min(rect.height, size.height - rect.y));

    const bmp = shot.thumbnail.crop(rect).toBitmap(); // BGRA
    let sum = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      sum += 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2];
    }
    const luma = sum / (bmp.length / 4);

    // Only the lettering changes. The material stays the same piece of glass
    // whatever is behind it — swapping its tint was the thing that stopped it
    // looking like glass at all.
    lastInk = luma > 132 ? "dark" : "light";
    hud.webContents.send("cairn:backdrop", { ink: lastInk, luma: Math.round(luma) });
  } catch {
    /* the panel has a perfectly good default — never fail a summon over this */
  }
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
 *   1. Content protection is switched on for the instant the frame is taken,
 *      excluding these windows at the OS level (WDA_EXCLUDEFROMCAPTURE on
 *      Windows 10 2004+). No flicker; they stay visible to you and are simply
 *      absent from the frame.
 *   2. The overlay is hidden outright before the shot. It is a full-desktop
 *      dimming layer, so if defence 1 ever regressed on an older build, it
 *      wouldn't just add a stray window — it would darken the entire capture
 *      and wreck the model's reading of it.
 */
/**
 * Makes Cairn invisible to capture for exactly as long as `grab` takes.
 *
 * Content protection used to be permanent, which kept Cairn out of the model's
 * screenshots and out of everybody's screen recordings at the same time — so a
 * recording of the product showed a walkthrough happening to an empty desktop,
 * with the thing doing it missing from the video. Those are different needs
 * pretending to be one: the frame sent to a model must not contain Cairn, and
 * a recording must.
 *
 * So it is off by default, and switched on around the grab. The wait is for the
 * compositor: the flag is set on the window immediately, but a frame already in
 * flight can still carry the old contents.
 */
async function withCairnHiddenFromCapture(grab) {
  overlay?.setContentProtection(true);
  hud?.setContentProtection(true);
  await new Promise((r) => setTimeout(r, 80));

  try {
    return await grab();
  } finally {
    overlay?.setContentProtection(false);
    hud?.setContentProtection(false);
  }
}

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
    const sources = await withCairnHiddenFromCapture(() =>
      desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {
          // Cap the long edge: a raw 4K frame is several megabytes and buys no
          // accuracy, since UI text stays legible well below native resolution.
          width: Math.min(display.size.width, 1600),
          height: Math.min(display.size.height, 1000),
        },
      }),
    );

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
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `Server said ${res.status}` };
    return { ok: true, text: data.text ?? "", confidence: data.confidence ?? 0 };
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't reach Cairn's server — ${describeNetworkError(err)}. Type your question instead.`,
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
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `Server said ${res.status}` };
    return { ok: true, result: data };
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't reach Cairn's server — ${describeNetworkError(err)}. Tray icon → Check connection for detail.`,
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
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `Server said ${res.status}` };
    return { ok: true, trail: data.trail };
  } catch (err) {
    return { ok: false, error: `Couldn't save — ${describeNetworkError(err)}.` };
  }
});

/** Hands the overlay a step to draw, and reveals it. */
ipcMain.on("cairn:draw", (_e, payload) => {
  if (!overlay) return;
  // The window is the screen, so the renderer's virtual origin is its own
  // origin and every offset it computes comes out zero.
  const b = fitOverlay();
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
    const b = fitOverlay();
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
    const res = await fetch(`${SERVER}/api/listen-token`, {
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `Server said ${res.status}` };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: `Couldn't reach Cairn's server — ${describeNetworkError(err)}.` };
  }
});

/** Which screen the voice experience should draw on. */
ipcMain.handle("cairn:active-screen", () => {
  const display = activeDisplay();
  return { bounds: display.bounds, virtual: stageBounds() };
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
  // The flag is what tells a login-time start not to put the panel on screen.
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: ["--autostart"] });
  refreshTray();
}

/**
 * A connection test the person with the problem can run themselves.
 *
 * When Cairn is handed to someone else, "it can't reach the server" is a dead
 * end: they can't see logs, and the server is usually fine — it is their clock,
 * their proxy, or their network blocking the domain. This puts the actual
 * result in a box they can read out, along with whether plain internet works,
 * which separates "your network is down" from "your network dislikes this
 * particular host".
 */
async function checkConnection() {
  const started = Date.now();
  let serverLine;

  try {
    const res = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(15000) });
    const ms = Date.now() - started;
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      serverLine =
        `Reached the server in ${ms}ms.\n` +
        `Vision: ${body.vision ? "on" : "off"}    Voice: ${body.voice ? "on" : "off"}    ` +
        `Storage: ${body.store ?? "unknown"}`;
    } else {
      serverLine = `The server answered with ${res.status} after ${ms}ms.`;
    }
  } catch (err) {
    serverLine = `Could not reach the server — ${describeNetworkError(err)}.`;
  }

  // Whether anything at all gets out, to tell a broken network apart from a
  // blocked host.
  const online = net.isOnline() ? "Windows reports this machine is online." : "Windows reports no network connection.";

  dialog.showMessageBox({
    type: serverLine.startsWith("Reached") ? "info" : "warning",
    title: "Cairn — connection",
    message: serverLine.startsWith("Reached") ? "Everything is working." : "Cairn cannot reach its server.",
    detail: `${serverLine}\n\n${online}\n\nServer: ${SERVER}`,
    buttons: ["Close", "Open the server in a browser"],
    defaultId: 0,
  }).then(({ response }) => {
    if (response === 1) shell.openExternal(`${SERVER}/health`);
  });
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
      { label: "Check connection…", click: checkConnection },
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

    /*
     * Say something on launch, unless Windows started it.
     *
     * Double-clicking used to do nothing visible at all: the panel waits for a
     * hotkey and the only other sign of life is a tray icon, which Windows 11
     * files away in the overflow arrow by default. So the app was running,
     * correctly, and looked like it had failed to open — and if Ctrl+Space had
     * been taken by an IME, the one thing that would have explained it was the
     * hint inside the panel nobody had seen.
     *
     * Starting with Windows is the exception: something appearing over your
     * work every time you log in is not a greeting, it is an interruption.
     */
    if (!process.argv.includes("--autostart")) showHud();

    // Monitors coming, going or being rescaled mid-session. The overlay is
    // re-fitted to whichever screen is current; a display that has just had its
    // scale factor changed is the one most likely to be wrong.
    const refit = () => fitOverlay();
    screen.on("display-added", refit);
    screen.on("display-removed", refit);
    screen.on("display-metrics-changed", refit);
  });

  // No dock, no taskbar, no window on launch: Cairn lives in the tray and
  // appears only when summoned.
  app.on("window-all-closed", (e) => e.preventDefault());
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
