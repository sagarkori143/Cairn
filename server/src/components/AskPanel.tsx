"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Caption } from "./Caption";
import { PointerOverlay } from "./PointerOverlay";
import {
  CaptureUnsupportedError,
  grabFrame,
  isCaptureSupported,
  shrinkForStorage,
  startCapture,
  type Frame,
} from "@/lib/capture";
import {
  isVoiceInputSupported,
  speak,
  startDictation,
  stopSpeaking,
} from "@/lib/speech";
import type { AskResult, Step, Trail } from "@/lib/types";

/**
 * The live half of Cairn, as a full-bleed stage.
 *
 * The shared screen fills the window and every control floats over it. That
 * ordering is the point: the user's attention belongs on their own screen, and
 * chrome that permanently occupies a third of the viewport competes with the
 * thing the product exists to point at. Everything here is either transient
 * (the answer), summonable (the trails drawer), or small enough to ignore (the
 * ask bar).
 *
 * Two behaviours remain load-bearing:
 *
 *  - When an answer arrives the stage *freezes* to the exact frame sent to the
 *    model. The annotation describes that moment; live video underneath would
 *    drift the highlight off its target as soon as a window moved.
 *
 *  - Recalled trails render their original author's frames, not yours. Seeing
 *    the screen as the person who solved it saw it is what makes a trail feel
 *    like being shown rather than told.
 */

type Phase = "idle" | "listening" | "thinking" | "answered" | "error";

interface AskPanelProps {
  onTrailSaved(): void;
  onOpenTrail(trail: Trail): void;
}

