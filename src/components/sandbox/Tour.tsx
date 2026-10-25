"use client";
// First-run coach marks: margin notes with hand-drawn arrows that teach drag → connect → Run → read results.
// Each step also advances by itself when the learner does the thing. Dismissal is remembered per browser.
import rough from "roughjs";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { RunStatus } from "@/lib/run-manager";
import { seedOf } from "./board-elements";
import styles from "./sandbox.module.css";

const KEY = "sds:tour";
export function tourDone(): boolean {
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    return true; // storage blocked: don't nag on every visit
  }
}
function markDone() {
  try {
    localStorage.setItem(KEY, "done");
  } catch {}
}

type Side = "right" | "below" | "left";
export const STEPS = [
  { anchor: '[data-tour="library"]', side: "right", title: "Add components", body: "Drag or press Client, then Service.", sketch: "Client + Service" },
  { anchor: ".react-flow__node .react-flow__handle-right", side: "below", title: "Connect", body: "Drag between ports. Keyboard: select, then C.", sketch: "Client → Service" },
  { anchor: '[data-tour="run"]', side: "below", title: "Run", body: "Watch requests travel. Resolve checks if blocked.", sketch: "○ → ○ → ○" },
  { anchor: '[data-tour="results"]', side: "left", title: "Observe", body: "Read goodput, latency and the busiest component.", sketch: "▂ ▃ ▅ ▇" },
  { anchor: '[data-tour="results"]', side: "left", title: "Improve", body: "Adjust the bottleneck. Run again and compare.", sketch: "Run → Edit → Run" },
] satisfies { anchor: string; side: Side; title: string; body: string; sketch: string }[];

const NOTE_W = 300;
const gen = rough.generator();

type Box = { x: number; y: number; w: number; h: number };
type Progress = { step: number; nodes: number; edges: number };

export function nextTourStep(progress: Progress, nodes: number, edges: number, runStatus: RunStatus) {
  if (progress.step === 0 && nodes > progress.nodes) return 1;
  if (progress.step === 1 && edges > progress.edges) return 2;
  if (progress.step === 2 && runStatus === "running") return 3;
  return progress.step;
}

