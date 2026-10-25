import type { ReactNode } from "react";

/** Progress ring: value 0-1. Decorative by default (the number or label next to it carries the meaning). */
export function Ring({ value, size = 44, stroke = 5, tone = "var(--accent-2)", children, label }: { value: number; size?: number; stroke?: number; tone?: string; children?: ReactNode; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="shrink-0" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--rule)" strokeWidth="1" strokeDasharray="2 3" opacity="0.7" />
      {v > 0 && (
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      )}
      {children}
    </svg>
  );
}

/** Centred glyph/number inside a Ring. */
export function RingText({ size = 44, children, fontSize = 12 }: { size?: number; children: ReactNode; fontSize?: number }) {
  return (
    <text x={size / 2} y={size / 2 + fontSize * 0.36} textAnchor="middle" fontSize={fontSize} fontFamily="var(--font-mono)" fill="var(--text)">
      {children}
    </text>
  );
}
