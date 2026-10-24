"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useMotionLevel } from "./motion";

type LayoutCache = {
  cold: SVGCircleElement | null;
  warm: SVGCircleElement | null;
  cx: number;
  cy: number;
  segs: Map<number, { path: SVGPathElement; len: number }>;
};

export function JourneyScroller({ stage, children }: { stage: ReactNode; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const level = useMotionLevel();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !level) return;

    const fromEls = Array.from(root.querySelectorAll<SVGElement>("[data-from]"));
    const onlyEls = Array.from(root.querySelectorAll<SVGElement>("[data-only]"));
    const focusEls = Array.from(root.querySelectorAll<SVGElement>("[data-focus]"));
    const stepEls = Array.from(root.querySelectorAll<HTMLElement>("[data-step]"));
    const inkEls = Array.from(root.querySelectorAll<HTMLElement>("[data-step-ink]"));

    const layouts: LayoutCache[] = Array.from(root.querySelectorAll<SVGSVGElement>("svg[data-layout]")).map((svg) => {
      const cold = svg.querySelector<SVGCircleElement>('[data-packet="cold"]');
      const warm = svg.querySelector<SVGCircleElement>('[data-packet="warm"]');
      const cx = Number(cold?.getAttribute("cx") ?? 0);
      const cy = Number(cold?.getAttribute("cy") ?? 0);
      const segs = new Map<number, { path: SVGPathElement; len: number }>();
      for (const path of svg.querySelectorAll<SVGPathElement>("path[data-seg]")) {
        const b = Number(path.dataset.seg);
        segs.set(b, { path, len: path.getTotalLength() });
      }
      return { cold, warm, cx, cy, segs };
    });

    if (level === "off") {
      for (const l of layouts) {
        if (l.cold) l.cold.style.opacity = "0";
        if (l.warm) l.warm.style.opacity = "0";
      }
      for (const ink of inkEls) ink.style.transform = "scaleY(1)";
      return;
    }

    let cancelled = false;
    let resizeTimer = 0;
    let revertCtx = () => {};
    let onResize = () => {};

    void Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([{ default: gsap }, { ScrollTrigger }]) => {
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);

      const ctx = gsap.context(() => {
        const hidePackets = () => {
          for (const l of layouts) {
            if (l.cold) gsap.set(l.cold, { opacity: 0, x: 0, y: 0 });
            if (l.warm) gsap.set(l.warm, { opacity: 0, x: 0, y: 0 });
          }
        };

        let activeBeat = -1;
        const applyBeat = (beat: number, fade: boolean) => {
          if (beat === activeBeat) return;
          activeBeat = beat;
          const setOrTo = (el: Element, opacity: number) => {
            if (fade) gsap.to(el, { opacity, duration: 0.2, overwrite: "auto" });
            else gsap.set(el, { opacity });
          };
          for (const el of fromEls) {
            setOrTo(el, Number(el.dataset.from) <= beat ? 1 : 0);
          }
          for (const el of onlyEls) {
            setOrTo(el, Number(el.dataset.only) === beat ? 1 : 0);
          }
          for (const el of focusEls) {
            const beats = (el.dataset.focus ?? "").split(" ");
            setOrTo(el, beats.includes(String(beat)) ? 1 : 0);
          }
        };

        const placePacket = (beat: number, progress: number) => {
          const clamped = Math.min(1, Math.max(0, progress));
          for (const l of layouts) {
            if (beat === 0) {
              if (l.cold) gsap.set(l.cold, { x: 0, y: 0, opacity: 1 });
              if (l.warm) gsap.set(l.warm, { x: 0, y: 0, opacity: 0 });
              continue;
            }
            const seg = l.segs.get(beat);
            if (!seg) continue;
            const pt = seg.path.getPointAtLength(seg.len * clamped);
            const dx = pt.x - l.cx;
            const dy = pt.y - l.cy;
            if (beat === 7) {
              if (l.cold) gsap.set(l.cold, { opacity: 0 });
              if (l.warm) gsap.set(l.warm, { x: dx, y: dy, opacity: 1 });
            } else {
              if (l.warm) gsap.set(l.warm, { opacity: 0 });
              if (l.cold) gsap.set(l.cold, { x: dx, y: dy, opacity: 1 });
            }
          }
        };

        applyBeat(0, false);

        if (level === "reduced") {
          hidePackets();
          stepEls.forEach((stepEl, i) => {
            const ink = stepEl.querySelector<HTMLElement>("[data-step-ink]");
            if (ink) gsap.set(ink, { scaleY: i === 0 ? 1 : 0 });
            ScrollTrigger.create({
              trigger: stepEl,
              start: "top 62%",
              end: "bottom 38%",
              onEnter: () => {
                applyBeat(i, true);
                if (ink) gsap.to(ink, { scaleY: 1, duration: 0.2, overwrite: "auto" });
              },
              onEnterBack: () => {
                applyBeat(i, true);
                if (ink) gsap.to(ink, { scaleY: 1, duration: 0.2, overwrite: "auto" });
              },
            });
          });
        } else {
          placePacket(0, 0);
          stepEls.forEach((stepEl, i) => {
            const ink = stepEl.querySelector<HTMLElement>("[data-step-ink]");
            if (ink) {
              gsap.fromTo(
                ink,
                { scaleY: 0 },
                {
                  scaleY: 1,
                  ease: "none",
                  scrollTrigger: {
                    trigger: stepEl,
                    start: "top 68%",
                    end: "bottom 42%",
                    scrub: true,
                  },
                },
              );
            }
            ScrollTrigger.create({
              trigger: stepEl,
              start: "top 68%",
              end: "bottom 42%",
              scrub: true,
              onEnter: () => applyBeat(i, false),
              onEnterBack: () => applyBeat(i, false),
              onUpdate: (self) => {
                applyBeat(i, false);
                placePacket(i, self.progress);
              },
            });
          });
        }
      }, root);

      revertCtx = () => ctx.revert();
      onResize = () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => ScrollTrigger.refresh(), 150);
      };
      window.addEventListener("resize", onResize, { passive: true });
      document.fonts?.ready.then(() => {
        if (!cancelled) ScrollTrigger.refresh();
      });
    });

    return () => {
      cancelled = true;
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      revertCtx();
    };
  }, [level]);

  return (
    <div ref={rootRef} className="grid grid-cols-1 items-start gap-8 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-12">
      <div className="min-w-0 md:sticky md:top-20">{stage}</div>
      <ol className="m-0 min-w-0 list-none p-0">{children}</ol>
    </div>
  );
}
