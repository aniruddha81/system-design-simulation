import { ENGINE_VERSION } from "@/engine";
import { arrowHead, sketch } from "@/components/ui/sketch";
import { CYL, CYL_LIP, END, N, ROUTES, type Box, type RouteKey } from "./hero-geometry";
import { HeroSim } from "./hero-sim";

/** Fig. 1: every pencil stroke is computed here, on the server, with fixed seeds; the client only adds live state. */
export function HeroFigure() {
  const box = (b: Box, seed: number) => sketch.rect(b.x, b.y, b.w, b.h, seed);
  const edge = (k: RouteKey, seed: number) => [...sketch.path(ROUTES[k], seed, { roughness: 0.8 }), ...arrowHead(...END[k], seed + 1)];
  const c = N.cache;
  const strokes = {
    "client>lb": edge("client>lb", 11),
    "lb>svc1": edge("lb>svc1", 12),
    "lb>svc2": edge("lb>svc2", 13),
    "svc1>cache": edge("svc1>cache", 14),
    "svc2>cache": edge("svc2>cache", 15),
    "svc1>db": edge("svc1>db", 16),
    "svc2>db": edge("svc2>db", 17),
    hatch: sketch.hatch(CYL, 42, { hachureGap: 4.5 }),
    clientShadow: sketch.rect(N.client.x + 5, N.client.y - 5, N.client.w, N.client.h, 3),
    client: box(N.client, 4),
    lb: box(N.lb, 5),
    svc1: box(N.svc1, 6),
    svc2: box(N.svc2, 7),
    cache: box(N.cache, 8),
    db: [...sketch.path(CYL, 9), ...sketch.path(CYL_LIP, 10)],
    cross: [...sketch.line(c.x - 6, c.y - 6, c.x + c.w + 6, c.y + c.h + 6, 21), ...sketch.line(c.x + c.w + 6, c.y - 6, c.x - 6, c.y + c.h + 6, 22)],
    pulse: sketch.ellipse(N.db.x + 64, N.db.y + 50, 176, 136, 23, { roughness: 1.6 }),
    warmArrow: [...sketch.path("M378 30 C394 34 402 40 412 46", 31, { roughness: 0.6 }), ...arrowHead(402, 40, 412, 46, 32, 7)],
    missArrow: [...sketch.path("M372 350 C392 348 404 340 414 330", 33, { roughness: 0.6 }), ...arrowHead(405, 340, 414, 330, 34, 7)],
  };
  return <HeroSim strokes={strokes} engineVersion={ENGINE_VERSION} />;
}
