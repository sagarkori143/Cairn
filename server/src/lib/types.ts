/**
 * Core domain types for Cairn.
 *
 * The product has two halves that share one vocabulary:
 *  - the *live* half (ask a question about what's on screen, get pointed at the answer)
 *  - the *memory* half (that answer becomes a Trail the rest of the team inherits)
 *
 * A Trail is just an ordered list of Steps, and a Step is exactly what one
 * live answer produces. That symmetry is deliberate: saving a trail is a
 * copy, not a transformation.
 */

/** A rectangle in normalized [0,1] coordinates, relative to the captured frame. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One beat of guidance: what to say, and where to point while saying it.
 *
 * `target` is null when the answer is purely verbal ("you're already on the
 * right screen") — the UI then skips the pointer animation rather than
 * jabbing at an arbitrary spot.
 */
export interface Step {
  id: string;
  /** Spoken/displayed instruction. One action, imperative voice. */
  say: string;
  /** Where on the frame this step refers to, if anywhere. */
  target: Region | null;
  /** Short label rendered next to the pointer, e.g. "Share button". */
  label: string | null;
  /** Data-URL PNG of the frame this step was captured against. */
  frame: string | null;
}

/** Who produced a trail. Mocked identity — see README "Simplified scope". */
export interface Author {
  id: string;
  name: string;
  /** Two-letter monogram used by the avatar chip. */
  initials: string;
  /** Tailwind-safe hex used as the avatar background. */
  color: string;
}

/**
 * A saved walkthrough. This is the unit of team memory: one person hits a
 * wall, Cairn walks them through it, and the result is stored so nobody on
 * the team pays that cost again.
 */
export interface Trail {
  id: string;
  title: string;
  /** The original question, kept verbatim — it's the best search key we have. */
  question: string;
  /** Extra phrasings that should also match this trail, for recall. */
  aliases: string[];
  /** Which app/surface this is about, e.g. "Figma". Used for grouping. */
  app: string;
  steps: Step[];
  author: Author;
  createdAt: number;
  /** Incremented every time recall serves this trail instead of the model. */
  reuseCount: number;
}

/** What the /api/ask endpoint returns. */
export interface AskResult {
  /**
   * Where the answer came from.
   *  - "trail"  → recalled from team memory, no model call, ~instant
   *  - "model"  → fresh vision call
   */
  source: "trail" | "model";
  /** Present when source === "trail". */
  trail?: Trail;
  /**
   * Steps come back with `frame: null` — the client already holds the capture
   * it just sent, so echoing a megabyte of base64 back would double the
   * round-trip for no gain. The client attaches its own frame for display.
   */
  steps: Step[];
  /** One-line summary spoken before the steps. */
  summary: string;
  /** Suggested title if the user saves this as a trail. */
  title: string;
  /** Application the model recognised on screen. */
  app: string;
  /** Milliseconds spent server-side, surfaced in the UI to make recall's speed legible. */
  elapsedMs: number;
}

/** Shape the model is constrained to return. Mirrors Step, minus server-assigned fields. */
export interface ModelAnswer {
  summary: string;
  app: string;
  title: string;
  steps: Array<{
    say: string;
    label: string | null;
    target: Region | null;
  }>;
}
