"use client";
// Canvas 2D packet overlay (PLAN §12): one rAF loop fed by LiveSnapshot.packets. Visual only.
import { useStoreApi } from "@xyflow/react";
import { useEffect, useRef } from "react";
import type { Packet } from "@/engine/types";
import { subscribePackets } from "@/lib/run-manager";
import { NODE_H, NODE_W } from "./board-elements";

type Flight = { from: string; to: string; t0: number; dur: number; ok: boolean };

const MAX_FLIGHTS = 600;
const SLOW_FRAME_MS = 18; // > one 60 Hz frame (16.7 ms) plus scheduling slack
const SAMPLE_RATE = 0.05; // RunSettings.traceSampleRate used by the run manager

function keep(id: string, density: number) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000 < density;
}

export function PacketOverlay({ runKey, reducedMotion }: { runKey: string; reducedMotion: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rf = useStoreApi();

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const css = getComputedStyle(canvas);
    const okColor = css.getPropertyValue("--accent").trim() || "#7c9cff";
    const badColor = css.getPropertyValue("--danger").trim() || "#ff5c5c";
    const textColor = css.getPropertyValue("--text").trim() || "#ddd";
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const anchor = (id: string, side: "out" | "in") => {
      const { nodeLookup, transform } = rf.getState();
      const n = nodeLookup.get(id);
      if (!n) return null;
      const p = n.internals.positionAbsolute;
      const x = p.x + (side === "out" ? (n.measured.width ?? NODE_W) : 0);
      const y = p.y + (n.measured.height ?? NODE_H) / 2;
      return { x: x * transform[2] + transform[0], y: y * transform[2] + transform[1] };
    };

    let flights: Flight[] = [];
    let density = 1;
    let slowFrames = 0;
    let lastFrame = 0;
    let raf = 0;
    let lastMsg = performance.now();
    let lastSim = 0;
    const counts = new Map<string, number>();

    const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawCounters = () => {
      clear();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = "600 11px ui-monospace, monospace";
      ctx.fillStyle = textColor;
      ctx.textAlign = "center";
      for (const [k, perSec] of counts) {
        const [from, to] = k.split(">");
        const a = anchor(from, "out"), b = anchor(to, "in");
        if (a && b) ctx.fillText(`≈${Math.round(perSec)} req/s`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 6);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };

    const frame = (now: number) => {
      raf = 0;
      if (lastFrame) {
        slowFrames = now - lastFrame > SLOW_FRAME_MS ? slowFrames + 1 : 0;
        if (slowFrames >= 30) {
          density = Math.max(1 / 16, density / 2);
          slowFrames = 0;
        }
      }
      lastFrame = now;
      clear();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const zoom = rf.getState().transform[2];
      const r = Math.max(2, 3 * zoom);
      flights = flights.filter((f) => now < f.t0 + f.dur);
      for (const f of flights) {
        if (now < f.t0) continue;
        // Requests travel along the edge (out port → in port); responses travel back along it.
        const forward = rf.getState().edges.some((e) => e.source === f.from && e.target === f.to);
        const a = anchor(f.from, forward ? "out" : "in"), b = anchor(f.to, forward ? "in" : "out");
        if (!a || !b) continue;
        const t = (now - f.t0) / f.dur;
        ctx.fillStyle = f.ok ? okColor : badColor;
        ctx.beginPath();
        ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (flights.length) raf = requestAnimationFrame(frame);
      else lastFrame = 0;
    };

    const unsub = subscribePackets(runKey, (packets: Packet[], snap) => {
      const now = performance.now();
      const wallSpan = Math.min(250, now - lastMsg);
      const simSpan = Math.max(1, snap.simTimeUs - lastSim);
      const simStart = lastSim;
      lastMsg = now;
      lastSim = snap.simTimeUs;
      if (reducedMotion) {
        // Counters instead of moving packets: estimated req/s per edge, smoothed.
        const fresh = new Map<string, number>();
        for (const p of packets) fresh.set(`${p.from}>${p.to}`, (fresh.get(`${p.from}>${p.to}`) ?? 0) + 1);
        for (const k of new Set([...counts.keys(), ...fresh.keys()])) {
          const rate = ((fresh.get(k) ?? 0) / SAMPLE_RATE) / (simSpan / 1e6);
          counts.set(k, 0.8 * (counts.get(k) ?? rate) + 0.2 * rate);
        }
        drawCounters();
        return;
      }
      for (const p of packets) {
        if (flights.length >= MAX_FLIGHTS || !keep(p.requestId, density)) continue;
        const offset = ((p.departUs - simStart) / simSpan) * wallSpan;
        const dur = Math.min(900, Math.max(160, ((p.arriveUs - p.departUs) / simSpan) * wallSpan));
        flights.push({ from: p.from, to: p.to, t0: now + Math.max(0, offset), dur, ok: p.ok });
      }
      if (!raf && flights.length) raf = requestAnimationFrame(frame);
    });

    // Effect cleanup = route hidden (Activity) or unmount: stop the loop and the feed.
    return () => {
      unsub();
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [runKey, reducedMotion, rf]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-[5] h-full w-full" aria-hidden="true" />;
}
