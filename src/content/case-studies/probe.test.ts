// TEMP exploration — deleted before hand-off.
import { it } from "vitest";
import { runToCompletion, validateDesign } from "@/engine";
import { caseStudies } from "./index";

it("probe", () => {
  const only = process.env.CASE;
  for (const c of caseStudies.filter((c) => !only || c.id === only)) {
    const runs: [string, typeof c.design, typeof c.scenario][] = [["baseline", c.design, c.scenario], ...c.failureScenarios.map((f) => [f.id, c.design, f.scenario] as [string, typeof c.design, typeof c.scenario])];
    for (const a of c.alternatives) if (a.design) runs.push([`ALT ${a.design.id} @ ${a.check?.scenario ?? "baseline"}`, a.design, a.check?.scenario && a.check.scenario !== "baseline" ? c.failureScenarios.find((f) => f.id === a.check!.scenario)!.scenario : c.scenario]);
    for (const [name, d, s] of runs) {
      const issues = validateDesign(d, s);
      if (issues.length) { console.log(c.id, name, "INVALID", issues); continue; }
      const t = Date.now();
      const r = runToCompletion(d, s, 1, { traceSampleRate: 0 });
      const m = r.metrics;
      const viol = [...new Set(r.violations.map((v) => v.kind))].join(",");
      const busy = r.nodes.filter((n) => n.utilisation > 0.05 || n.drops || n.cache || n.queue).map((n) => `${n.nodeId}:u${n.utilisation.toFixed(2)}${n.drops ? ` d${n.drops}` : ""}${n.cache ? ` hr${n.cache.hitRate?.toFixed(2)}` : ""}${n.queue ? ` q${n.queue.depthMax}/lag${n.queue.consumerLagMax}/dlq${n.queue.deadLettered}` : ""}${n.breaker ? ` open${n.breaker.opens}` : ""}`).join(" ");
      console.log(`${c.id} | ${name} | ${r.outcome} ${r.inconclusiveReason ?? ""} | off ${m.offered} gp ${m.goodput?.toFixed(3)} p50 ${((m.successLatency.p50 ?? 0) / 1000).toFixed(1)} p99 ${((m.successLatency.p99 ?? 0) / 1000).toFixed(1)}ms | ${JSON.stringify(m.statusCounts)} | viol ${viol} | $${m.costPerMonth.toFixed(0)} | ${busy} | ${Date.now() - t}ms`);
    }
  }
}, 600_000);
