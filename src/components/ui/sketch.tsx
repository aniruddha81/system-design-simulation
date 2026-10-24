import rough from "roughjs";
import type { Options } from "roughjs/bin/core";
import type { SVGProps } from "react";

// Hand-drawn strokes, computed once on the server with fixed seeds (no client JS, no
// hydration drift). The sandbox board draws its components the same way.
const gen = rough.generator();
const base: Options = { roughness: 1.1, bowing: 1.2, strokeWidth: 1.5, disableMultiStroke: false };

const paths = (d: ReturnType<typeof gen.path>) => gen.toPaths(d).map((p) => p.d);

export const sketch = {
  rect: (x: number, y: number, w: number, h: number, seed: number, o: Options = {}) => paths(gen.rectangle(x, y, w, h, { ...base, seed, ...o })),
  line: (x1: number, y1: number, x2: number, y2: number, seed: number, o: Options = {}) => paths(gen.line(x1, y1, x2, y2, { ...base, seed, ...o })),
  path: (d: string, seed: number, o: Options = {}) => paths(gen.path(d, { ...base, seed, ...o })),
  ellipse: (cx: number, cy: number, w: number, h: number, seed: number, o: Options = {}) => paths(gen.ellipse(cx, cy, w, h, { ...base, seed, ...o })),
  /** Hachure fill strokes for a closed shape (drawn as lines, like pencil shading). */
  hatch: (d: string, seed: number, o: Options = {}) =>
    paths(gen.path(d, { ...base, seed, stroke: "none", fill: "x", fillStyle: "hachure", hachureGap: 6, hachureAngle: -41, fillWeight: 0.8, ...o })),
};

/** An arrowhead for a line ending at (x, y) coming from (fx, fy). */
export function arrowHead(fx: number, fy: number, x: number, y: number, seed: number, size = 9): string[] {
  const a = Math.atan2(y - fy, x - fx);
  const p = (da: number) => [x - size * Math.cos(a + da), y - size * Math.sin(a + da)] as const;
  const [ax, ay] = p(0.45);
  const [bx, by] = p(-0.45);
  return sketch.path(`M${ax} ${ay} L${x} ${y} L${bx} ${by}`, seed, { roughness: 0.6, bowing: 0.4 });
}

/** Renders sketch paths as unfilled strokes in the current colour. */
export function Strokes({ d, draw, ...props }: { d: string[]; /** Draw on after this many seconds. */ draw?: number } & Omit<SVGProps<SVGGElement>, "d">) {
  const on = draw !== undefined;
  return (
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {d.map((p, i) => (
        <path key={i} d={p} pathLength={on ? 1 : undefined} className={on ? "draw-on" : undefined} style={on ? { animationDelay: `${draw}s` } : undefined} />
      ))}
    </g>
  );
}
