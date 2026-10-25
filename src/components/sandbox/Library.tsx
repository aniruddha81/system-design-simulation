"use client";
import { useId, useRef, useState } from "react";
import type { ComponentKind } from "@/engine/types";
import { KIND_BLURB, KIND_CATEGORY, KIND_LABEL, KIND_TEACH, KINDS, KindSwatch, type KindCategory } from "./kinds";
import styles from "./sandbox.module.css";

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
  // "What does this do?" explainer beside the hovered or focused entry.
  const [tip, setTip] = useState<{ kind: ComponentKind; top: number } | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const tipId = useId();
  const query = q.trim().toLowerCase();
  const kinds = KINDS.filter((k) => (!allowed || allowed.includes(k)) && `${KIND_LABEL[k]} ${KIND_BLURB[k]} ${KIND_CATEGORY[k]}`.toLowerCase().includes(query));
  const show = (kind: ComponentKind, el: HTMLElement) => {
    const root = rootRef.current?.getBoundingClientRect();
    if (root) setTip({ kind, top: el.getBoundingClientRect().top - root.top });
  };
  return (
    <section ref={rootRef} aria-label="Component library" data-tour="library" className="relative flex min-h-0 flex-col gap-2">
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
        className="h-9 w-full shrink-0 rounded-(--radius-sm) border border-(--rule,var(--border)) bg-(--bg) px-2.5 text-sm text-(--text) placeholder:text-(--text-muted) focus-visible:outline-2 focus-visible:outline-(--accent)"
      />
      <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1 pb-1" onScroll={() => setTip(null)}>
        {ORDER.map((cat) => {
          const list = kinds.filter((k) => KIND_CATEGORY[k] === cat);
          if (!list.length) return null;
          return (
            <div key={cat}>
              <h3 className="sticky top-0 z-10 bg-(--surface) px-1 py-1 font-mono text-[10.5px] uppercase tracking-wider text-(--text-muted)">{cat}</h3>
              <ul className="flex flex-col gap-0.5">
                {list.map((k) => (
                  <li key={k}>
                    <button
                      type="button"
                      draggable
                      data-kind={k}
                      aria-describedby={tip?.kind === k ? tipId : undefined}
                      onDragStart={(e) => {
                        setTip(null);
                        setDragging(k);
                        e.dataTransfer.setData(DRAG_MIME, k);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onDragEnd={() => setDragging(null)}
                      onClick={() => onAdd(k)}
                      onPointerEnter={(e) => e.pointerType === "mouse" && show(k, e.currentTarget)}
                      onPointerLeave={() => setTip(null)}
                      onFocus={(e) => show(k, e.currentTarget)}
                      onBlur={() => setTip(null)}
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
      {tip && (
        <div
          id={tipId}
          role="tooltip"
          className={`${styles.explainer} pointer-events-none absolute left-[calc(100%+20px)] z-40 hidden w-64 rounded-(--radius) border border-(--rule,var(--border)) bg-(--surface) p-3 shadow-(--elev-3) md:block`}
          style={{ top: Math.max(0, tip.top - 8) }}
        >
          <p className="flex items-center gap-2">
            <KindSwatch kind={tip.kind} size={24} />
            <span className="font-(family-name:--font-display) text-base font-medium text-(--text)">{KIND_LABEL[tip.kind]}</span>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-(--text-muted)">{KIND_CATEGORY[tip.kind]}</span>
          </p>
          <p className="margin-note mt-2 text-[15px]">{KIND_TEACH[tip.kind]}</p>
          <p className="mt-2 text-xs leading-relaxed text-(--ink-2,var(--text))">{KIND_BLURB[tip.kind]}</p>
          <p className="mt-2 border-t border-(--border) pt-2 text-[11px] text-(--text-muted)">Drag onto the board or a connection · press to add</p>
        </div>
      )}
    </section>
  );
}
