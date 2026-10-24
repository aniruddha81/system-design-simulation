"use client";

import { useEffect, useRef, useState, type CSSProperties, type SVGProps } from "react";
import { cacheAsideDesign } from "@/engine/fixtures";
import type { FromWorker, LiveSnapshot, ToWorker } from "@/engine/types";
import { N, ROUTES, VB, type Box, type RouteKey } from "./hero-geometry";
import { useMotionLevel } from "./motion";
import { landingScenario, outage } from "./scenario";

// Fig. 1, live. The real engine runs cacheAsideDesign in a worker at real time; sampled packets are
// drawn on a canvas over the pencil drawing. Visual only: nothing here feeds a result.
const SAMPLE = 0.02; // RunSettings.traceSampleRate: 2% of requests are drawn
const HOP_MS = 150; // each drawn hop; a request's hops play one after another
const RUN_US = 45_000_000;
const AUTO_ID = "auto-outage";
const AUTO_AT = 6_000_000;
const WINDOW_US = 1_000_000;
const SAMPLES = 32;

type CacheState = "up" | "down" | "refilling";
type Readout = { t: number; offered: number; served: number; failed: number; dbBusy: number; cache: CacheState; downFor: number | null; killing: boolean };
type Control = { setPlaying(play: boolean): void; kill(): void };
type Flight = { key: RouteKey; rev: boolean; t0: number; tone: 0 | 1 | 2 };

function Ink({ d, draw, ...props }: { d: string[]; draw?: number } & Omit<SVGProps<SVGGElement>, "d">) {
  const on = draw !== undefined;
  return (
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {d.map((p, i) => (
        <path key={i} d={p} pathLength={on ? 1 : undefined} className={on ? "draw-on" : undefined} style={on ? { animationDelay: `${draw}s` } : undefined} />
      ))}
    </g>
  );
}

const heatOf = (busy: number) => (busy < 0.5 ? 0 : busy < 0.7 ? 1 : busy < 0.85 ? 2 : busy < 0.95 ? 3 : 4);
const loadWord = (busy: number) => (busy < 0.85 ? "within capacity" : busy < 0.95 ? "near saturation" : "overloaded");
const int = (n: number) => Math.round(n).toLocaleString("en-US");

