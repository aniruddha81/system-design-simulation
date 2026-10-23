"use client";
import { useState } from "react";
import type { ComponentKind } from "@/engine/types";
import { KIND_BLURB, KIND_COLOR, KIND_LABEL, KINDS, KindIcon } from "./kinds";

export const DRAG_MIME = "application/x-sds-kind";

/** Searchable component library: drag onto the board (or onto a connection), or press to add. */
export function Library({ allowed, onAdd }: { allowed?: ComponentKind[]; onAdd: (kind: ComponentKind) => void }) {
  const [q, setQ] = useState("");
  const kinds = KINDS.filter(
    (k) => (!allowed || allowed.includes(k)) && `${KIND_LABEL[k]} ${KIND_BLURB[k]}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <section aria-label="Component library" className="flex min-h-0 flex-col gap-2">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search components"
        aria-label="Search components"
        className="h-8 w-full rounded-(--radius-sm) border border-(--border) bg-(--bg) px-2.5 text-sm text-(--text) placeholder:text-(--text-muted) focus-visible:outline-2 focus-visible:outline-(--accent)"
      />
      <ul className="flex flex-col gap-1 overflow-y-auto">
        {kinds.map((k) => (
          <li key={k}>
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, k);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onAdd(k)}
              title={`${KIND_BLURB[k]} Drag onto the board, or press to add.`}
              className="group flex w-full cursor-grab items-center gap-2.5 rounded-(--radius-sm) px-2 py-1.5 text-left hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent) active:cursor-grabbing"
            >
              <span
                className="grid size-7 shrink-0 place-items-center rounded-(--radius-sm) border"
                style={{ color: KIND_COLOR[k], borderColor: `color-mix(in oklab, ${KIND_COLOR[k]} 40%, transparent)` }}
              >
                <KindIcon kind={k} size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] text-(--text)">{KIND_LABEL[k]}</span>
                <span className="block truncate text-[11px] text-(--text-muted)">{KIND_BLURB[k]}</span>
              </span>
            </button>
          </li>
        ))}
        {kinds.length === 0 && <li className="px-2 py-1 text-xs text-(--text-muted)">No component matches “{q}”.</li>}
      </ul>
    </section>
  );
}