export function AskPanel({ onTrailSaved, onOpenTrail }: AskPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [sharing, setSharing] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [question, setQuestion] = useState("");
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [frozen, setFrozen] = useState<Frame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"none" | "saving" | "saved">("none");

  const stopDictationRef = useRef<(() => void) | null>(null);
  const voiceIn = isVoiceInputSupported();

  /**
   * Guards against a second paid call while one is in flight. A ref rather
   * than state on purpose: two events in the same tick (releasing Space while
   * also clicking Ask) would both read a stale `phase` and both fire.
   */
  const inFlightRef = useRef(false);

  /* ---------------------------------------------------------------- capture */

  const stopSharing = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setSharing(false);
  }, []);

  const beginSharing = useCallback(async () => {
    setError(null);
    try {
      const stream = await startCapture();
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      // The browser's own "Stop sharing" bar bypasses our UI entirely, so we
      // have to listen for it or the panel would claim to still be sharing.
      stream.getVideoTracks()[0]?.addEventListener("ended", stopSharing);
      setSharing(true);
    } catch (err) {
      if (err instanceof CaptureUnsupportedError) setError(err.message);
      else setError("Screen sharing was dismissed. Nothing was captured.");
    }
  }, [stopSharing]);

  useEffect(() => () => stopSharing(), [stopSharing]);

  /* ------------------------------------------------------------------- ask */

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || inFlightRef.current) return;
      inFlightRef.current = true;

      stopSpeaking();
      setQuestion(q);
      setPhase("thinking");
      setError(null);
      setResult(null);
      setStepIndex(0);
      setSaveState("none");

      // Capture before the network call so the frame matches the question's
      // moment, not whatever is on screen when the response lands.
      let frame: Frame | null = null;
      if (sharing && videoRef.current) {
        try {
          frame = grabFrame(videoRef.current);
          setFrozen(frame);
        } catch {
          /* fall through — recall may still answer without a frame */
        }
      }

      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: q,
            frame: frame?.base64,
            mediaType: frame?.mediaType,
          }),
        });
        const data = (await res.json()) as AskResult & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Cairn couldn't answer that.");

        // Live answers carry no frames back (the client already has one), so
        // attach the capture here for display and for saving.
        const steps: Step[] =
          data.source === "model"
            ? data.steps.map((s) => ({ ...s, frame: frame?.dataUrl ?? null }))
            : data.steps;

        setResult({ ...data, steps });
        setPhase("answered");
        speak(`${data.summary} ${steps[0]?.say ?? ""}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setPhase("error");
      } finally {
        inFlightRef.current = false;
      }
    },
    [sharing],
  );

  /* ------------------------------------------------------------------ voice */

  const beginListening = useCallback(() => {
    if (!voiceIn || phase === "listening") return;
    stopSpeaking();
    setPhase("listening");
    setQuestion("");
    stopDictationRef.current = startDictation({
      onPartial: setQuestion,
      onFinal: (text) => {
        setPhase("idle");
        void ask(text);
      },
      onError: (message) => {
        setError(message);
        setPhase("idle");
      },
    });
  }, [ask, phase, voiceIn]);

  const endListening = useCallback(() => {
    stopDictationRef.current?.();
    stopDictationRef.current = null;
  }, []);

  // Hold-to-talk. Space is the whole interaction, so it must not fire while
  // the user is typing into the fallback input or any other field.
  useEffect(() => {
    if (!voiceIn) return;
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping(e.target)) return;
      e.preventDefault();
      beginListening();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault();
      endListening();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [beginListening, endListening, voiceIn]);

  /* ------------------------------------------------------------------ steps */

  const steps = result?.steps ?? [];
  const step = steps[stepIndex] ?? null;

  const goToStep = useCallback(
    (i: number) => {
      if (i < 0 || i >= steps.length) return;
      setStepIndex(i);
      speak(steps[i].say);
    },
    [steps],
  );

  /* ------------------------------------------------------------------- save */

  const saveTrail = useCallback(async () => {
    if (!result || result.source !== "model") return;
    setSaveState("saving");
    try {
      // Shrink frames before they go into storage — see capture.ts.
      const stored = await Promise.all(
        result.steps.map(async (s) => ({
          ...s,
          frame: s.frame ? await shrinkForStorage(s.frame) : null,
        })),
      );
      const res = await fetch("/api/trails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: result.title,
          question,
          app: result.app,
          steps: stored,
        }),
      });
      const data = (await res.json()) as { trail?: Trail; error?: string };
      if (!res.ok || !data.trail) throw new Error(data.error ?? "Couldn't save.");
      setSaveState("saved");
      onTrailSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that trail.");
      setSaveState("none");
    }
  }, [onTrailSaved, question, result]);

  /* -------------------------------------------------------------- rendering */

  const tone = result?.source === "trail" ? "moss" : "ember";
  // Recalled trails show the author's frame; live answers show your capture.
  const displayFrame = step?.frame ?? frozen?.dataUrl ?? null;
  const showFrozen = phase === "answered" && displayFrame;
  const listening = phase === "listening";

  return (
    <div className="absolute inset-0">
      {/* ------------------------------------------------------------ stage */}
      <video
        ref={videoRef}
        muted
        playsInline
        className={`absolute inset-0 h-full w-full object-contain ${showFrozen ? "invisible" : ""}`}
      />
      {showFrozen ? (
        <img src={displayFrame} alt="" className="absolute inset-0 h-full w-full object-contain" />
      ) : null}

      {phase === "answered" && step ? (
        <PointerOverlay
          target={step.target}
          label={step.label}
          tone={tone}
          stepKey={`${stepIndex}-${result?.title ?? ""}`}
        />
      ) : null}

      {phase === "answered" && result ? (
        <Caption
          result={result}
          stepIndex={stepIndex}
          onStep={goToStep}
          onSave={saveTrail}
          onReplayTrail={() => result.trail && onOpenTrail(result.trail)}
          saveState={saveState}
        />
      ) : null}

      {/* Empty state. Only while nothing has been answered yet. */}
      {!sharing && phase !== "answered" ? <ShareInvite onShare={beginSharing} /> : null}

      {/* Stop-sharing affordance, deliberately quiet. */}
      {sharing ? (
        <button
          onClick={stopSharing}
          className="glass absolute right-5 top-20 z-20 rounded-full px-3 py-1.5 text-[11px] text-muted transition hover:text-ink"
        >
          Stop sharing
        </button>
      ) : null}

      {/* ------------------------------------------------------- transient */}
      {phase === "thinking" ? (
        <div className="glass absolute bottom-32 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2.5 rounded-full px-4 py-2.5 text-sm text-muted">
          <span className="h-1.5 w-1.5 animate-ping rounded-full bg-ember" />
          Reading your screen…
        </div>
      ) : null}

      {error ? (
        <div className="animate-rise absolute bottom-32 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-ember-dim bg-ember-dim/30 px-4 py-2.5 text-sm text-ember backdrop-blur-xl">
          {error}
          <button onClick={() => setError(null)} className="text-ember/60 transition hover:text-ember">
            ✕
          </button>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- ask bar */}
      <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-6">
        <div className="glass flex w-full max-w-2xl items-center gap-2 rounded-2xl p-2">
          {voiceIn ? (
            <button
              onMouseDown={beginListening}
              onMouseUp={endListening}
              onMouseLeave={endListening}
              onTouchStart={beginListening}
              onTouchEnd={endListening}
              title="Hold to speak, or hold Space"
              className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                listening
                  ? "animate-breathe bg-ember text-void"
                  : "bg-raised text-ink hover:bg-line"
              }`}
            >
              <MicIcon />
              {listening ? "Listening…" : "Hold to ask"}
            </button>
          ) : null}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = typed;
              setTyped("");
              void ask(t);
            }}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <input
              value={listening && question ? question : typed}
              onChange={(e) => setTyped(e.target.value)}
              readOnly={listening}
              placeholder={
                listening
                  ? "Listening…"
                  : sharing
                    ? "Ask about your screen…"
                    : "Ask, or share a screen first"
              }
              className="min-w-0 flex-1 bg-transparent px-2 text-sm text-ink outline-none placeholder:text-faint"
            />
            <button
              type="submit"
              disabled={!typed.trim() || phase === "thinking"}
              className="shrink-0 rounded-xl bg-raised px-3.5 py-2.5 text-sm text-ink transition enabled:hover:bg-line disabled:opacity-30"
            >
              Ask
            </button>
          </form>
        </div>
      </div>

      {/* Keyboard hint, only while idle so it doesn't nag. */}
      {voiceIn && phase === "idle" && !result ? (
        <p className="absolute inset-x-0 bottom-1 z-30 text-center text-[11px] text-faint">
          hold <kbd className="rounded border border-line px-1">Space</kbd> to speak
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * First thing anyone sees. Sells the loop in one line and asks for exactly one
 * action — the permission prompt is friction enough without a wall of text in
 * front of it.
 */
function ShareInvite({ onShare }: { onShare(): void }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="flex flex-col items-center gap-1.5" aria-hidden>
        <span className="h-1.5 w-8 rounded-full bg-faint/70" />
        <span className="h-1.5 w-12 rounded-full bg-faint/50" />
        <span className="h-1.5 w-16 rounded-full bg-faint/30" />
      </div>
      <div className="max-w-md">
        <h2 className="text-xl font-medium tracking-tight text-ink">
          Cairn needs to see what you see.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Share a window, then ask out loud. Nothing is captured until the moment you ask, and
          nothing is stored unless you save it as a trail.
        </p>
      </div>
      <button
        onClick={onShare}
        className="rounded-full bg-ember px-5 py-2.5 text-sm font-medium text-void transition hover:brightness-110"
      >
        Share a screen
      </button>
      {!isCaptureSupported() ? (
        <p className="text-xs text-faint">
          This browser can&apos;t share a screen — try Chrome, Edge, or desktop Safari.
        </p>
      ) : null}
    </div>
  );
}