export function HeroSim({ strokes: s, engineVersion }: { strokes: Record<string, string[]>; engineVersion: string }) {
  const level = useMotionLevel();
  const figRef = useRef<HTMLElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dbRef = useRef<SVGGElement>(null);
  const pulseRef = useRef<SVGGElement>(null);
  const ctrl = useRef<Control | null>(null);
  const [userPaused, setUserPaused] = useState<boolean | null>(null);
  const [read, setRead] = useState<Readout | null>(null);
  const [broken, setBroken] = useState(false);
  const [announce, setAnnounce] = useState("");
  const paused = userPaused ?? level === "off";
  const pausedRef = useRef(paused);

  // Declared first so a new motion level sees the matching pause state.
  useEffect(() => {
    pausedRef.current = paused;
    ctrl.current?.setPlaying(!paused);
  }, [paused]);

  // The run: worker, packet feed, canvas. Rebuilt only when the motion level changes.
  useEffect(() => {
    if (!level) return;
    const fig = figRef.current!, svg = svgRef.current!, canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const moving = level === "full";

    // Route geometry, sampled once from the hidden route paths.
    const pts = new Map<RouteKey, Float32Array>();
    for (const el of svg.querySelectorAll<SVGPathElement>("[data-route]")) {
      const len = el.getTotalLength(), a = new Float32Array((SAMPLES + 1) * 2);
      for (let i = 0; i <= SAMPLES; i++) {
        const p = el.getPointAtLength((len * i) / SAMPLES);
        a[i * 2] = p.x;
        a[i * 2 + 1] = p.y;
      }
      pts.set(el.dataset.route as RouteKey, a);
    }
    const at = (key: RouteKey, t: number): [number, number] => {
      const a = pts.get(key)!, f = Math.min(SAMPLES, Math.max(0, t * SAMPLES)), i = Math.min(SAMPLES - 1, Math.floor(f)), u = f - i;
      return [a[i * 2] + (a[i * 2 + 2] - a[i * 2]) * u, a[i * 2 + 1] + (a[i * 2 + 3] - a[i * 2 + 1]) * u];
    };

    let colors = { ink: "", cache: "", db: "", bad: "", text: "", sheet: "", mono: "" };
    const readColors = () => {
      const c = getComputedStyle(canvas);
      const v = (n: string) => c.getPropertyValue(n).trim();
      colors = { ink: v("--ink-2"), cache: v("--accent-2"), db: v("--accent"), bad: v("--danger"), text: v("--text"), sheet: v("--surface"), mono: v("--font-mono") || "monospace" };
    };
    readColors();
    const themeObserver = new MutationObserver(() => {
      readColors();
      if (!moving) drawCounters();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let dpr = 1, scale = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      scale = canvas.clientWidth / VB.w;
      if (!moving) drawCounters();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let worker: Worker | null = null;
    let running = false, wantPlay = false, inView = false, pausedAt = 0;
    let seed = 11, kills = 0;
    let simNow = 0, lastSim = 0, lastWall = 0, prevFailed = 0, dropDebt = 0;
    let windows: { id: string; at: number; end: number }[] = [];
    let flights: Flight[] = [];
    let drops: { t0: number; x: number }[] = [];
    let crossings: { t: number; key: RouteKey }[] = [];
    let hist: { t: number; offered: number; ok: number; failed: number; db: number }[] = [];
    let cacheState: CacheState = "up";
    let raf = 0, lastPaint = 0;
    const lastHop = new Map<string, number>();

    const frame = (now: number) => {
      raf = 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      flights = flights.filter((f) => now < f.t0 + HOP_MS);
      for (const f of flights) {
        if (now < f.t0) continue;
        const t = (now - f.t0) / HOP_MS;
        ctx.fillStyle = f.tone === 1 ? colors.cache : f.tone === 2 ? colors.db : colors.ink;
        // A pencil smudge: the dot and two faint ghosts behind it.
        for (const [lag, alpha, r] of [[0.16, 0.14, 2.6], [0.08, 0.3, 2.9], [0, 1, 3.3]] as const) {
          const u = t - lag;
          if (u < 0) continue;
          const [x, y] = at(f.key, f.rev ? 1 - u : u);
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Failed requests: a red cross that falls away from the database.
      drops = drops.filter((d) => now < d.t0 + 900);
      ctx.strokeStyle = colors.bad;
      ctx.lineWidth = 1.7;
      ctx.lineCap = "round";
      for (const d of drops) {
        if (now < d.t0) continue;
        const u = (now - d.t0) / 900, x = N.db.x + 18 + d.x * 92, y = N.db.y + 104 + u * 26;
        ctx.globalAlpha = 1 - u;
        ctx.beginPath();
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (flights.length || drops.length) raf = requestAnimationFrame(frame);
    };

    // Reduced or Off: no travel. Each edge shows its call rate instead, refreshed four times a second.
    function drawCounters() {
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.clearRect(0, 0, canvas.width, canvas.height);
      if (!crossings.length) return;
      ctx!.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      ctx!.font = `500 11px ${colors.mono}`;
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      const counts = new Map<RouteKey, number>();
      for (const c of crossings) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
      for (const [key, n] of counts) {
        // Each call crosses its edge twice (request and reply).
        const label = `${int(n / SAMPLE / 2 / (WINDOW_US / 1e6))}/s`;
        const [x, y] = at(key, 0.5);
        const w = ctx!.measureText(label).width + 8;
        ctx!.fillStyle = colors.sheet;
        ctx!.fillRect(x - w / 2, y - 8, w, 16);
        ctx!.fillStyle = colors.text;
        ctx!.fillText(label, x, y + 0.5);
      }
    }

    const begin = () => {
      hist = [];
      crossings = [];
      flights = [];
      drops = [];
      lastHop.clear();
      lastSim = 0;
      prevFailed = 0;
      windows = [{ id: AUTO_ID, at: AUTO_AT, end: AUTO_AT + 3_000_000 }];
      const msg: ToWorker = {
        type: "start",
        design: cacheAsideDesign,
        scenario: landingScenario(RUN_US, [outage(AUTO_ID, AUTO_AT)]),
        seed,
        settings: { traceSampleRate: SAMPLE },
        speed: 1,
      };
      worker!.postMessage(msg);
      running = true;
    };

    const onSnapshot = (snap: LiveSnapshot) => {
      const now = performance.now();
      if (snap.simTimeUs < lastSim) lastSim = 0;
      const wallSpan = Math.min(250, now - lastWall), simSpan = Math.max(1, snap.simTimeUs - lastSim), simStart = lastSim;
      lastWall = now;
      lastSim = simNow = snap.simTimeUs;
      const m = snap.metrics;
      hist.push({ t: snap.simTimeUs, offered: m.offered, ok: m.succeeded, failed: m.failed, db: snap.nodeUtil.db ?? 0 });
      while (hist.length > 2 && hist[1].t < simNow - WINDOW_US) hist.shift();

      for (const p of snap.packets) {
        let key = `${p.from}>${p.to}` as RouteKey, rev = false;
        if (!(key in ROUTES)) {
          key = `${p.to}>${p.from}` as RouteKey;
          rev = true;
          if (!(key in ROUTES)) continue;
        }
        if (!moving) {
          crossings.push({ t: p.departUs, key });
          continue;
        }
        const offset = Math.max(0, ((p.departUs - simStart) / simSpan) * wallSpan);
        const t0 = Math.max(now + offset, lastHop.get(p.requestId) ?? 0);
        lastHop.set(p.requestId, t0 + HOP_MS);
        flights.push({ key, rev, t0, tone: key.endsWith("cache") ? 1 : key.endsWith("db") ? 2 : 0 });
      }
      if (lastHop.size > 3000) for (const [id, end] of lastHop) if (end < now - 1000) lastHop.delete(id);
      if (flights.length > 900) flights.splice(0, flights.length - 900);
      crossings = crossings.filter((c) => c.t >= simNow - WINDOW_US);

      // Real failures, drawn at the sampling rate.
      dropDebt += Math.max(0, m.failed - prevFailed) * SAMPLE;
      prevFailed = m.failed;
      if (moving) {
        for (; dropDebt >= 1; dropDebt--) drops.push({ t0: now + Math.random() * 220, x: Math.random() });
        if (!raf && (flights.length || drops.length)) raf = requestAnimationFrame(frame);
      } else dropDebt = 0;

      const st = snap.nodeState.cache;
      const recent = windows.some((w) => simNow >= w.end && simNow < w.end + 1_200_000);
      const next: CacheState = st === "up" ? (recent ? "refilling" : "up") : "down";
      if (next !== cacheState) {
        if (next === "down") setAnnounce("Cache node down. Every read falls through to the database.");
        if (cacheState === "down") setAnnounce("Cache node back, empty. Cache-aside refills it from the misses.");
        cacheState = next;
      }
      if (now - lastPaint > 250) {
        lastPaint = now;
        const a = hist[0], b = hist[hist.length - 1], dt = (b.t - a.t) / 1e6;
        const live = windows.find((w) => simNow < w.end);
        if (dt > 0.2)
          setRead({
            t: simNow,
            offered: (b.offered - a.offered) / dt,
            served: (b.ok - a.ok) / dt,
            failed: (b.failed - a.failed) / dt,
            // The engine reports busy time over the whole measured span; difference it into a 1 s window.
            dbBusy: Math.min(1, Math.max(0, ((b.db - a.db) * RUN_US) / (b.t - a.t))),
            cache: next,
            downFor: live && simNow >= live.at ? (live.end - simNow) / 1e6 : null,
            killing: !!live && simNow < live.at && live.id !== AUTO_ID,
          });
        if (!moving) drawCounters();
      }
    };

    const onMessage = (e: MessageEvent<FromWorker>) => {
      const d = e.data;
      if (d.type === "snapshot") onSnapshot(d.snapshot);
      else if (d.type === "done") {
        seed++;
        begin();
      } else if (d.type === "editRejected") windows = windows.filter((w) => w.id !== d.path || w.id === AUTO_ID);
      else if (d.type === "error" || d.type === "invalid") {
        console.warn("Live figure stopped", d);
        worker?.terminate();
        worker = null;
        running = false;
        setBroken(true);
      }
    };

    const sync = () => {
      const go = wantPlay && inView && !document.hidden;
      if (go && !worker) {
        try {
          worker = new Worker(new URL("../../engine/engine.worker.ts", import.meta.url), { type: "module" });
        } catch {
          setBroken(true);
          return;
        }
        worker.onmessage = onMessage;
        worker.onerror = () => {
          worker?.terminate();
          worker = null;
          setBroken(true);
        };
        lastWall = performance.now();
        begin();
      } else if (worker && go && !running) {
        const shift = performance.now() - pausedAt;
        for (const f of flights) f.t0 += shift;
        for (const d of drops) d.t0 += shift;
        for (const [id, end] of lastHop) lastHop.set(id, end + shift);
        lastWall = performance.now();
        worker.postMessage({ type: "resume" } satisfies ToWorker);
        running = true;
        if (moving && !raf && (flights.length || drops.length)) raf = requestAnimationFrame(frame);
      } else if (worker && !go && running) {
        worker.postMessage({ type: "pause" } satisfies ToWorker);
        running = false;
        pausedAt = performance.now();
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    // Lazy: nothing starts until the figure is on screen and the main thread is idle.
    const io = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      sync();
    });
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 300));
    const cancelIdle = window.cancelIdleCallback ?? window.clearTimeout;
    const idleId = idle(() => io.observe(fig));
    document.addEventListener("visibilitychange", sync);

    ctrl.current = {
      setPlaying(play) {
        wantPlay = play;
        sync();
      },
      kill() {
        if (!worker || windows.some((w) => simNow < w.end)) return;
        const auto = windows.find((w) => w.id === AUTO_ID);
        // Before the scheduled outage, move it to now; afterwards, add a new one.
        const id = auto && simNow < auto.at ? AUTO_ID : `kill-${++kills}`;
        const event = outage(id, Math.round(simNow) + 150_000);
        windows = [...windows.filter((w) => w.id !== id), { id, at: event.atUs, end: event.endUs! }];
        worker.postMessage({ type: "liveEdit", nodeId: "@chaos", path: id, value: event } satisfies ToWorker);
      },
    };
    ctrl.current.setPlaying(!pausedRef.current);

    return () => {
      ctrl.current = null;
      cancelIdle(idleId);
      io.disconnect();
      ro.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", sync);
      cancelAnimationFrame(raf);
      worker?.terminate();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [level]);

  const busy = read?.dbBusy ?? 0;
  const heat = heatOf(busy);
  const hot = !!read && (busy >= 0.95 || read.failed >= 1);
  const down = read?.cache === "down";

  // The break: the database shakes and pulses red while it is overloaded (Full motion only).
  useEffect(() => {
    if (!hot || level !== "full" || paused) return;
    const shake = dbRef.current?.animate([{ transform: "translateX(-1.6px)" }, { transform: "translateX(1.6px)" }], { duration: 110, iterations: Infinity, direction: "alternate" });
    const pulse = pulseRef.current?.animate(
      [
        { opacity: 0, transform: "scale(0.94)" },
        { opacity: 0.85, offset: 0.35 },
        { opacity: 0, transform: "scale(1.07)" },
      ],
      { duration: 1000, iterations: Infinity, easing: "ease-out" },
    );
    return () => {
      shake?.cancel();
      pulse?.cancel();
    };
  }, [hot, level, paused]);

  const goodput = read && read.served + read.failed > 0 ? read.served / (read.served + read.failed) : null;
  const status = broken ? "Static" : !read ? "Ready" : paused ? "Paused" : "Live";
  const note = { fontFamily: "var(--font-display)", fontStyle: "italic", fontVariationSettings: '"SOFT" 100, "WONK" 1' } satisfies CSSProperties;

  return (
    <figure ref={figRef} data-down={down} className="group relative">
      <div className="paper-grid relative overflow-hidden rounded-lg border border-border bg-surface shadow-e3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 pt-3 sm:px-4 sm:pt-4">
          <p className="flex min-h-9 items-center gap-2.5 text-sm text-muted">
            <span className={`stamp stamp-sm ${status === "Live" ? "text-accent" : "text-muted"}`}>{status}</span>
            <span className="font-mono text-xs">engine {engineVersion}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn h-9 min-h-9 px-3 text-sm" aria-pressed={paused} disabled={broken} onClick={() => setUserPaused(!paused)}>
              <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="currentColor">
                {paused ? <path d="M5 3.5v9l7-4.5z" /> : <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" />}
              </svg>
              {paused ? (read ? "Resume traffic" : "Run traffic") : "Pause traffic"}
            </button>
            <button
              type="button"
              className="btn h-9 min-h-9 px-3 text-sm"
              disabled={!read || broken || down || read.killing || read.downFor !== null}
              onClick={() => ctrl.current?.kill()}
            >
              <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
              </svg>
              {read?.downFor != null ? `Restarts in ${read.downFor.toFixed(1)} s` : read?.killing ? "Killing…" : "Kill the cache"}
            </button>
          </div>
        </div>

        <div className="relative">
          <svg ref={svgRef} viewBox={`0 0 ${VB.w} ${VB.h}`} role="img" aria-labelledby="fig1-title" className="block w-full" style={{ fontFamily: "var(--font-sans)" }}>
            <title id="fig1-title">
              A cache-aside system: clients reach a load balancer, two services read from a cache, and misses fall through to the database.
            </title>

            <g strokeWidth="1.4">
              <Ink d={s["client>lb"]} draw={0.5} className="text-ink-2" />
              <Ink d={s["lb>svc1"]} draw={0.7} className="text-ink-2" />
              <Ink d={s["lb>svc2"]} draw={0.75} className="text-ink-2" />
              <Ink d={s["svc1>cache"]} draw={0.95} className="text-accent-2 transition-opacity group-data-[down=true]:opacity-25" />
              <Ink d={s["svc2>cache"]} draw={1} className="text-accent-2 transition-opacity group-data-[down=true]:opacity-25" />
              <Ink d={s["svc1>db"]} draw={1.1} className="text-accent" strokeDasharray="5 5" />
              <Ink d={s["svc2>db"]} draw={1.15} className="text-accent" strokeDasharray="5 5" />
            </g>

            {/* Database load, shaded in a heat pencil from the live utilisation. */}
            <Ink d={s.hatch} strokeWidth="1" style={{ color: `var(--heat-${heat})`, opacity: 0.35 + busy * 0.55 }} />

            <g ref={pulseRef} style={{ transformBox: "fill-box", transformOrigin: "center", opacity: hot && level !== "full" ? 0.7 : 0 }}>
              <Ink d={s.pulse} strokeWidth="2.2" className="text-danger" />
            </g>

            <g strokeWidth="1.7">
              <Ink d={s.clientShadow} className="text-(--kind-client) opacity-50" />
              <rect x={N.client.x + 1} y={N.client.y + 1} width={N.client.w - 2} height={N.client.h - 2} className="fill-surface" />
              <Ink d={s.client} draw={0} className="text-(--kind-client)" />
              <Ink d={s.lb} draw={0.15} className="text-(--kind-loadBalancer)" />
              <Ink d={s.svc1} draw={0.3} className="text-(--kind-service)" />
              <Ink d={s.svc2} draw={0.35} className="text-(--kind-service)" />
              <Ink d={s.cache} draw={0.45} className="text-(--kind-cache) transition-opacity group-data-[down=true]:opacity-40" />
              <g ref={dbRef}>
                <Ink d={s.db} draw={0.55} className="text-(--kind-database)" />
              </g>
            </g>

            <Label box={N.client} title="Clients" sub={read ? `${int(read.offered)} req/s` : "1,500 req/s"} />
            <Label box={N.lb} title="LB" sub="round robin" />
            <Label box={N.svc1} title="svc-1" sub="cache-aside" />
            <Label box={N.svc2} title="svc-2" sub="cache-aside" />
            <Label
              box={N.cache}
              title="Cache"
              sub={read?.cache === "down" ? "unavailable" : read?.cache === "refilling" ? "restarted empty" : "LRU · 2 MB"}
              subClass={read?.cache === "down" ? "fill-danger font-medium" : read?.cache === "refilling" ? "fill-warning font-medium" : undefined}
            />
            <rect x={N.db.x + 8} y={N.db.y + 39} width={N.db.w - 16} height="58" rx="2" className="fill-surface" />
            <Label box={{ ...N.db, y: N.db.y + 30 }} title="Database" sub={read ? `${Math.round(busy * 100)}% busy` : "5 workers"} />
            {read && (
              <text x={N.db.x + 12} y={N.db.y + 92} className={`font-mono text-[11px] ${heat >= 3 ? "fill-danger font-medium" : "fill-muted"}`}>
                {loadWord(busy)}
              </text>
            )}

            <g className="hidden group-data-[down=true]:inline">
              <Ink d={s.cross} strokeWidth="2.6" className="text-accent" />
            </g>

            <g style={note} className="text-[15px]">
              <g className="group-data-[down=true]:hidden">
                <text x="250" y="24" className="fill-accent-2">
                  hot keys stay warm
                </text>
                <Ink d={s.warmArrow} strokeWidth="1.3" className="text-accent-2" />
              </g>
              <text x="244" y="24" className="hidden fill-accent group-data-[down=true]:inline">
                cache offline
              </text>
              <text x="236" y="358" className="fill-accent">
                misses fall through
              </text>
              <Ink d={s.missArrow} strokeWidth="1.3" className="text-accent" />
            </g>

            <g fill="none" stroke="none">
              {(Object.keys(ROUTES) as RouteKey[]).map((k) => (
                <path key={k} d={ROUTES[k]} data-route={k} />
              ))}
            </g>
          </svg>
          <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
        </div>

        <dl className="grid grid-cols-2 border-t border-border bg-surface sm:grid-cols-4">
          <Stat label="Sim clock" value={read ? `${(read.t / 1e6).toFixed(1)} s` : "—"} />
          <Stat label="Served" value={read ? `${int(read.served)}/s` : "—"} />
          <Stat label="Failed" value={read ? `${int(read.failed)}/s` : "—"} bad={!!read && read.failed >= 1} />
          <Stat label="Goodput" value={goodput === null ? "—" : `${(goodput * 100).toFixed(goodput > 0.999 ? 0 : 1)}%`} bad={goodput !== null && goodput < 0.99} />
        </dl>
      </div>
      <figcaption className="figcap mt-3 max-w-[60ch]">
        <b>Fig. 1</b>
        {broken
          ? "Cache-aside read path. The live run could not start in this browser, so this is the drawing alone."
          : "The real engine, running the cache-aside template in your browser at 1,500 requests a second. Six seconds in, the cache dies for three; dots are 2% of requests, teal to the cache, red to the database."}
      </figcaption>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </figure>
  );
}

function Label({ box, title, sub, subClass }: { box: Box; title: string; sub: string; subClass?: string }) {
  const x = box.x + 12;
  return (
    <>
      <text x={x} y={box.y + 26} className="fill-fg text-[16px] font-semibold">
        {title}
      </text>
      <text x={x} y={box.y + 45} className={`font-mono text-[12px] ${subClass ?? "fill-muted"}`}>
        {sub}
      </text>
    </>
  );
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="border-border px-3 py-2.5 odd:border-r sm:border-r sm:px-4 sm:last:border-r-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`num text-[1.0625rem] leading-tight ${bad ? "text-danger" : "text-fg"}`}>{value}</dd>
    </div>
  );
}
