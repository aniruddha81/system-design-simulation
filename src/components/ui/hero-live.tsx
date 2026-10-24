"use client";

import { useState, type ReactNode } from "react";

/** The one live thing on the home page: take the cache node down and watch reads fall through. */
export function HeroLive({ children }: { children: ReactNode }) {
  const [down, setDown] = useState(false);
  const [paused, setPaused] = useState(false);
  return (
    <figure data-down={down} data-paused={paused} className="group relative">
      <div className="paper-grid relative overflow-hidden rounded-lg border border-border bg-surface shadow-e3">
        <div className="flex flex-wrap justify-end gap-2 px-3 pt-3 sm:px-4 sm:pt-4">
          <button type="button" className="btn motion-control h-9 min-h-9 px-3 text-sm" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume traffic" : "Pause traffic"}
          </button>
          <button type="button" className="btn h-9 min-h-9 px-3 text-sm" aria-pressed={down} onClick={() => setDown((d) => !d)}>
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              {down ? <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.4 2.6v2.6H6" /> : <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />}
            </svg>
            {down ? "Restart the cache" : "Kill the cache"}
          </button>
        </div>
        {children}
      </div>
      <figcaption className="figcap mt-3 max-w-[56ch]" aria-live="polite">
        <b>Fig. 1</b>
        {down
          ? "Cache node down. Every read falls through, and the database queues behind its few workers."
          : "Cache-aside read path. Hot keys are served from the cache; misses fall through to the database."}
      </figcaption>
    </figure>
  );
}
