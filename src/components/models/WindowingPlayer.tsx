"use client";

import { useMemo, useState } from "react";
import { createWindowingModel, type WindowConfig, type WindowState } from "@/models";
import { FocusedPlayer, Diagram, ModelTable } from "./FocusedPlayer";
import { scale } from "./view-logic";

const time = (value: number) => Number.isFinite(value) ? String(value) : "not set";
const summary = (s: WindowState) => `${s.config.kind} windows, ${s.config.latePolicy} late policy. Watermark ${time(s.watermark)}. ${s.windows.length} windows, ${s.emissions.length} final emissions; ${s.dropped.length} dropped, ${s.sideOutput.length} side-output events, ${s.duplicates} duplicates.`;

export function WindowingPlayer({ seed = 1 }: { seed?: number }) {
  const [kind, setKind] = useState<WindowConfig["kind"]>("tumbling"), [policy, setPolicy] = useState<WindowConfig["latePolicy"]>("update");
  const model = useMemo(() => createWindowingModel({ kind, latePolicy: policy }), [kind, policy]);
  return <>
    <div className="flex flex-wrap gap-3 text-sm">
      <label>Window kind<select className="field ml-2" value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option>tumbling</option><option>sliding</option><option>session</option></select></label>
      <label>Late policy<select className="field ml-2" value={policy} onChange={e => setPolicy(e.target.value as typeof policy)}><option>update</option><option>drop</option><option>sideOutput</option></select></label>
    </div>
    <FocusedPlayer key={`${kind}-${policy}`} model={model} seed={seed} no="M12" title="Event time, watermarks, and late arrivals" summary={summary}>{p => {
      const s = p.state, actions = p.timeline.slice(0, p.cursor);
      const times = [...actions.flatMap(a => a.type === "event" ? [a.event.time] : [a.time]), ...s.windows.flatMap(w => [w.start, w.end]), ...p.states.slice(0, p.cursor + 1).map(s => s.watermark)].filter(Number.isFinite);
      const min = Math.min(0, ...times), max = Math.max(20, ...times);
      const x = (step: number) => scale(step, 0, Math.max(5, p.cursor), 65, 565), y = (t: number) => scale(t, min, max, 260, 35);
      return <>
        <p className="text-sm">Processing time is shown as action sequence; the model has no wall clock. Window size {s.config.size}, slide {s.config.slide}, session gap {s.config.gap}, disorder {s.config.outOfOrderness}, allowed lateness {s.config.allowedLateness}, in event-time units.</p>
        <Diagram label={`Event-time versus processing-time plot. ${summary(s)}`} height={320}>
          {s.windows.map(w => <rect key={w.id} x={65} y={y(w.end)} width={500} height={y(w.start) - y(w.end)} fill="var(--surface-2)" fillOpacity={0.35} stroke="var(--border)"><title>Window [{w.start}, {w.end}) {w.emittedAt === null ? "open" : "final"}</title></rect>)}
          <line x1={65} y1={260} x2={565} y2={260} stroke="var(--rule)" />
          {Number.isFinite(s.watermark) && <><line x1={65} x2={565} y1={y(s.watermark)} y2={y(s.watermark)} stroke="var(--accent)" strokeDasharray="5 3" /><text x={70} y={y(s.watermark) - 7} fill="currentColor" fontSize={12}>watermark {s.watermark}</text></>}
          <polyline points={p.states.slice(0, p.cursor + 1).flatMap((state, i) => Number.isFinite(state.watermark) ? [`${x(i)},${y(state.watermark)}`] : []).join(" ")} fill="none" stroke="var(--accent)" strokeWidth={2} />
          {actions.map((a, i) => a.type === "event" && <g key={i}><circle cx={x(i + 1)} cy={y(a.event.time)} r={5} fill="var(--kind-queue)" /><text x={x(i + 1) + 7} y={y(a.event.time) - 8} fill="currentColor" fontSize={12}>{a.event.id}</text></g>)}
          <text x={8} y={20} fill="currentColor" fontSize={12}>event time</text><text x={10} y={44} fill="currentColor" fontSize={12}>{max}</text><text x={15} y={260} fill="currentColor" fontSize={12}>{min}</text>
          <text x={65} y={285} fill="currentColor" fontSize={12}>0</text><text x={330} y={300} fill="currentColor" fontSize={12}>processing sequence → {Math.max(5, p.cursor)}</text>
        </Diagram>
        <ModelTable caption="Arrival order and watermark (text alternative)" headers={["Processing step", "Event / action", "Event time", "Watermark after"]} rows={actions.map((a, i) => [i + 1, a.type === "event" ? `${a.event.id}: value ${a.event.value}` : "advance watermark", a.type === "event" ? a.event.time : "—", time(p.states[i + 1].watermark)])} />
        <ModelTable caption="Windows and finalization" headers={["Interval [start, end)", "Key", "Count", "Total", "Status / emitted watermark"]} rows={s.windows.map(w => [`[${w.start}, ${w.end})`, w.key || "default", w.count, w.total, w.emittedAt === null ? "open" : `final / ${w.emittedAt}`])} />
        <ModelTable caption="Rejected late events" headers={["Event", "Time", "Destination"]} rows={[...s.dropped.map(e => [e.id, e.time, "dropped"]), ...s.sideOutput.map(e => [e.id, e.time, "side output"])]} />
      </>;
    }}</FocusedPlayer>
  </>;
}