export function Tour({ open, onClose, rootRef, nodes, edges, runStatus }: {
  open: boolean;
  onClose: () => void;
  rootRef: RefObject<HTMLElement | null>;
  nodes: number;
  edges: number;
  runStatus: RunStatus;
}) {
  const [progress, setProgress] = useState({ step: 0, nodes, edges });
  const { step } = progress;
  const [anchor, setAnchor] = useState<Box | null>(null);
  const [root, setRoot] = useState({ w: 0, h: 0 });
  const noteRef = useRef<HTMLDivElement>(null);
  const [noteH, setNoteH] = useState(170);
  const go = (i: number) => {
    setProgress({ step: i, nodes, edges });
  };
  const finish = () => {
    markDone();
    go(0);
    onClose();
  };

  const next = nextTourStep(progress, nodes, edges, runStatus);
  if (open && next !== step) go(next);

  // Anchors move (pan, zoom, panels): poll their box while the tour is open.
  useEffect(() => {
    if (!open) return;
    const read = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      const el = rootRef.current!.querySelector(STEPS[step].anchor)?.getBoundingClientRect();
      const next = el && el.width > 0 ? { x: el.left - r.left, y: el.top - r.top, w: el.width, h: el.height } : null;
      setAnchor((a) => (JSON.stringify(a) === JSON.stringify(next) ? a : next));
      setRoot((o) => (o.w === r.width && o.h === r.height ? o : { w: r.width, h: r.height }));
      const h = noteRef.current?.offsetHeight;
      if (h) setNoteH((o) => (o === h ? o : h));
    };
    read();
    const t = setInterval(read, 200);
    return () => clearInterval(t);
  }, [open, step, rootRef]);

  if (!open) return null;
  const s = STEPS[step];
  const narrow = root.w > 0 && root.w < 768;
  const pad = 12;

  // Place the note beside its anchor, then draw an arrow from the note to the anchor.
  let note: { x: number; y: number } | null = null;
  let from = { x: 0, y: 0 }, to = { x: 0, y: 0 };
  if (anchor && !narrow) {
    const clampX = (x: number) => Math.max(pad, Math.min(root.w - NOTE_W - pad, x));
    const clampY = (y: number) => Math.max(pad, Math.min(root.h - noteH - pad, y));
    if (s.side === "right") {
      note = { x: clampX(anchor.x + anchor.w + 64), y: clampY(anchor.y + 48) };
      from = { x: note.x - 6, y: note.y + 28 };
      to = { x: anchor.x + anchor.w + 10, y: Math.min(anchor.y + anchor.h - 20, note.y + 4) };
    } else if (s.side === "below") {
      note = { x: clampX(anchor.x + anchor.w / 2 - NOTE_W / 2 + 40), y: clampY(anchor.y + anchor.h + 64) };
      from = { x: Math.max(note.x + 24, Math.min(note.x + NOTE_W - 24, anchor.x + anchor.w / 2 + 30)), y: note.y - 6 };
      to = { x: anchor.x + anchor.w / 2, y: anchor.y + anchor.h + 10 };
    } else {
      note = { x: clampX(anchor.x - NOTE_W - 72), y: clampY(anchor.y + 40) };
      from = { x: note.x + NOTE_W + 6, y: note.y + 24 };
      to = { x: anchor.x - 8, y: anchor.y + anchor.h / 2 };
    }
  }
  // Hand-drawn arrow: a bowed curve plus an open head along the final tangent.
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const c = { x: (from.x + to.x) / 2 + ((to.y - from.y) / (len || 1)) * len * 0.22, y: (from.y + to.y) / 2 - ((to.x - from.x) / (len || 1)) * len * 0.22 };
  const ang = Math.atan2(to.y - c.y, to.x - c.x);
  const head = `M${to.x - 11 * Math.cos(ang - 0.5)},${to.y - 11 * Math.sin(ang - 0.5)} L${to.x},${to.y} L${to.x - 11 * Math.cos(ang + 0.5)},${to.y - 11 * Math.sin(ang + 0.5)}`;
  const ring = anchor && !narrow
    ? gen.toPaths(gen.rectangle(anchor.x - 6, anchor.y - 6, anchor.w + 12, anchor.h + 12, { seed: seedOf(`tour${step}`), roughness: 1.4, bowing: 1.2 })).map((p) => p.d)
    : [];

  return (
    <>
      {note && (
        <svg key={step} className="pointer-events-none absolute inset-0 z-[45] overflow-visible" width={root.w} height={root.h} aria-hidden="true">
          <g fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--accent-2)" }}>
            {ring.map((d, i) => <path key={i} d={d} strokeWidth={1.4} opacity={0.75} pathLength={1} className={styles.tourInk} />)}
            <path d={`M${from.x},${from.y} Q${c.x},${c.y} ${to.x},${to.y}`} strokeWidth={1.8} pathLength={1} className={styles.tourInk} />
            <path d={head} strokeWidth={1.8} pathLength={1} className={`${styles.tourInk} ${styles.tourHead}`} />
          </g>
        </svg>
      )}
      <div
        ref={noteRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        onKeyDown={(e) => e.key === "Escape" && finish()}
        className={`${styles.tourNote} z-50 rounded-(--radius) border border-(--rule,var(--border)) border-l-[3px] border-l-(--accent-2) bg-(--surface) p-4 shadow-(--elev-3) ${narrow || !note ? "fixed inset-x-3 bottom-3 mx-auto max-w-sm" : "absolute"}`}
        style={note && !narrow ? { left: note.x, top: note.y, width: NOTE_W } : undefined}
      >
        <div aria-live="polite">
          <p className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] text-(--accent)">{step + 1}/{STEPS.length}</span>
            <span id="tour-title" className="margin-note text-lg leading-snug">{s.title}</span>
          </p>
          <p aria-hidden="true" className="my-3 border-y border-(--rule) py-3 text-center font-mono text-xl text-(--accent-2)">{s.sketch}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-(--ink-2,var(--text))">{s.body}</p>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="flex gap-1" aria-hidden="true">
            {STEPS.map((_, i) => <span key={i} className={`h-1 w-4 rounded-full ${i <= step ? "bg-(--accent-2)" : "bg-(--surface-2)"}`} />)}
          </span>
          <button type="button" onClick={finish} className="ml-auto h-8 rounded-(--radius-sm) px-2.5 text-sm text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent)">
            Skip tour
          </button>
          <button
            type="button"
            onClick={() => (step === STEPS.length - 1 ? finish() : go(step + 1))}
            className="h-8 rounded-(--radius-sm) border border-(--rule,var(--border)) bg-(--bg) px-3 text-sm font-medium text-(--text) hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)"
          >
            {step === STEPS.length - 1 ? "Got it" : "Next →"}
          </button>
        </div>
      </div>
    </>
  );
}
