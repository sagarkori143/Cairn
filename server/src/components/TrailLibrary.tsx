"use client";

import { useEffect, useMemo, useState } from "react";
import { searchTrails } from "@/lib/recall";
import type { Trail } from "@/lib/types";

/**
 * The team's accumulated trails.
 *
 * Filtering happens client-side against the already-loaded list rather than
 * round-tripping per keystroke: the whole point of this surface is that team
 * knowledge feels instant, and a spinner between keystrokes would undercut
 * that for no benefit at the scale a single team's library actually reaches.
 */

interface TrailLibraryProps {
  trails: Trail[];
  loading: boolean;
  storeKind: "shared" | "ephemeral" | null;
  onOpen(trail: Trail): void;
}

export function TrailLibrary({ trails, loading, storeKind, onOpen }: TrailLibraryProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => (query.trim() ? searchTrails(query, trails) : trails),
    [query, trails],
  );

  const totalReuse = trails.reduce((sum, t) => sum + t.reuseCount, 0);

  return (
    <div>
      {/* The drawer supplies the heading, so this is just the stats and filter. */}
      <div className="mb-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search trails"
          className="w-full rounded-lg border border-line bg-void px-3 py-2.5 text-sm text-ink outline-none placeholder:text-faint focus:border-faint"
        />
        <p className="mt-2.5 text-xs text-muted">
          {trails.length} walkthrough{trails.length === 1 ? "" : "s"} · reused {totalReuse} times
          instead of asking again
        </p>
      </div>

      {storeKind === "ephemeral" ? (
        <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-faint">
          Running on the in-memory store, so trails you save reset when the server sleeps. Set the
          Upstash environment variables to make them permanent and shared.
        </p>
      ) : null}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-32 rounded-xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-10 text-center text-sm text-muted">
          {query ? `Nothing matches “${query}” yet.` : "No trails yet. Ask something to start one."}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((trail) => (
            <TrailCard key={trail.id} trail={trail} onOpen={() => onOpen(trail)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TrailCard({ trail, onOpen }: { trail: Trail; onOpen(): void }) {
  return (
    <button
      onClick={onOpen}
      className="group animate-rise flex flex-col rounded-xl border border-line bg-surface p-4 text-left transition hover:border-faint hover:bg-raised"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium leading-snug text-ink">{trail.title}</h3>
        <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">
          {trail.app}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-xs text-faint">“{trail.question}”</p>

      <div className="mt-auto flex items-center gap-2 pt-3 text-[11px] text-muted">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-void"
          style={{ background: trail.author.color }}
        >
          {trail.author.initials}
        </span>
        {trail.author.name}
        <span className="text-faint">·</span>
        {trail.steps.length} steps
        {trail.reuseCount > 0 ? (
          <>
            <span className="text-faint">·</span>
            <span className="text-moss">saved {trail.reuseCount} re-asks</span>
          </>
        ) : null}
      </div>
    </button>
  );
}

/** Loads trails once and exposes a refresh for when a new one is saved. */
export function useTrails() {
  const [trails, setTrails] = useState<Trail[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeKind, setStoreKind] = useState<"shared" | "ephemeral" | null>(null);

  const refresh = useMemo(
    () => async () => {
      try {
        const res = await fetch("/api/trails");
        const data = (await res.json()) as {
          trails: Trail[];
          storeKind: "shared" | "ephemeral";
        };
        setTrails(data.trails);
        setStoreKind(data.storeKind);
      } catch {
        /* library stays as-is; the live half still works */
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { trails, loading, storeKind, refresh, setTrails };
}
