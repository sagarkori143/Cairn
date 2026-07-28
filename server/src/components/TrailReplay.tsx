"use client";

import { useCallback, useEffect, useState } from "react";
import { PointerOverlay } from "./PointerOverlay";
import { speak, stopSpeaking } from "@/lib/speech";
import type { Trail } from "@/lib/types";

/**
 * Replays a saved trail: the original frames, the original annotations, spoken.
 *
 * This is what separates a trail from a wiki page. A written doc tells you the
 * Export button is in the right sidebar; a trail shows you the sidebar as the
 * person who found it saw it, with the button ringed. The narration is the same
 * voice the live half uses, so a recalled answer and a fresh one feel like one
 * product rather than two.
 *
 * Autoplay is off by default. Someone opening a trail is often skimming to
 * confirm it's the right one, and audio starting unbidden is hostile — so
 * playback is a deliberate press, and arrow keys work for people who just want
 * to page through.
 */

interface TrailReplayProps {
  trail: Trail;
  onClose(): void;
}

export function TrailReplay({ trail, onClose }: TrailReplayProps) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const step = trail.steps[index];

  const go = useCallback(
    (i: number, narrate: boolean) => {
      if (i < 0 || i >= trail.steps.length) return;
      setIndex(i);
      if (narrate) speak(trail.steps[i].say);
    },
    [trail.steps],
  );

  /** Walks the whole trail, advancing when each line finishes being spoken. */
  const play = useCallback(() => {
    setPlaying(true);
    let i = index;
    const next = () => {
      setIndex(i);
      speak(trail.steps[i].say, () => {
        i += 1;
        if (i < trail.steps.length) next();
        else setPlaying(false);
      });
    };
    next();
  }, [index, trail.steps]);

  const stop = useCallback(() => {
    stopSpeaking();
    setPlaying(false);
  }, []);

  // Stop narration on unmount, or the voice keeps talking over a closed dialog.
  useEffect(() => () => stopSpeaking(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(index + 1, false);
      if (e.key === "ArrowLeft") go(index - 1, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/85 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={trail.title}
    >
      <div
        className="animate-rise flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-medium text-ink">{trail.title}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <span
                className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold text-void"
                style={{ background: trail.author.color }}
              >
                {trail.author.initials}
              </span>
              {trail.author.name}
              <span className="text-faint">·</span>
              {trail.app}
              {trail.reuseCount > 0 ? (
                <>
                  <span className="text-faint">·</span>
                  <span className="text-moss">reused {trail.reuseCount}×</span>
                </>
              ) : null}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-muted transition hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            Esc
          </button>
        </div>

        {/* stage */}
        <div className="relative aspect-video shrink-0 bg-void">
          {step?.frame ? (
            <img src={step.frame} alt="" className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-faint">
              This step has no captured frame.
            </div>
          )}
          {step ? (
            <PointerOverlay
              target={step.target}
              label={step.label}
              tone="moss"
              stepKey={index}
            />
          ) : null}
        </div>

        {/* narration + controls */}
        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          <p className="text-sm text-ink">
            <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-moss text-[10px] font-semibold text-void">
              {index + 1}
            </span>
            {step?.say}
          </p>

          <div className="flex items-center gap-2">
            <button
              onClick={() => go(index - 1, true)}
              disabled={index === 0}
              className="rounded-lg bg-raised px-3 py-1.5 text-xs text-ink transition enabled:hover:bg-line disabled:opacity-30"
            >
              Back
            </button>
            <button
              onClick={() => go(index + 1, true)}
              disabled={index >= trail.steps.length - 1}
              className="rounded-lg bg-raised px-3 py-1.5 text-xs text-ink transition enabled:hover:bg-line disabled:opacity-30"
            >
              Next
            </button>
            <button
              onClick={playing ? stop : play}
              className="rounded-lg bg-moss px-3 py-1.5 text-xs font-medium text-void transition hover:brightness-110"
            >
              {playing ? "Stop" : "Play walkthrough"}
            </button>

            <div className="ml-auto flex gap-1.5">
              {trail.steps.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => go(i, false)}
                  aria-label={`Step ${i + 1}`}
                  className={`h-1.5 rounded-full transition-all ${
                    i === index ? "w-6 bg-moss" : "w-1.5 bg-line hover:bg-faint"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
