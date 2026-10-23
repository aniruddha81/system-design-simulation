"use client";
// Annotation layer: freehand pen, text, sticky notes. Lives in its own store, never in the Design.
import { useReactFlow, ViewportPortal } from "@xyflow/react";
import getStroke from "perfect-freehand";
import { useState } from "react";
import { useAnnotations, type Annotation } from "./design-store";

export type Tool = "select" | "hand" | "pen" | "text" | "note" | "connect";

function strokePath(points: [number, number, number][]): string {
  const outline = getStroke(points, { size: 5, thinning: 0.55, smoothing: 0.5, streamline: 0.45 });
  if (outline.length < 2) return "";
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...outline[0], "Q"] as (string | number)[],
  );
  return d.join(" ") + " Z";
}

const uid = () => crypto.randomUUID().slice(0, 8);

export function AnnotationLayer({ tool, onDone }: { tool: Tool; onDone: () => void }) {
  const [items, store] = useAnnotations();
  const { screenToFlowPosition } = useReactFlow();
  const [draft, setDraft] = useState<[number, number, number][] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const capturing = tool === "pen" || tool === "text" || tool === "note";

  const set = (next: Annotation[]) => store.setState({ items: next });
  const update = (id: string, text: string) =>
    set(store.getState().items.map((a) => (a.id === id && a.type !== "stroke" ? { ...a, text } : a)));
  const remove = (id: string) => set(store.getState().items.filter((a) => a.id !== id));

  const at = (e: React.PointerEvent) => {
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [p.x, p.y, e.pressure || 0.5] as [number, number, number];
  };

  return (
    <>
      <ViewportPortal>
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden="true">
          {items.map((a) => a.type === "stroke" && <path key={a.id} d={strokePath(a.points)} style={{ fill: a.color }} />)}
          {draft && <path d={strokePath(draft)} style={{ fill: "var(--text)" }} />}
        </svg>
        {items.map((a) =>
          a.type === "stroke" ? null : (
            <div
              key={a.id}
              className="group nopan nodrag nowheel absolute"
              style={{ transform: `translate(${a.x}px, ${a.y}px)`, pointerEvents: "all" }}
            >
              <textarea
                aria-label={a.type === "note" ? "Sticky note" : "Text annotation"}
                autoFocus={a.id === fresh}
                value={a.text}
                rows={Math.max(1, a.text.split("\n").length)}
                placeholder={a.type === "note" ? "Note…" : "Text…"}
                onChange={(e) => update(a.id, e.target.value)}
                onBlur={() => {
                  if (!a.text.trim()) remove(a.id);
                  setFresh(null);
                }}
                className={
                  a.type === "note"
                    ? "block w-48 resize-none rounded-sm bg-[#f8e7a1] p-3 text-sm leading-snug text-[#3b3214] shadow-[0_6px_18px_-6px_rgb(0_0_0/0.5)] outline-none [field-sizing:content] focus-visible:ring-2 focus-visible:ring-(--accent)"
                    : "block min-w-24 resize-none bg-transparent text-base text-(--text) outline-none [field-sizing:content] focus-visible:ring-1 focus-visible:ring-(--accent)"
                }
              />
              <button
                type="button"
                onClick={() => remove(a.id)}
                aria-label="Delete annotation"
                className="absolute -right-3 -top-3 hidden size-6 place-items-center rounded-full border border-(--border) bg-(--surface) text-xs text-(--text-muted) group-focus-within:grid group-hover:grid"
              >
                ✕
              </button>
            </div>
          ),
        )}
      </ViewportPortal>
      {capturing && (
        <div
          className="absolute inset-0 z-10 touch-none"
          style={{ cursor: tool === "pen" ? "crosshair" : "text" }}
          onPointerDown={(e) => {
            if (tool === "pen") {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDraft([at(e)]);
              return;
            }
            const [x, y] = at(e);
            const id = uid();
            set([...store.getState().items, { id, type: tool, x, y, text: "" }]);
            setFresh(id);
            onDone();
          }}
          onPointerMove={(e) => draft && setDraft([...draft, at(e)])}
          onPointerUp={() => {
            if (draft && draft.length > 1) set([...store.getState().items, { id: uid(), type: "stroke", points: draft, color: "var(--text)" }]);
            setDraft(null);
          }}
        />
      )}
    </>
  );
}
