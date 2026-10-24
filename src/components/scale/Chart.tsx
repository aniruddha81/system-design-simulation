"use client";

import { useId, useState } from "react";
import { nb } from "@/components/models/notebook";

export type Point = { x: number; y: number | null; label: string; fill?: string; note?: string };
export type Series = { name: string; points: Point[]; stroke: string; dash?: string };

const W = 640, H = 220, L = 46, R = 96, T = 18, B = 30;

/**
 * Line chart on one 0..yMax axis (never dual-axis), with a legend, direct labels, optional
 * annotation and an accessible data-table toggle. Points can carry their own fill (heat).
 */
export function Chart({
  title,
  series,
  xTicks,
  formatY,
  table,
  mark,
  yMax = 1,
}: {
  title: string;
  series: Series[];
  xTicks: { x: number; label: string }[];
  formatY: (y: number) => string;
  table: { head: string[]; rows: string[][] };
  mark?: { x: number; label: string };
  yMax?: number;
}) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const sx = (x: number) => L + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - L - R);
  const sy = (y: number) => T + (1 - Math.max(0, Math.min(y, yMax)) / yMax) * (H - T - B);
  const path = (pts: Point[]) =>
    pts.reduce((d, p, i) => (p.y === null ? d : `${d}${i > 0 && pts[i - 1].y !== null ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`), "");
  const visible = series.filter((s) => s.points.some((p) => p.y !== null));

  return (
    <figure className="grid gap-2" aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption id={id} className="text-sm font-medium">
          {title}
        </figcaption>
        <button type="button" className="btn btn-ghost min-h-8 px-2 text-sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show chart" : "Show as table"}
        </button>
      </div>
      {visible.length > 1 && !asTable && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
          {visible.map((s) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <svg width="22" height="8" aria-hidden>
                <line x1="1" x2="21" y1="4" y2="4" stroke={s.stroke} strokeWidth={2} strokeDasharray={s.dash} />
              </svg>
              {s.name}
            </li>
          ))}
        </ul>
      )}
      {asTable ? (
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-left text-muted">
              <tr>
                {table.head.map((h) => (
                  <th key={h} scope="col" className="px-3 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {r.map((c, j) =>
                    j === 0 ? (
                      <th key={j} scope="row" className="num px-3 py-1 text-left font-normal">
                        {c}
                      </th>
                    ) : (
                      <td key={j} className="num px-3 py-1">
                        {c}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : visible.length === 0 ? (
        <p className={`${nb.note} rounded-md border border-dashed border-border p-4`}>
          Nothing to plot: the fidelity check disabled these predictions for this design. See the fidelity reasons beside the results; the table lists each level.
        </p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${title}. Use "Show as table" for the values.`}>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={L} x2={W - R} y1={sy(f * yMax)} y2={sy(f * yMax)} stroke="var(--border)" strokeWidth={1} strokeDasharray={f === 0 ? undefined : "2 4"} />
              {f % 0.5 === 0 && (
                <text x={L - 8} y={sy(f * yMax) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)" style={{ fontFamily: "var(--font-mono)" }}>
                  {formatY(f * yMax)}
                </text>
              )}
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t.x} x={sx(t.x)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--text-muted)" style={{ fontFamily: "var(--font-mono)" }}>
              {t.label}
            </text>
          ))}
          {mark && (
            <g>
              <line x1={sx(mark.x)} x2={sx(mark.x)} y1={T - 6} y2={H - B} stroke="var(--text)" strokeWidth={1.25} strokeDasharray="5 4" />
              <text x={sx(mark.x) + 6} y={T + 4} fontSize={12} fontWeight={600} fill="var(--text)" style={{ fontFamily: "var(--font-display, var(--font-sans))" }}>
                {mark.label}
              </text>
            </g>
          )}
          {visible.map((s) => {
            const lastPoint = [...s.points].reverse().find((p) => p.y !== null)!;
            const few = s.points.length <= 24;
            return (
              <g key={s.name}>
                <path d={path(s.points)} fill="none" stroke={s.stroke} strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
                {few &&
                  s.points.map((p) =>
                    p.y === null ? null : (
                      <g key={p.x}>
                        <circle cx={sx(p.x)} cy={sy(p.y)} r={11} fill="transparent">
                          <title>{`${s.name} at ${p.label}: ${formatY(p.y)}${p.note ? ` (${p.note})` : ""}`}</title>
                        </circle>
                        <circle cx={sx(p.x)} cy={sy(p.y)} r={4.5} fill={p.fill ?? s.stroke} stroke="var(--surface)" strokeWidth={2} pointerEvents="none" />
                      </g>
                    ),
                  )}
                {/* Direct label at the line end; legend carries identity too. */}
                <text x={sx(lastPoint.x) + 8} y={sy(lastPoint.y!) + 4} fontSize={11} fill="var(--text)">
                  {s.name.length > 14 ? `${s.name.slice(0, 13)}…` : s.name}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {mark && !asTable && <p className={nb.note}>{mark.label}: the first level where the estimate degrades.</p>}
    </figure>
  );
}
