"use client";
import { useState } from "react";
import type { ComponentKind } from "@/engine/types";
import { KIND_BLURB, KIND_CATEGORY, KIND_LABEL, KINDS, KindSwatch, type KindCategory } from "./kinds";

export const DRAG_MIME = "application/x-sds-kind";
/** The kind being dragged from the library (dataTransfer can't be read during dragover). */
export const dragging: { kind: ComponentKind | null } = { kind: null };
export function setDragging(kind: ComponentKind | null) {
  dragging.kind = kind;
}

const ORDER: KindCategory[] = ["Traffic", "Edge", "Compute", "Storage", "Messaging", "Resilience"];

/** Searchable component library: drag onto the board (or onto a connection), or press to add. */
export function Library({ allowed, onAdd }: { allowed?: ComponentKind[]; onAdd: (kind: ComponentKind) => void }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const kinds = KINDS.filter((k) => (!allowed || allowed.includes(k)) && `${KIND_LABEL[k]} ${KIND_BLURB[k]} ${KIND_CATEGORY[k]}`.toLowerCase().includes(query));
  return (
    <section aria-label="Component library" className="flex min-h-0 flex-col gap-2">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && kinds[0]) {
            onAdd(kinds[0]);
            setQ("");
          }
        }}
        placeholder="Search components"
        aria-label="Search components (Enter adds the first match)"
        className="h-9 w-full rounded-(--radius-sm) border border-(--border) bg-(--bg) px-2.5 text-sm text-(--text) placeholder:text-(--text-muted) focus-visible:outline-2 focus-visible:outline-(--accent)"
      />
      <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1 pb-1">
        {ORDER.map((cat) => {
          const list = kinds.filter((k) => KIND_CATEGORY[k] === cat);
          if (!list.length) return null;
          return (
            <div key={cat}>
              <h3 className="sticky top-0 z-10 bg-(--surface) px-1 py-1 text-[11px] font-medium text-(--text-muted)">{cat}</h3>
              <ul className="flex flex-col gap-0.5">
                {list.map((k) => (
                  <li key={k}>
                    <button
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        setDragging(k);
                        e.dataTransfer.setData(DRAG_MIME, k);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onDragEnd={() => setDragging(null)}
                      onClick={() => onAdd(k)}
                      title={`${KIND_BLURB[k]} Drag onto the board or onto a connection, or press to add.`}
                      className="group flex min-h-11 w-full cursor-grab items-center gap-2.5 rounded-(--radius-sm) px-1.5 py-1 text-left transition-colors hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent) active:cursor-grabbing"
                    >
                      <span className="transition-transform duration-150 group-hover:scale-110 motion-reduce:transition-none"><KindSwatch kind={k} size={30} /></span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-(--text)">{KIND_LABEL[k]}</span>
                        <span className="block truncate text-[11px] text-(--text-muted)">{KIND_BLURB[k]}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {kinds.length === 0 && <p className="px-2 py-1 text-xs text-(--text-muted)">No component matches “{q}”.</p>}
      </div>
    </section>
  );
}
