import Anthropic from "@anthropic-ai/sdk";
import type { ModelAnswer } from "./types";

/**
 * The single model call behind live guidance.
 *
 * Design notes worth knowing before editing:
 *
 *  - Effort is pinned to "low". This is a latency-critical, single-screenshot
 *    reading task, not a reasoning task — the user is waiting with their screen
 *    shared. Thinking is deliberately left ON (the default) rather than
 *    disabled: on this model disabling it can leak reasoning into the visible
 *    answer, and low effort already buys back the latency.
 *
 *  - Output is constrained by JSON schema rather than parsed out of prose, so
 *    the pointer coordinates are structurally guaranteed and the UI never has
 *    to defend against a malformed answer.
 *
 *  - Coordinates are normalized 0..1 rather than pixels, so the client can
 *    downscale frames for bandwidth without the annotation drifting.
 */

const MODEL = "claude-opus-5";

/**
 * Reasoning depth, tunable without a redeploy.
 *
 * Exposed as config because the right setting here is an empirical question
 * about latency-versus-accuracy on real screenshots, not something to settle by
 * argument. Defaults are what measured best: effort `low`, thinking on.
 *
 * Turning thinking off is a real option for this workload — reading one
 * screenshot is perception, not multi-step reasoning — and it is measurably
 * faster. It is not the default because on this model a disabled-thinking route
 * can leak reasoning into the visible answer. Structured output makes that
 * unlikely here (the response has to satisfy the schema), but "unlikely" is a
 * poor default for the one thing the user actually reads.
 */
function reasoningConfig(): { effort: "low" | "medium" | "high"; thinkingDisabled: boolean } {
  const effort = process.env.CAIRN_EFFORT;
  return {
    effort: effort === "medium" || effort === "high" ? effort : "low",
    thinkingDisabled: process.env.CAIRN_THINKING === "disabled",
  };
}

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "One sentence, spoken aloud before the steps. Say what the user is about to do, not what you are doing.",
    },
    app: {
      type: "string",
      description:
        "Best guess at the application or website visible on screen, e.g. 'Figma', 'Gmail', 'VS Code'. Use 'Unknown' if unclear.",
    },
    title: {
      type: "string",
      description:
        "A short imperative title for this walkthrough if it were saved for a teammate, e.g. 'Export a frame at 3x'. Max 60 characters.",
    },
    steps: {
      type: "array",
      description: "One to four steps. Each is a single concrete action.",
      items: {
        type: "object",
        properties: {
          say: {
            type: "string",
            description:
              "The instruction, spoken aloud. One action. Imperative voice. No preamble, no numbering.",
          },
          label: {
            type: ["string", "null"],
            description:
              "Two or three words naming the thing being pointed at, e.g. 'Export button'. Null if not pointing at anything.",
          },
          target: {
            type: ["object", "null"],
            description:
              "Normalized bounding box of the element to point at, or null if this step has no on-screen target.",
            properties: {
              x: { type: "number", description: "Left edge, 0..1" },
              y: { type: "number", description: "Top edge, 0..1" },
              w: { type: "number", description: "Width, 0..1" },
              h: { type: "number", description: "Height, 0..1" },
            },
            required: ["x", "y", "w", "h"],
            additionalProperties: false,
          },
        },
        required: ["say", "label", "target"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "app", "title", "steps"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are Cairn, a guide that looks at someone's screen and shows them the next thing to do.

You are given one screenshot and one question. Answer only about what is actually visible.

How to answer:
- Give one to four steps. Each step is one action the person performs.
- Point at things. For each step, set "target" to the bounding box of the exact control to interact with, in normalized coordinates where (0,0) is the top-left of the image and (1,1) is the bottom-right. Keep the box tight around the control.
- Set "target" to null only when the step genuinely has no on-screen referent (for example, "wait for the build to finish").
- If what they need is not on this screen, say so plainly in the first step and point at the control that navigates there.
- If the screenshot does not show enough to answer, say what you can see and what you need them to open. Never invent a control that is not visible.

How to write:
- Speak the steps aloud to a colleague. Short sentences, plain words, second person.
- Be brief. Skip preamble, restating the question, and closing offers of further help.
- Do not number the steps; the interface does that.
- Do not describe the screenshot back to them. They are looking at it.`;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    // Constructed lazily so a missing key surfaces as a handled API error at
    // request time rather than crashing the server at import time.
    client = new Anthropic();
  }
  return client;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
    this.name = "MissingApiKeyError";
  }
}

/**
 * Upstream failures the user might actually hit, translated into things worth
 * reading.
 *
 * The raw SDK error is a JSON blob with a request id in it — fine in a log,
 * useless in a UI, and it leaks provider internals to anyone poking at the
 * public endpoint. Each of these maps to a specific recovery, and every one is
 * a state a reviewer could plausibly land in: an exhausted balance, a revoked
 * key, a busy upstream. `cause` keeps the original for the server log.
 */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message);
    this.name = "UpstreamError";
    this.cause = cause;
  }
}

/**
 * Anthropic reports an exhausted balance as a 400 rather than a 402, so the
 * status alone isn't enough to tell it apart from a genuinely malformed
 * request — the message has to be inspected.
 */
function isCreditExhausted(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  return /credit balance is too low/i.test(err.message);
}

function toUpstreamError(err: unknown): UpstreamError {
  if (isCreditExhausted(err)) {
    return new UpstreamError(
      "Cairn's API credit has run out, so live answers are paused. Saved trails still work — try the Trails tab.",
      503,
      false,
      err,
    );
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new UpstreamError(
      "Cairn's API key was rejected, so live answers are off. Browsing and replaying trails still works.",
      503,
      false,
      err,
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new UpstreamError(
      "Too many questions reaching the model right now. Give it a few seconds.",
      429,
      true,
      err,
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new UpstreamError("Couldn't reach the model. Check your connection and try again.", 504, true, err);
  }
  // APIConnectionError is checked above this: in the TypeScript SDK it extends
  // APIError, so testing the base class first would swallow it.
  if (err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 500) {
    return new UpstreamError("The model is busy. Try that again in a moment.", 503, true, err);
  }
  return new UpstreamError("Cairn couldn't read your screen just then. Try asking again.", 502, true, err);
}

/**
 * Reads a screen capture and returns pointed, spoken guidance.
 *
 * @param frameBase64 Raw base64 (no data-URL prefix) of a PNG/JPEG capture.
 * @param mediaType   MIME type matching the capture.
 * @param question    What the user asked, transcribed or typed.
 */
export async function readScreen(
  frameBase64: string,
  mediaType: "image/png" | "image/jpeg",
  question: string,
): Promise<ModelAnswer> {
  if (!process.env.ANTHROPIC_API_KEY) throw new MissingApiKeyError();

  const { effort, thinkingDisabled } = reasoningConfig();

  let response;
  try {
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      ...(thinkingDisabled ? { thinking: { type: "disabled" as const } } : {}),
      output_config: {
        effort,
        format: { type: "json_schema", schema: ANSWER_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: frameBase64 },
            },
            { type: "text", text: question },
          ],
        },
      ],
    });
  } catch (err) {
    // Log the real thing (request id and all) before replacing it with
    // something a person can act on.
    console.error("[cairn] vision call failed:", err);
    throw toUpstreamError(err);
  }

  // Safety classifiers can decline with a normal 200 — check before reading
  // content, or this throws on an empty array.
  if (response.stop_reason === "refusal") {
    throw new Error(
      "Cairn could not answer that one. Try rephrasing, or ask about a different part of the screen.",
    );
  }

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("Model returned no answer.");
  }

  return JSON.parse(text.text) as ModelAnswer;
}
