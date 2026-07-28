/**
 * Screen capture for the browser.
 *
 * This is the web's answer to what Clicky does natively with ScreenCaptureKit.
 * The tradeoff is honest and worth stating: a web page cannot draw on your real
 * desktop, so Cairn annotates a live mirror of the shared surface inside the
 * page. In exchange it runs anywhere with a URL, on any OS, with no install —
 * and the annotated frames are exactly what a teammate replays later.
 */

export interface Frame {
  /** Bare base64, ready for the vision API. */
  base64: string;
  mediaType: "image/jpeg";
  /** Same image as a data URL, for rendering and for saving into a trail. */
  dataUrl: string;
  width: number;
  height: number;
}

export class CaptureUnsupportedError extends Error {
  constructor() {
    super("This browser can't share a screen. Try Chrome, Edge, or Safari on desktop.");
    this.name = "CaptureUnsupportedError";
  }
}

export function isCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/**
 * Prompts for a screen/window/tab to share.
 *
 * Audio is explicitly declined — Cairn only ever needs pixels, and asking for
 * system audio makes the browser's permission sheet look far more invasive
 * than what the product actually does.
 */
export async function startCapture(): Promise<MediaStream> {
  if (!isCaptureSupported()) throw new CaptureUnsupportedError();
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 5, max: 10 } },
    audio: false,
  });
}

/**
 * Grabs a single still from a live <video> element.
 *
 * Downscaled to `maxWidth` before encoding: a raw 4K frame is several megabytes
 * and buys no accuracy, since UI text stays legible well below native
 * resolution. JPEG at 0.85 keeps small type crisp while staying roughly an
 * order of magnitude smaller than PNG.
 *
 * Coordinates are normalized everywhere downstream, so scaling here never
 * shifts an annotation.
 */
export function grabFrame(video: HTMLVideoElement, maxWidth = 1600): Frame {
  const sw = video.videoWidth;
  const sh = video.videoHeight;
  if (!sw || !sh) throw new Error("The shared screen isn't ready yet. Give it a moment.");

  const scale = Math.min(1, maxWidth / sw);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't read the shared screen.");
  ctx.drawImage(video, 0, 0, w, h);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return {
    base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    mediaType: "image/jpeg",
    dataUrl,
    width: w,
    height: h,
  };
}

/**
 * Re-encodes a frame small enough to live in a saved trail.
 *
 * Trails are stored whole, and a trail with four full-size frames would be
 * multiple megabytes — too big for the ephemeral store and wasteful in the
 * shared one. Replay is a guided read, not a pixel-peep, so 900px is plenty.
 */
export async function shrinkForStorage(dataUrl: string, maxWidth = 900): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const scale = Math.min(1, maxWidth / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}
