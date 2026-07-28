import { NextResponse } from "next/server";
import { MissingApiKeyError, UpstreamError, readScreen } from "@/lib/claude";
import { recall } from "@/lib/recall";
import { clientIp, consumeModelCall } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import type { AskResult, Step } from "@/lib/types";

// The Anthropic SDK needs Node primitives, so this cannot run on the edge.
export const runtime = "nodejs";
// Every request is unique; caching here would be actively wrong.
export const dynamic = "force-dynamic";
// A vision call at low effort lands well inside this; the ceiling exists so a
// hung upstream request can't pin a function instance open and bill for it.
export const maxDuration = 60;

/**
 * Frames arrive as base64 in a JSON body. The client already downscales to
 * 1600px (~250KB), so anything past this is either a client bug or someone
 * probing the endpoint — reject before parsing rather than after.
 */
const MAX_BODY_BYTES = 6 * 1024 * 1024;

interface AskBody {
  /** Bare base64, no data-URL prefix. */
  frame?: string;
  mediaType?: "image/png" | "image/jpeg";
  question?: string;
}

/**
 * The one endpoint the live experience talks to.
 *
 * Order matters: team memory is consulted *before* the model, never after.
 * That ordering is the product — the second person to hit a wall should not
 * pay the latency or the cost that the first one already paid.
 */
export async function POST(req: Request) {
  const started = Date.now();

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "That screenshot is too large to send." },
      { status: 413 },
    );
  }

  let body: AskBody;
  try {
    body = (await req.json()) as AskBody;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const question = body.question?.trim();
  if (!question) {
    return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
  }
  if (question.length > 1000) {
    return NextResponse.json({ error: "That question is too long." }, { status: 400 });
  }

  const store = getStore();

  // --- 1. Has someone already solved this? -------------------------------
  const hit = recall(question, await store.list());
  if (hit) {
    await store.recordReuse(hit.trail.id);
    const result: AskResult = {
      source: "trail",
      trail: hit.trail,
      steps: hit.trail.steps,
      summary: `${hit.trail.author.name} worked this out ${relativeTime(hit.trail.createdAt)}. Here's the path.`,
      title: hit.trail.title,
      app: hit.trail.app,
      elapsedMs: Date.now() - started,
    };
    return NextResponse.json(result);
  }

  // --- 2. Nobody has. Look at the screen. --------------------------------
  if (!body.frame) {
    return NextResponse.json(
      { error: "Share your screen so Cairn can see what you're looking at." },
      { status: 400 },
    );
  }

  // Spend guard sits here and nowhere else: past this line the request costs
  // money, and everything before it was free. Validation runs first so a
  // malformed request never burns quota.
  const gate = await consumeModelCall(clientIp(req));
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.message, code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter ?? 60) } },
    );
  }

  try {
    const answer = await readScreen(
      body.frame,
      body.mediaType ?? "image/jpeg",
      question,
    );

    const steps: Step[] = answer.steps.map((s, i) => ({
      id: `s${i + 1}`,
      say: s.say,
      label: s.label,
      target: s.target ? clampRegion(s.target) : null,
      frame: null,
    }));

    const result: AskResult = {
      source: "model",
      steps,
      summary: answer.summary,
      title: answer.title,
      app: answer.app,
      elapsedMs: Date.now() - started,
    };
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return NextResponse.json(
        {
          error:
            "Cairn has no API key configured, so live answers are off. Browsing and replaying saved trails still works.",
          code: "no_api_key",
        },
        { status: 503 },
      );
    }
    if (err instanceof UpstreamError) {
      return NextResponse.json(
        { error: err.message, code: "upstream", retryable: err.retryable },
        { status: err.status },
      );
    }
    // Anything unmapped: log it, but don't hand the internals to the caller.
    console.error("[cairn] unexpected failure in /api/ask:", err);
    return NextResponse.json(
      { error: "Cairn couldn't read your screen just then. Try asking again." },
      { status: 502 },
    );
  }
}

/**
 * Keeps a returned box inside the frame. The model is reliable here, but a
 * box that runs off-canvas would render as a pointer stuck to an edge, which
 * looks broken in a way that's hard to attribute — cheaper to clamp.
 */
function clampRegion(r: { x: number; y: number; w: number; h: number }) {
  const x = Math.min(Math.max(r.x, 0), 1);
  const y = Math.min(Math.max(r.y, 0), 1);
  return {
    x,
    y,
    w: Math.min(Math.max(r.w, 0.01), 1 - x),
    h: Math.min(Math.max(r.h, 0.01), 1 - y),
  };
}

function relativeTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
