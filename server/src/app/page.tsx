"use client";

import { useCallback, useEffect, useState } from "react";
import { AskPanel } from "@/components/AskPanel";
import { TrailDrawer } from "@/components/TrailDrawer";
import { useTrails } from "@/components/TrailLibrary";
import { TrailReplay } from "@/components/TrailReplay";
import type { Trail } from "@/lib/types";

/**
 * App shell.
 *
 * One surface, not a set of tabs. The shared screen is the app; the library is
 * a drawer over it and the answer is a caption on it. Tabs would mean
 * unmounting the capture to go and read something, which costs the browser's
 * share permission and any answer currently on screen.
 */

const SEEN_KEY = "cairn.welcomed.v1";

export default function Home() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [replaying, setReplaying] = useState<Trail | null>(null);
  const [welcomed, setWelcomed] = useState(true); // assume seen; corrected on mount
  const { trails, loading, storeKind, refresh } = useTrails();

  // Read on mount rather than during render: localStorage doesn't exist during
  // SSR, and touching it in render would desync hydration.
  useEffect(() => {
    setWelcomed(window.localStorage.getItem(SEEN_KEY) === "1");
  }, []);

  const dismissWelcome = useCallback(() => {
    window.localStorage.setItem(SEEN_KEY, "1");
    setWelcomed(true);
  }, []);

  const openTrail = useCallback((trail: Trail) => {
    setReplaying(trail);
    setDrawerOpen(false);
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-void">
      <AskPanel onTrailSaved={() => void refresh()} onOpenTrail={openTrail} />

      {/* Floats over the stage rather than reserving a row of its own. The
          wrapper ignores pointer events so it never eats clicks meant for the
          screen underneath; each control opts back in. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-4 px-5 py-4">
        <div className="pointer-events-auto flex items-center gap-2.5">
          <CairnMark />
          <div>
            <h1 className="text-[14px] font-semibold leading-none tracking-tight text-ink">
              Cairn
            </h1>
            <p className="mt-1 text-[10px] leading-none text-faint">
              Screen-aware help your team keeps
            </p>
          </div>
        </div>

        <button
          onClick={() => setDrawerOpen(true)}
          className="glass pointer-events-auto ml-auto flex items-center gap-2 rounded-full px-3.5 py-2 text-xs font-medium text-ink transition hover:brightness-125"
        >
          <TrailIcon />
          Trails
          {trails.length ? (
            <span className="rounded-full bg-moss-dim/60 px-1.5 py-0.5 text-[10px] text-moss">
              {trails.length}
            </span>
          ) : null}
        </button>
      </header>

      <TrailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        trails={trails}
        loading={loading}
        storeKind={storeKind}
        onOpenTrail={openTrail}
      />

      {replaying ? (
        <TrailReplay trail={replaying} onClose={() => setReplaying(null)} />
      ) : null}

      {!welcomed ? <Welcome onDismiss={dismissWelcome} /> : null}
    </div>
  );
}

function CairnMark() {
  // Three stacked stones — the trail marker the product is named for.
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <ellipse cx="12" cy="19" rx="8" ry="2.6" fill="#232733" />
      <ellipse cx="12" cy="15.5" rx="6.4" ry="2.4" fill="#5b6072" />
      <ellipse cx="12" cy="11.6" rx="4.8" ry="2.1" fill="#8b90a3" />
      <ellipse cx="12" cy="8.2" rx="3.2" ry="1.8" fill="#ff8f4c" />
    </svg>
  );
}

function TrailIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 20c3-1 4-4 7-4s5 3 8 1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="7" cy="9" r="2" fill="currentColor" />
      <circle cx="17" cy="5" r="2" fill="currentColor" />
    </svg>
  );
}

/**
 * First-run explainer.
 *
 * Three beats, because the product only makes sense as a sequence: it sees, it
 * points, and — the part that isn't Clicky — it remembers. Dismissed
 * permanently on first read; there is nothing here worth making someone
 * re-read, and a modal that returns is a modal people learn to swat.
 */
function Welcome({ onDismiss }: { onDismiss(): void }) {
  const beats = [
    {
      title: "It sees your screen",
      body: "Share a window and ask out loud. Cairn reads the pixels — no plugins, no integrations, nothing to install.",
    },
    {
      title: "It points at the answer",
      body: "Not a paragraph telling you where the button is. A cursor that lands on it, and a voice that walks you through.",
    },
    {
      title: "It remembers, for everyone",
      body: "Every answer can become a trail. The next teammate who hits that wall gets it instantly — no model call, no waiting.",
    },
  ];

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-void/90 p-4 backdrop-blur-sm">
      <div className="animate-rise glass w-full max-w-lg rounded-2xl p-6">
        <div className="flex items-center gap-2.5">
          <CairnMark />
          <h2 className="text-lg font-semibold tracking-tight text-ink">Cairn</h2>
        </div>
        <p className="mt-2 text-sm text-muted">
          A cairn is the stack of stones one traveller leaves so the next one doesn&apos;t get
          lost.
        </p>

        <ol className="mt-5 space-y-4">
          {beats.map((b, i) => (
            <li key={b.title} className="flex gap-3">
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                  i === 2 ? "bg-moss text-void" : "bg-raised text-muted"
                }`}
              >
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium text-ink">{b.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted">{b.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <button
          onClick={onDismiss}
          className="mt-6 w-full rounded-xl bg-ember py-2.5 text-sm font-medium text-void transition hover:brightness-110"
        >
          Start
        </button>
        <p className="mt-3 text-center text-[11px] text-faint">
          Your screen is only captured at the moment you ask. Frames are never stored unless you
          save a trail.
        </p>
      </div>
    </div>
  );
}
