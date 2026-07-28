"use client";

import type { AskResult } from "@/lib/types";

/**
 * The spoken step, rendered over the shared screen.
 *
 * This is the primary answer surface — not a sidebar. Guidance belongs on the
 * thing it's describing, the way subtitles belong on the film: your eyes are
 * already on the screen looking for the control, so making them travel to a
 * side panel and back is the one thing the design should not do.
 *
 * It places itself opposite the pointer. Target in the top half, caption sits
 * at the bottom; target low, caption moves up. Without that the caption
 * eventually covers the very control it's telling you to click, which is a
 * failure the moment it happens rather than a rough edge.
 */

interface CaptionProps {
  result: AskResult;
  stepIndex: number;
  onStep(i: number): void;
  onSave(): void;
  onReplayTrail(): void;
  saveState: "none" | "saving" | "saved";
}

export function Caption({
  result,
  stepIndex,
  onStep,
  onSave,
  onReplayTrail,
  saveState,
}: CaptionProps) {
  const step = result.steps[stepIndex];
  const fromMemory = result.source === "trail";

  // Vertical midpoint of what we're pointing at, 0..1. With no target the
  // caption sits low, which is where the eye rests by default.
  const targetMid = step?.target ? step.target.y + step.target.h / 2 : 0.9;
  const placeAtBottom = targetMid < 0.55;

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center px-4 ${
        placeAtBottom ? "bottom-28" : "top-20"
      }`}
    >
      <div
        key={`${stepIndex}-${placeAtBottom}`}
        className={`glass pointer-events-auto w-full max-w-2xl rounded-2xl px-5 py-4 ${
          placeAtBottom ? "animate-caption-up" : "animate-caption-down"
        }`}
      >
        {/* Provenance. Colour carries it; the timing makes recall's speed legible. */}
        <div className="mb-3 flex items-center gap-2 text-[11px] font-medium">
          <span
            className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 ${
              fromMemory ? "bg-moss-dim/50 text-moss" : "bg-ember-dim/40 text-ember"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${fromMemory ? "bg-moss" : "bg-ember"}`} />
            {fromMemory ? `From ${result.trail?.author.name ?? "team"}'s trail` : "Read from your screen"}
          </span>
          <span className="font-mono text-faint">{result.elapsedMs}ms</span>

          <span className="ml-auto">
            {fromMemory ? (
              <button
                onClick={onReplayTrail}
                className="rounded-lg px-2 py-1 font-medium text-moss transition hover:bg-moss-dim/30"
              >
                Open trail →
              </button>
            ) : saveState === "saved" ? (
              <span className="text-moss">Saved for the team ✓</span>
            ) : (
              <button
                onClick={onSave}
                disabled={saveState === "saving"}
                className="rounded-lg bg-ember px-2.5 py-1 font-medium text-void transition hover:brightness-110 disabled:opacity-50"
              >
                {saveState === "saving" ? "Saving…" : "Save as trail"}
              </button>
            )}
          </span>
        </div>

        {/* The line itself. Sized to read at a glance from across the screen. */}
        <p className="flex gap-3 text-[17px] leading-relaxed text-ink">
          <span
            className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
              fromMemory ? "bg-moss text-void" : "bg-ember text-void"
            }`}
          >
            {stepIndex + 1}
          </span>
          <span>{step?.say}</span>
        </p>

        {result.steps.length > 1 ? (
          <div className="mt-4 flex items-center gap-3">
            {/* Progress pips double as jump targets. */}
            <div className="flex gap-1.5">
              {result.steps.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => onStep(i)}
                  aria-label={`Step ${i + 1}`}
                  className={`h-1.5 rounded-full transition-all ${
                    i === stepIndex
                      ? fromMemory
                        ? "w-7 bg-moss"
                        : "w-7 bg-ember"
                      : "w-1.5 bg-line hover:bg-faint"
                  }`}
                />
              ))}
            </div>

            <div className="ml-auto flex gap-1.5">
              <button
                onClick={() => onStep(stepIndex - 1)}
                disabled={stepIndex === 0}
                className="rounded-lg bg-raised/80 px-3 py-1.5 text-xs text-ink transition enabled:hover:bg-line disabled:opacity-30"
              >
                Back
              </button>
              <button
                onClick={() => onStep(stepIndex + 1)}
                disabled={stepIndex >= result.steps.length - 1}
                className="rounded-lg bg-raised/80 px-3 py-1.5 text-xs text-ink transition enabled:hover:bg-line disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
