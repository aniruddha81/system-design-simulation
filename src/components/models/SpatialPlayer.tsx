"use client";

import { useState } from "react";
import { createSpatialModel, geohashEncode, geohashDecode, geohashNeighbours, type SpatialState, type SpatialAction } from "@/models";
import { FocusedPlayer, Diagram, ModelTable } from "./FocusedPlayer";
import { leafCells, scale, spatialViewport } from "./view-logic";

const model = createSpatialModel();
const summary = (s: SpatialState) => `${s.points.length} points, ${leafCells(s.tree).length} quadtree leaf cells. Query returns ${s.result?.points.map(p => p.id).join(", ") || "no points"}; visits ${s.result?.visited.map(c => c.id).join(", ") || "no cells"}. Distances use planar coordinate units.`;

export function SpatialPlayer({ seed = 1 }: { seed?: number }) {
  return <FocusedPlayer model={model} seed={seed} no="M10" title="Spatial cells and query traversal" summary={summary}>{p => {
    const query = p.timeline.slice(0, p.cursor).findLast(a => a.type !== "insert");
    return <SpatialView state={p.state} query={p.state.result ? query : undefined} inject={p.inject} />;
  }}</FocusedPlayer>;
}

function SpatialView({ state: s, query, inject }: { state: SpatialState; query?: Exclude<SpatialAction, { type: "insert" }>; inject: (a: SpatialAction) => void }) {
  const [mode, setMode] = useState("quadtree"), [precision, setPrecision] = useState(3);
  const [cx, setCx] = useState(0), [cy, setCy] = useState(0), [radius, setRadius] = useState(10);
  const bounds = spatialViewport(s.points, query);
  const x = (v: number) => scale(v, bounds.minX, bounds.maxX, 40, 560), y = (v: number) => scale(v, bounds.minY, bounds.maxY, 300, 35);
  const hashes = [...new Set([...s.points.map(p => geohashEncode(p.y, p.x, precision)), ...(query ? [geohashEncode(query.center.y, query.center.x, precision), ...geohashNeighbours(geohashEncode(query.center.y, query.center.x, precision))] : [])])];
  const cells = mode === "quadtree" ? leafCells(s.tree) : hashes.map(id => ({ id, bounds: geohashDecode(id) }));
  return <>
    <div className="flex flex-wrap gap-3 text-sm">
      <label>Cells<select className="field ml-2" value={mode} onChange={e => setMode(e.target.value)}><option value="quadtree">Quadtree</option><option value="geohash">Geohash</option></select></label>
      {mode === "geohash" && <label>Precision<select className="field ml-2" value={precision} onChange={e => setPrecision(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6].map(n => <option key={n}>{n}</option>)}</select></label>}
    </div>
    <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={e => { e.preventDefault(); inject({ type: "radius", center: { id: "query", x: cx, y: cy }, radius }); }}>
      <label>Center x<input type="number" step="any" min={-180} max={180} required className="field block w-28" value={cx} onChange={e => setCx(e.target.valueAsNumber)} /></label>
      <label>Center y<input type="number" step="any" min={-90} max={90} required className="field block w-28" value={cy} onChange={e => setCy(e.target.valueAsNumber)} /></label>
      <label>Radius<input type="number" step="any" min={0} required className="field block w-28" value={radius} onChange={e => setRadius(e.target.valueAsNumber)} /></label>
      <button type="submit" className="btn min-h-9">Query radius</button>
    </form>
    <p className="text-sm text-muted">View fits the points and query. Shaded quadtree leaves were visited; ✓ marks a result. Geohash shows occupied cells and the query cell&apos;s eight neighbours; those candidates may not cover a large radius.</p>
    <Diagram label={`${mode} cells and query radius. ${summary(s)}`} height={350}>
      <svg x={40} y={35} width={520} height={265} viewBox="40 35 520 265">
        {cells.map(c => <rect key={c.id} x={x(c.bounds.minX)} y={y(c.bounds.maxY)} width={x(c.bounds.maxX) - x(c.bounds.minX)} height={y(c.bounds.minY) - y(c.bounds.maxY)} fill={mode === "quadtree" && s.result?.visited.some(v => v.id === c.id) ? "var(--surface-2)" : "none"} stroke="var(--kind-database)" strokeWidth={1.5}><title>{c.id}</title></rect>)}
        {query && <>
          {query.type === "radius" && <ellipse cx={x(query.center.x)} cy={y(query.center.y)} rx={x(query.center.x + query.radius) - x(query.center.x)} ry={y(query.center.y) - y(query.center.y + query.radius)} fill="none" stroke="var(--accent)" strokeWidth={2} />}
          <path d={`M${x(query.center.x) - 6},${y(query.center.y)}h12 m-6,-6v12`} stroke="var(--accent)" strokeWidth={2} />
        </>}
        {s.points.map(point => <g key={point.id}><circle cx={x(point.x)} cy={y(point.y)} r={5} fill="var(--kind-service)" /><text x={x(point.x) + 8} y={y(point.y) - 8} fill="currentColor" fontSize={12}>{s.result?.points.some(r => r.id === point.id) ? "✓ " : ""}{point.id}</text></g>)}
      </svg>
      <text x={40} y={325} fill="currentColor" fontSize={11}>x: {bounds.minX.toPrecision(4)} … {bounds.maxX.toPrecision(4)} · y: {bounds.minY.toPrecision(4)} … {bounds.maxY.toPrecision(4)}</text>
    </Diagram>
    <ModelTable caption="Points, geohashes, and query results" headers={["Point", "x", "y", "Geohash", "Result rank"]} rows={s.points.map(p => [p.id, p.x, p.y, geohashEncode(p.y, p.x, precision), s.result?.points.some(r => r.id === p.id) ? s.result.points.findIndex(r => r.id === p.id) + 1 : "—"])} />
    <ModelTable caption="Visited quadtree cells (text alternative)" headers={["Cell", "x bounds", "y bounds"]} rows={(s.result?.visited ?? []).map(c => [c.id, `${c.bounds.minX} … ${c.bounds.maxX}`, `${c.bounds.minY} … ${c.bounds.maxY}`])} />
  </>;
}
