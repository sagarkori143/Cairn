"use client";

import { useEffect } from "react";
import { TrailLibrary } from "./TrailLibrary";
import type { Trail } from "@/lib/types";

/**
 * The team's trails, tucked off-stage until asked for.
 *
 * The library used to be a tab, which meant leaving the screen you were
 * sharing to go and look at it. As a drawer it slides over instead: the shared
 * screen stays mounted and streaming behind it, so opening the library never
 * interrupts a capture or costs you the browser's share permission.
 *
 * Rendered even while closed — translated off-screen rather than unmounted —
 * so it animates both ways and its scroll position survives being reopened.
 */

interface TrailDrawerProps {
  open: boolean;
  onClose(): void;
  trails: Trail[];
  loading: boolean;
  storeKind: "shared" | "ephemeral" | null;
  onOpenTrail(trail: Trail): void;
}

export function TrailDrawer({
  open,
  onClose,
  trails,
  loading,
  storeKind,
  onOpenTrail,
}: TrailDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  return (
    <>
      {/* Scrim. Fades rather than snapping, and stops pointer events when hidden. */}
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-40 bg-void/70 backdrop-blur-[2px] transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        aria-hidden={!open}
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-line bg-surface transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-medium text-ink">Team trails</h2>
            <p className="mt-0.5 text-[11px] text-faint">
              Answers your team already worked out
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg px-2.5 py-1.5 text-xs text-muted transition hover:bg-raised hover:text-ink"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <TrailLibrary
            trails={trails}
            loading={loading}
            storeKind={storeKind}
            onOpen={onOpenTrail}
          />
        </div>
      </aside>
    </>
  );
}
