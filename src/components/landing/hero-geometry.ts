// Fig. 1 geometry, shared by the server (rough strokes) and the client (live packets).
// Node keys are the engine's node ids in cacheAsideDesign, so packets map straight onto edges.
export type Box = { x: number; y: number; w: number; h: number };

export const VB = { w: 560, h: 372 } as const;

export const N = {
  client: { x: 10, y: 150, w: 94, h: 62 },
  lb: { x: 138, y: 150, w: 94, h: 62 },
  svc1: { x: 270, y: 54, w: 102, h: 60 },
  svc2: { x: 270, y: 250, w: 102, h: 60 },
  cache: { x: 420, y: 30, w: 128, h: 64 },
  db: { x: 420, y: 234, w: 128, h: 100 },
} satisfies Record<string, Box>;

/** One drawn path per design edge, keyed "from>to" as the engine emits packets. */
export const ROUTES = {
  "client>lb": "M106 181 L136 181",
  "lb>svc1": "M234 172 C254 172 248 84 268 84",
  "lb>svc2": "M234 190 C254 190 248 280 268 280",
  "svc1>cache": "M374 76 C396 76 398 60 418 60",
  "svc2>cache": "M374 266 C404 260 392 82 418 76",
  "svc1>db": "M374 94 C402 102 392 262 418 266",
  "svc2>db": "M374 290 C394 290 398 292 418 292",
} as const;
export type RouteKey = keyof typeof ROUTES;

/** Arrowhead [fromX, fromY, x, y] at the end of each route. */
export const END: Record<RouteKey, [number, number, number, number]> = {
  "client>lb": [126, 181, 136, 181],
  "lb>svc1": [256, 84, 268, 84],
  "lb>svc2": [256, 280, 268, 280],
  "svc1>cache": [406, 61, 418, 60],
  "svc2>cache": [406, 77, 418, 76],
  "svc1>db": [408, 265, 418, 266],
  "svc2>db": [408, 292, 418, 292],
};

export const CYL = `M${N.db.x} 248 A64 14 0 0 1 ${N.db.x + 128} 248 L${N.db.x + 128} 320 A64 14 0 0 1 ${N.db.x} 320 Z`;
export const CYL_LIP = `M${N.db.x} 248 A64 14 0 0 0 ${N.db.x + 128} 248`;
