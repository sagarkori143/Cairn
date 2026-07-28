"use client";

import { useEffect, useRef, useState } from "react";
import type { Region } from "@/lib/types";

/**
 * Draws the "look here" annotation over a frame.
 *
 * This is the moment the product either works or doesn't. A written
 * instruction like "click Export in the right sidebar" still leaves the person
 * scanning; a ring around the actual pixels ends the search. So the overlay
 * does three things at once, and each earns its place:
 *
 *   1. Dims everything outside the target, to kill the scanning entirely.
 *   2. Rings the target, so the boundary of "the thing" is unambiguous.
 *   3. Flies a cursor in and settles it, so the eye is *led* there rather than
 *      having to notice a box that blinked into existence.
 *
 * Implemented with an SVG mask rather than four dimming rectangles: the mask
 * gives a genuine rounded cut-out, and one element animates cleanly when the
 * target moves between steps instead of four fighting each other.
 */

export interface PointerOverlayProps {
  /** Normalized target, or null for a step with no on-screen referent. */
  target: Region | null;
  label: string | null;
  /** Green when recalled from team memory, amber when read live. */
  tone: "ember" | "moss";
  /** Changes when the step changes, to retrigger the entry animation. */
  stepKey: string | number;
}

export function PointerOverlay({ target, label, tone, stepKey }: PointerOverlayProps) {
  const colour = tone === "moss" ? "#35d6a0" : "#ff8f4c";
  const maskId = useRef(`cairn-mask-${Math.random().toString(36).slice(2)}`).current;

  // The cursor starts off-target and animates in. Holding it in state (rather
  // than a CSS transition from nothing) means the very first step animates too,
  // not just transitions between steps.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, [stepKey]);

  if (!target) return null;

  const cx = (target.x + target.w / 2) * 100;
  const cy = (target.y + target.h / 2) * 100;

  // Keep the label inside the frame: flip it below the target when the target
  // sits near the top edge, and rein in its horizontal anchor near the sides.
  const labelBelow = target.y < 0.14;
  const labelLeftPct = Math.min(Math.max(cx, 12), 88);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Spotlight: dim everything except a rounded cut-out over the target. */}
      <svg
        className="absolute inset-0 h-full w-full transition-all duration-500 ease-out"
        preserveAspectRatio="none"
      >
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={`${target.x * 100}%`}
              y={`${target.y * 100}%`}
              width={`${target.w * 100}%`}
              height={`${target.h * 100}%`}
              rx="6"
              fill="black"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(6,7,11,0.62)"
          mask={`url(#${maskId})`}
        />
      </svg>

      {/* Target ring, plus a slow halo so it stays findable after the cursor settles. */}
      <div
        key={`ring-${stepKey}`}
        className="animate-settle absolute rounded-md transition-all duration-500 ease-out"
        style={{
          left: `${target.x * 100}%`,
          top: `${target.y * 100}%`,
          width: `${target.w * 100}%`,
          height: `${target.h * 100}%`,
          border: `2px solid ${colour}`,
          boxShadow: `0 0 0 1px rgba(0,0,0,0.5), 0 0 24px ${colour}55`,
        }}
      >
        <div
          className="animate-pulse-ring absolute -inset-1 rounded-lg"
          style={{ border: `1.5px solid ${colour}` }}
        />
      </div>

      {/* The cursor: drifts in from lower-right and lands on the target's centre. */}
      <div
        className="absolute transition-all duration-[650ms]"
        style={{
          left: `${cx}%`,
          top: `${cy}%`,
          transform: settled
            ? "translate(-4px, -2px) scale(1)"
            : "translate(38px, 46px) scale(1.5)",
          opacity: settled ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M5 3l14 8.2-6.1 1.6-2.6 6.1L5 3z"
            fill={colour}
            stroke="#08090d"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* Label chip, anchored to the target and clamped inside the frame. */}
      {label ? (
        <div
          key={`label-${stepKey}`}
          className="animate-rise absolute -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium tracking-wide"
          style={{
            left: `${labelLeftPct}%`,
            top: labelBelow
              ? `calc(${(target.y + target.h) * 100}% + 12px)`
              : `calc(${target.y * 100}% - 30px)`,
            background: colour,
            color: "#08090d",
            boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
}
