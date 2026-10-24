import type { ReactNode } from "react";
import s from "./notebook.module.css";

export { s as nb };

/** A numbered figure, as in a technical manual. The caption names the figure for assistive tech. */
export function Figure({ no, title, note, children, className = "my-6" }: { no: string; title: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <figure role="group" aria-label={`Figure ${no}: ${title}`} className={`${s.figure} ${className}`}>
      <figcaption className={s.caption}>
        <span className={s.figNo}>Fig. {no}</span>
        <span className={s.figTitle}>{title}</span>
        {note && <span className={s.figNote}>{note}</span>}
      </figcaption>
      {children}
    </figure>
  );
}

// Heat ramp (cool → hot) for the failure ladder, sweep and board heat; fallbacks until D1's tokens land.
export const HEAT = [
  "var(--heat-0, var(--success))",
  "var(--heat-1, var(--accent-2))",
  "var(--heat-2, var(--warning))",
  "var(--heat-3, var(--warning))",
  "var(--heat-4, var(--danger))",
] as const;
export const HEAT_WORDS = ["idle", "warm", "hot", "saturated", "overflowing"] as const;
/** Heat (utilisation + dropped fraction, 0..2) → bucket 0..4. */
export const heatBucket = (h: number) => (h < 0.5 ? 0 : h < 0.8 ? 1 : h < 0.95 ? 2 : h < 1.2 ? 3 : 4);

// Categorical series in fixed order (entity keeps its colour); borrows the component-kind hues.
export const SERIES = [
  "var(--kind-service, var(--accent))",
  "var(--kind-cache, var(--accent-2))",
  "var(--kind-database, var(--warning))",
  "var(--kind-queue, var(--success))",
  "var(--kind-cdn, var(--danger))",
  "var(--kind-kvStore, var(--text-muted))",
  "var(--kind-worker, var(--accent))",
  "var(--kind-loadBalancer, var(--accent-2))",
] as const;

/** Slight hand-drawn wobble for diagram strokes. Put inside an <svg>, reference with filter={`url(#${id})`}. */
export function SketchFilter({ id }: { id: string }) {
  return (
    <defs>
      <filter id={id} x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves={2} seed={7} result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale={2.2} />
      </filter>
    </defs>
  );
}
