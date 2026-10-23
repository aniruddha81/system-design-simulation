// CI content checks (PLAN §9): schema, prerequisites, DAG cycles, widget registry,
// objective coverage, freshness of review, matrix completeness, solver-checked variants.
import { evaluate } from "@mdx-js/mdx";
import { createContext, createElement, use, type ReactNode } from "react";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildDag } from "./curriculum";
import { loadCurriculum, loadLessons, matrix } from "./loader";
import { assessedObjectives, widgetSchemas, type WidgetName } from "./schema";
import { diagnose, generate, isCorrect, templates } from "./variants";

const INTERACTIVE = new Set<WidgetName>(["Choice", "Ordering", "VariantQuestion", "HitRateCalculator", "MasteryCheck"]);

type Usage = { name: WidgetName; step: string | null; props: Record<string, unknown> };

async function collectWidgets(source: string): Promise<Usage[]> {
  const usages: Usage[] = [];
  const StepCtx = createContext<string | null>(null);
  const components = Object.fromEntries(
    (Object.keys(widgetSchemas) as WidgetName[]).map((name) => [
      name,
      function Recorder(props: Record<string, unknown> & { children?: ReactNode }) {
        const step = use(StepCtx);
        const result = widgetSchemas[name].safeParse(props);
        if (!result.success) throw new Error(`<${name}> invalid props: ${result.error.message}`);
        usages.push({ name, step, props });
        return name === "Step" ? createElement(StepCtx.Provider, { value: props.id as string }, props.children) : null;
      },
    ]),
  );
  const { default: Content } = await evaluate(source, { ...runtime });
  // Throws "Expected component X to be defined" for widgets missing from the registry.
  renderToStaticMarkup(createElement(Content, { components }));
  return usages;
}

describe("content", () => {
  const lessons = loadLessons();

  it("has valid lessons and a valid prerequisite DAG", () => {
    expect(lessons.length).toBeGreaterThan(0);
    expect(() => loadCurriculum()).not.toThrow();
  });

  it("references only matrix lessons, live or planned", () => {
    const ids = new Set(matrix.lessons.map((l) => l.id));
    for (const row of matrix.rows) expect(ids, `matrix row "${row.concept}"`).toContain(row.lesson);
  });

  it("was reviewed in the last 12 months", () => {
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    for (const l of lessons) expect(new Date(l.lastReviewed) > yearAgo, `${l.id} lastReviewed`).toBe(true);
  });

  for (const lesson of lessons) {
    it(`${lesson.id}: widgets are registered, valid, interactive per step and cover every objective`, async () => {
      const usages = await collectWidgets(lesson.source);
      const steps = usages.filter((u) => u.name === "Step").map((u) => u.props.id);
      expect(steps).toEqual(lesson.stepIds);

      for (const id of lesson.stepIds) {
        expect(usages.some((u) => u.step === id && INTERACTIVE.has(u.name)), `step "${id}" needs an interactive element`).toBe(true);
      }

      const objectiveIds = lesson.objectives.map((o) => o.id);
      const assessed = new Set(usages.flatMap((u) => assessedObjectives(u.name, u.props)));
      for (const o of assessed) expect(objectiveIds, "widget assesses an unknown objective").toContain(o);
      for (const o of objectiveIds) expect(assessed.has(o), `objective "${o}" has no assessment`).toBe(true);

      for (const u of usages.filter((u) => u.name === "VariantQuestion" || u.name === "MasteryCheck")) {
        const ids = u.name === "VariantQuestion" ? [u.props.template as string] : (u.props.templates as string[]);
        for (const t of ids) expect(lesson.stepIds, `template ${t} remediation step`).toContain(templates[t].step);
      }
    });
  }
});

describe("variants", () => {
  for (const t of Object.values(templates)) {
    it(`${t.id}: solver-checked variants with distinct distractors`, () => {
      for (let seed = 1; seed <= 300; seed++) {
        const v = generate(t, seed);
        expect(v).toEqual(generate(t, seed)); // deterministic per seed
        expect(isCorrect(t, v, v.answer)).toBe(true);
        for (const m of t.mistakes?.(v.params) ?? []) {
          expect(isCorrect(t, v, m.value), `${t.id} seed ${seed}: mistake equals answer`).toBe(false);
          expect(diagnose(t, v, m.value)).toBe(m.feedback);
        }
      }
    });
  }
});

describe("buildDag", () => {
  it("rejects missing prerequisites and cycles", () => {
    expect(() => buildDag([{ id: "a", requires: ["x"] }])).toThrow(/unknown lesson "x"/);
    expect(() =>
      buildDag([
        { id: "a", requires: ["b"] },
        { id: "b", requires: ["a"] },
      ]),
    ).toThrow(/cycle/);
    const { depth } = buildDag([
      { id: "a", requires: [] },
      { id: "b", requires: ["a"] },
      { id: "c", requires: ["a", "b"] },
    ]);
    expect(depth.get("c")).toBe(2);
  });
});
