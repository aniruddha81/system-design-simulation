import type { CaseStudy } from "@/content/case-studies";
import { Flow, Stats } from "@/components/visual/kit";

export function EstimateTiles({ estimates }: { estimates: CaseStudy["estimates"] }) {
  return <div className="[&_li]:min-w-0 [&_.num]:break-words"><Stats title="Worked estimates" items={estimates.map((e) => ({ label: e.label, value: e.result, sub: `${e.formula}${e.note ? ` · ${e.note}` : ""}` }))} /></div>;
}

export function DesignFlow({ design }: { design: CaseStudy["design"] }) {
  const xs = design.nodes.map((n) => n.position.x);
  const ys = design.nodes.map((n) => n.position.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX, spanY = Math.max(...ys) - minY;
  return <div><Flow title={`${design.name} architecture`} height={400}
    nodes={design.nodes.map((n) => ({ id: n.id, label: n.label.length > 12 ? `${n.label.slice(0, 11)}…` : n.label, kind: n.kind,
      x: spanX ? 5 + (n.position.x - minX) / spanX * 90 : 50,
      y: spanY ? 8 + (n.position.y - minY) / spanY * 84 : 50 }))}
    edges={design.edges.map((e) => ({ from: e.from, to: e.to }))}
    caption="Arrows show permitted calls. Open the canvas to inspect route programs." />
    <details><summary className="min-h-6 cursor-pointer">Component labels and connections</summary>
      <ul className="mt-3 space-y-2 text-sm">{design.nodes.map((n) => <li key={n.id}><span className="font-medium">{n.label}</span> ({n.kind}) · calls: {design.edges.filter((e) => e.from === n.id).map((e) => design.nodes.find((target) => target.id === e.to)?.label ?? e.to).join(", ") || "none"}</li>)}</ul>
    </details></div>;
}

export function RubricMeter({ stage, value }: { stage: string; value?: number }) {
  return <div role="img" aria-label={`${stage}: ${value ? `${value} of 4` : "not rated"}`} className="my-3 flex items-center gap-3">
    <span className="grid flex-1 grid-cols-4 gap-1" aria-hidden="true">
      {[1, 2, 3, 4].map((level) => <span key={level} className="h-3 border border-rule" style={{ background: level <= (value ?? 0) ? "var(--accent-2)" : "var(--surface-2)" }} />)}
    </span>
    <span className="font-mono text-sm">{value ? `${value}/4` : "Unrated"}</span>
  </div>;
}
