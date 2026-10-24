import { random } from "../random";
import type { Model, Script, Violation } from "../types";

const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
export interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
export interface Point { id: string; x: number; y: number }
export interface Cell { id: string; bounds: Bounds; points: Point[]; children: Cell[] }
function coordinate(lat: number, lon: number) { if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error("Latitude/longitude out of range"); }
export function geohashEncode(latitude: number, longitude: number, precision = 6): string {
  coordinate(latitude, longitude);
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) throw new Error("Geohash precision must be 1..12");
  const low = [-180, -90], high = [180, 90], value = [longitude, latitude];
  let hash = "", digit = 0;
  for (let i = 0; i < precision * 5; i++) {
    const axis = i % 2, mid = (low[axis] + high[axis]) / 2, bit = value[axis] >= mid;
    digit = digit * 2 + Number(bit);
    if (bit) low[axis] = mid; else high[axis] = mid;
    if (i % 5 === 4) { hash += alphabet[digit]; digit = 0; }
  }
  return hash;
}
export function geohashDecode(hash: string): Bounds & { latitude: number; longitude: number } {
  if (!hash.length || hash.length > 12 || [...hash].some(c => !alphabet.includes(c))) throw new Error("Invalid geohash");
  const low = [-180, -90], high = [180, 90];
  [...hash].forEach((char, index) => {
    const value = alphabet.indexOf(char);
    for (let bit = 4; bit >= 0; bit--) {
      const axis = (index * 5 + 4 - bit) % 2, mid = (low[axis] + high[axis]) / 2;
      if (value & (1 << bit)) low[axis] = mid; else high[axis] = mid;
    }
  });
  return { minX: low[0], maxX: high[0], minY: low[1], maxY: high[1], longitude: (low[0] + high[0]) / 2, latitude: (low[1] + high[1]) / 2 };
}
export function geohashNeighbours(hash: string): string[] {
  const b = geohashDecode(hash), result: string[] = [];
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
    if (!dx && !dy) continue;
    const lat = b.latitude + dy * (b.maxY - b.minY), lon = ((b.longitude + dx * (b.maxX - b.minX) + 540) % 360) - 180;
    if (lat > -90 && lat < 90) result.push(geohashEncode(lat, lon, hash.length));
  }
  return [...new Set(result)].filter(h => h !== hash).sort();
}
/** Candidate cells only: larger radii need a wider cell cover before exact distance filtering. */
export function geohashCandidates(points: Point[], center: Point, precision: number, neighbours = true): Point[] {
  const hash = geohashEncode(center.y, center.x, precision), cells = new Set([hash, ...(neighbours ? geohashNeighbours(hash) : [])]);
  return points.filter(p => cells.has(geohashEncode(p.y, p.x, precision)));
}
const inside = (p: Point, b: Bounds) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const cellDistance = (p: Point, b: Bounds) => Math.hypot(Math.max(b.minX - p.x, 0, p.x - b.maxX), Math.max(b.minY - p.y, 0, p.y - b.maxY));
const pointOrder = (center: Point) => (a: Point, b: Point) => distance(a, center) - distance(b, center) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function build(points: Point[], bounds: Bounds, capacity: number, depth = 0, id = "root"): Cell {
  const cell: Cell = { id, bounds: { ...bounds }, points, children: [] };
  if (points.length <= capacity || depth === 24 || points.every(p => p.x === points[0].x && p.y === points[0].y)) return cell;
  const midX = (bounds.minX + bounds.maxX) / 2, midY = (bounds.minY + bounds.maxY) / 2;
  cell.points = [];
  cell.children = Array.from({ length: 4 }, (_, q) => build(points.filter(p => Number(p.x >= midX) + 2 * Number(p.y >= midY) === q), { minX: q % 2 ? midX : bounds.minX, maxX: q % 2 ? bounds.maxX : midX, minY: q >= 2 ? midY : bounds.minY, maxY: q >= 2 ? bounds.maxY : midY }, capacity, depth + 1, `${id}.${q}`));
  return cell;
}
export interface SpatialQuery { points: Point[]; visited: { id: string; bounds: Bounds }[] }
function query(tree: Cell, center: Point, radius: number, k: number): SpatialQuery {
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || Number.isNaN(radius) || radius < 0 || !Number.isInteger(k) || k < 1) throw new Error("Invalid query");
  const queue = [tree], visited: SpatialQuery["visited"] = [];
  let points: Point[] = [];
  while (queue.length) {
    queue.sort((a, b) => cellDistance(center, a.bounds) - cellDistance(center, b.bounds));
    const cell = queue.shift()!, cutoff = points.length >= k ? Math.min(radius, distance(points[k - 1], center)) : radius;
    if (cellDistance(center, cell.bounds) > cutoff) break;
    visited.push({ id: cell.id, bounds: { ...cell.bounds } });
    if (cell.children.length) queue.push(...cell.children);
    else points = [...points, ...cell.points.filter(p => distance(p, center) <= radius)].sort(pointOrder(center)).slice(0, k);
  }
  return { points: points.map(p => ({ ...p })), visited };
}
/** Distances use planar x/y units, not great-circle kilometres. */
export function radiusQuery(tree: Cell, center: Point, radius: number): SpatialQuery {
  if (!Number.isFinite(radius)) throw new Error("Radius must be finite");
  return query(tree, center, radius, Number.MAX_SAFE_INTEGER);
}
export function nearestQuery(tree: Cell, center: Point, k: number): SpatialQuery { return query(tree, center, Infinity, k); }
export type SpatialAction = { type: "insert"; point: Point } | { type: "radius"; center: Point; radius: number } | { type: "nearest"; center: Point; k: number };
export interface SpatialState { seed: number; points: Point[]; tree: Cell; capacity: number; bounds: Bounds; result: SpatialQuery | null }
export interface SpatialOptions { capacity?: number; bounds?: Bounds; points?: Point[] }
export const spatialScenarios: Script<SpatialAction>[] = [
  { name: "geohash edge boundary", description: "Points at ±0.0001 longitude have different prefixes; neighbouring cells recover both. Radius uses planar degrees here.", actions: [{ type: "insert", point: { id: "west", x: -0.0001, y: 1 } }, { type: "insert", point: { id: "east", x: 0.0001, y: 1 } }, { type: "radius", center: { id: "query", x: -0.0001, y: 1 }, radius: 0.001 }] },
  { name: "capacity split and nearest cells", description: "The fifth point splits a capacity-four cell. Query traversal records visited cells.", actions: [...Array.from({ length: 5 }, (_, i): SpatialAction => ({ type: "insert", point: { id: `p${i}`, x: i * 10 - 20, y: i * 5 - 10 } })), { type: "nearest", center: { id: "query", x: 1, y: 1 }, k: 2 }] },
];
export function spatialInvariants(state: SpatialState): Violation[] {
  const leaves: Point[] = [], bad: string[] = [];
  function visit(cell: Cell) { if (cell.children.length) { if (cell.points.length || cell.children.length !== 4) bad.push(cell.id); cell.children.forEach(visit); } else { leaves.push(...cell.points); if (cell.points.some(p => !inside(p, cell.bounds))) bad.push(cell.id); } }
  visit(state.tree);
  const ids = (points: Point[]) => JSON.stringify(points.map(p => p.id).sort());
  return bad.length || leaves.length !== state.points.length || new Set(leaves.map(p => p.id)).size !== leaves.length || ids(leaves) !== ids(state.points) ? [{ code: "partition", message: "Every point must appear once in a containing leaf." }] : [];
}
export function createSpatialModel(options: SpatialOptions = {}): Model<SpatialState, SpatialAction> {
  const capacity = options.capacity ?? 4, bounds = { ...(options.bounds ?? { minX: -180, maxX: 180, minY: -90, maxY: 90 }) }, initial = structuredClone(options.points ?? []);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000 || !Object.values(bounds).every(Number.isFinite) || bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY) throw new Error("Invalid quadtree configuration");
  function validate(points: Point[]) { if (points.some(p => !p.id || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !inside(p, bounds)) || new Set(points.map(p => p.id)).size !== points.length) throw new Error("Use unique named points within bounds"); }
  validate(initial);
  return {
    init(seed) { random(seed); const points = structuredClone(initial); return { seed, points, capacity, bounds: { ...bounds }, tree: build(points, bounds, capacity), result: null }; },
    actions(s) {
      let id = `point-${s.points.length}`;
      while (s.points.some(p => p.id === id)) id += "-new";
      return [{ type: "nearest", center: { id: "query", x: 0, y: 0 }, k: 3 }, { type: "insert", point: { id, x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } }];
    },
    step(state, action) {
      const next = structuredClone(state);
      // shortcut: rebuild the teaching tree on insertion; use incremental insertion for large live datasets.
      if (action.type === "insert") { next.points.push({ ...action.point }); validate(next.points); next.tree = build(next.points, bounds, capacity); next.result = null; }
      else next.result = action.type === "radius" ? radiusQuery(next.tree, action.center, action.radius) : nearestQuery(next.tree, action.center, action.k);
      return next;
    }, invariants: spatialInvariants, scenarios: structuredClone(spatialScenarios),
  };
}
export interface SpatialVariant { id: string; seed: number; prompt: string; points: Point[]; action: Extract<SpatialAction, { type: "radius" | "nearest" }> }
export function generateSpatialVariant(seed: number): SpatialVariant {
  const next = random(seed); return { id: `spatial:${seed}`, seed, prompt: "Which point IDs does this quadtree query return, in distance order?", points: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, x: Math.floor(next() * 100) - 50, y: Math.floor(next() * 100) - 50 })), action: { type: "nearest", center: { id: "query", x: next() * 20, y: next() * 20 }, k: 1 + Math.floor(next() * 5) } };
}
export function solveSpatialVariant(v: SpatialVariant): string[] { const m = createSpatialModel({ points: v.points }); return m.step(m.init(v.seed), v.action).result!.points.map(p => p.id); }
