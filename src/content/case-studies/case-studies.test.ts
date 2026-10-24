import fs from "node:fs";
import path from "node:path";
import { evaluate } from "@mdx-js/mdx";
import { createContext, createElement, use, type ReactNode } from "react";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { runToCompletion, validateDesign } from "@/engine";
import type { Design, RunResult, Scenario } from "@/engine/types";
import { parseLesson } from "@/lib/content/loader";
import { assessedObjectives, widgetSchemas, type WidgetName } from "@/lib/content/schema";
import { caseStudies, getCaseStudy, RUBRIC_STAGES, type Check } from "./index";

const run = (d: Design, s: Scenario) => runToCompletion(d, s, 1, { traceSampleRate: 0 });

function assertCheck(r: RunResult, c: Check, label: string) {
  const g = r.metrics.goodput ?? 0, p99 = (r.metrics.successLatency.p99 ?? 0) / 1000;
  const kinds = new Set(r.violations.map((v) => v.kind));
  if (c.minGoodput !== undefined) expect(g, `${label} goodput`).toBeGreaterThanOrEqual(c.minGoodput);
  if (c.maxGoodput !== undefined) expect(g, `${label} goodput`).toBeLessThanOrEqual(c.maxGoodput);
  if (c.minP99Ms !== undefined) expect(p99, `${label} p99 ms`).toBeGreaterThanOrEqual(c.minP99Ms);
  if (c.maxP99Ms !== undefined) expect(p99, `${label} p99 ms`).toBeLessThanOrEqual(c.maxP99Ms);
  if (c.clean) expect([...kinds], `${label} violations`).toEqual([]);
  for (const k of c.violations ?? []) expect([...kinds], `${label} violations`).toContain(k);
}

describe("case studies", () => {
  it("have unique ids and resolve by id", () => {
    expect(new Set(caseStudies.map((c) => c.id)).size).toBe(caseStudies.length);
    for (const c of caseStudies) expect(getCaseStudy(c.id)).toBe(c);
  });

  for (const c of caseStudies) {
    describe(c.id, () => {
      it("is complete", () => {
        expect(c.requirements.functional.length).toBeGreaterThan(0);
        expect(c.requirements.nonFunctional.length).toBeGreaterThan(0);
        for (const k of ["estimates", "api", "alternatives", "deepDives", "clarifyingQuestions", "commonMistakes"] as const) expect(c[k].length, k).toBeGreaterThan(0);
        expect(c.failureScenarios.length).toBeGreaterThanOrEqual(2);
        expect(c.rubric.map((r) => r.stage)).toEqual([...RUBRIC_STAGES]);
        for (const r of c.rubric) for (const d of r.descriptors) expect(d.length).toBeGreaterThan(2);
        const endpoints = new Set(c.design.endpoints.map((e) => e.id));
        for (const a of c.api) if (a.endpointId) expect(endpoints).toContain(a.endpointId);
        for (const e of c.dataModel.entities) expect(c.design.nodes.map((n) => n.id)).toContain(e.store);
      });

      it("runs the baseline and every failure scenario on the reference design", () => {
        const runs = [{ id: "baseline", scenario: c.scenario, check: { minGoodput: 0.99, clean: true } as Check }, ...c.failureScenarios];
        expect(new Set(runs.map((f) => f.id)).size).toBe(runs.length);
        for (const f of runs) {
          expect(validateDesign(c.design, f.scenario), f.id).toEqual([]);
          const total = f.scenario.warmupUs + f.scenario.measureUs + f.scenario.drainUs;
          expect(total, `${f.id} sim length`).toBeLessThanOrEqual(3_000_000);
          const r = run(c.design, f.scenario);
          expect(r.outcome, `${f.id}: ${r.inconclusiveReason}`).toBe("finished");
          if (f.check) assertCheck(r, f.check, `${c.id}/${f.id}`);
        }
      }, 20_000);

      it("runs every alternative design", () => {
        for (const a of c.alternatives) {
          if (!a.design) continue;
          const s = !a.check || a.check.scenario === "baseline" ? c.scenario : c.failureScenarios.find((f) => f.id === a.check!.scenario)?.scenario;
          expect(s, `${a.design.id} check scenario`).toBeDefined();
          expect(validateDesign(a.design, s!), a.design.id).toEqual([]);
          const r = run(a.design, s!);
          expect(r.outcome).toBe("finished");
          if (a.check) assertCheck(r, a.check, `${c.id}/${a.design.id}`);
        }
      }, 20_000);
    });
  }
});

// The narrative pages: valid lesson frontmatter, registered widgets, an interactive element
// per step and an assessment per objective (mirrors src/lib/content/content.test.ts).
const INTERACTIVE = new Set<WidgetName>(["Choice", "Ordering", "VariantQuestion", "HitRateCalculator", "MasteryCheck"]);
const DIR = path.join(process.cwd(), "content", "en", "case-studies");

async function widgets(source: string) {
  const usages: { name: WidgetName; step: string | null; props: Record<string, unknown> }[] = [];
  const StepCtx = createContext<string | null>(null);
  const components = Object.fromEntries((Object.keys(widgetSchemas) as WidgetName[]).map((name) => [name, function Recorder(props: Record<string, unknown> & { children?: ReactNode }) {
    const parsed = widgetSchemas[name].safeParse(props);
    if (!parsed.success) throw new Error(`<${name}> invalid props: ${parsed.error.message}`);
    usages.push({ name, step: use(StepCtx), props });
    return name === "Step" ? createElement(StepCtx.Provider, { value: props.id as string }, props.children) : null;
  }]));
  const { default: Content } = await evaluate(source, { ...runtime });
  renderToStaticMarkup(createElement(Content, { components }));
  return usages;
}

describe("case-study pages", () => {
  for (const c of caseStudies) {
    it(`${c.id}.mdx is a valid case-studies lesson`, async () => {
      const file = path.join(DIR, `${c.id}.mdx`);
      const lesson = parseLesson(file, fs.readFileSync(file, "utf8"));
      expect(lesson.track).toBe("case-studies");
      expect(lesson.slug).toBe(c.id);
      const usages = await widgets(lesson.source);
      for (const id of lesson.stepIds) expect(usages.some((u) => u.step === id && INTERACTIVE.has(u.name)), `step "${id}" needs an interactive element`).toBe(true);
      const assessed = new Set(usages.flatMap((u) => assessedObjectives(u.name, u.props)));
      for (const o of lesson.objectives) expect(assessed.has(o.id), `objective "${o.id}" has no assessment`).toBe(true);
      for (const o of assessed) expect(lesson.objectives.map((x) => x.id)).toContain(o);
    });
  }
});
