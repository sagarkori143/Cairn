/**
 * Voice in and voice out, using only what ships in the browser.
 *
 * Clicky uses ElevenLabs for its voice. Cairn deliberately does not: the
 * built-in SpeechSynthesis API costs nothing, adds no key to manage, and
 * starts speaking with no network round-trip at all. For guidance — short
 * imperative sentences — the quality difference does not change whether the
 * instruction lands, and the latency difference is very noticeable. Swapping
 * in a hosted voice later means replacing one function.
 *
 * Recognition support is genuinely uneven (Chrome and Edge yes, Firefox no),
 * so every voice affordance in the UI has a typed equivalent. Voice is the
 * fast path, never the only path.
 */

/* The Web Speech API is not in TypeScript's DOM lib; these are the parts used here. */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [i: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceInputSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export interface DictationHandlers {
  /** Fires continuously while speaking, so the UI can show words appearing. */
  onPartial(text: string): void;
  /** Fires once when the utterance settles. */
  onFinal(text: string): void;
  onError(message: string): void;
}

/**
 * Starts dictation and returns a stop function.
 *
 * Interim results are on because watching your words appear is the main signal
 * that the microphone is actually working — without it, a slow transcription
 * is indistinguishable from a broken one.
 */
export function startDictation(handlers: DictationHandlers): () => void {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    handlers.onError("This browser can't listen. Type your question instead.");
    return () => {};
  }

  const recognition = new Ctor();
  recognition.lang = navigator.language || "en-US";
  recognition.continuous = false;
  recognition.interimResults = true;

  let settled = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) settled += result[0].transcript;
      else interim += result[0].transcript;
    }
    if (interim) handlers.onPartial(settled + interim);
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech") handlers.onError("Didn't catch that.");
    else if (event.error === "not-allowed")
      handlers.onError("Microphone blocked. Allow it, or type instead.");
    else handlers.onError("Couldn't hear you. Type your question instead.");
  };

  recognition.onend = () => {
    const text = settled.trim();
    if (text) handlers.onFinal(text);
  };

  try {
    recognition.start();
  } catch {
    handlers.onError("Couldn't start listening.");
  }

  return () => {
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  };
}

let currentUtterance: SpeechSynthesisUtterance | null = null;

/** Picks a natural-sounding local voice, preferring the user's own locale. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const lang = navigator.language || "en-US";
  return (
    voices.find((v) => v.lang === lang && !v.localService === false && /natural|premium|enhanced/i.test(v.name)) ??
    voices.find((v) => v.lang === lang) ??
    voices.find((v) => v.lang.startsWith(lang.slice(0, 2))) ??
    voices[0]
  );
}

export function isVoiceOutputSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Speaks a line, cancelling anything already in flight.
 *
 * Cancelling rather than queueing is deliberate: if the user has moved on to a
 * new question, finishing the previous answer out loud is just noise.
 */
export function speak(text: string, onEnd?: () => void): void {
  if (!isVoiceOutputSupported()) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 1.03;
  utterance.pitch = 1;
  utterance.onend = () => {
    currentUtterance = null;
    onEnd?.();
  };
  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (!isVoiceOutputSupported()) return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
}

export function isSpeaking(): boolean {
  return currentUtterance !== null;
}
