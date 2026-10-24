import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LessonStepper, Step } from "@/components/lesson/stepper";
import { assessedObjectives, widgetSchemas } from "@/lib/content/schema";
import { generateHashRingVariant, generateIsolationVariant } from "@/models";
import { HashRingPlayer, IsolationPlayer, ModelQuestion } from "./index";
import * as players from "./index";
import { focusedModelNames, focusedQuestion } from "./question-data";

const inLesson = (widget: ReturnType<typeof createElement>) => renderToStaticMarkup(
  createElement(LessonStepper, { lessonId: "test", revision: 1, stepIds: ["model"], stepTitles: ["Model"] } as ComponentProps<typeof LessonStepper>, createElement(Step, { id: "model", title: "Model" }, widget)),
);

describe("model lesson widgets", () => {
  it("registers every focused player with keyboard controls and text alternatives", () => {
    for (const [name, Component] of Object.entries(players)) {
      if (name === "ModelQuestion") continue;
      const schema = widgetSchemas[name as keyof typeof widgetSchemas];
      expect(schema.safeParse({ seed: 7 }).success).toBe(true);
      expect(schema.safeParse({ seed: 1.5 }).success).toBe(false);
      const html = inLesson(createElement(Component as typeof HashRingPlayer, { seed: 7 }));
      expect(html).toContain('aria-label="Step forward"');
      expect(html).toContain('type="range"');
      expect(html).toContain(name === "IsolationPlayer" ? 'aria-label="Anomalies observed under' : 'aria-label="Invariants"');
    }
  });

  it.each(focusedModelNames)("registers and renders the %s seeded question", model => {
    const props = { id: "question", objective: "model", model, seed: 17 };
    expect(widgetSchemas.ModelQuestion.safeParse(props).success).toBe(true);
    expect(assessedObjectives("ModelQuestion", props)).toEqual(["model"]);
    const html = inLesson(createElement(ModelQuestion, props));
    expect(html).toContain(focusedQuestion(model, 17).prompt.replace(/'/g, "&#x27;"));
    expect(html).toContain('aria-label="Question schedule"');
    expect(html).toContain("Check");
  });
  it("registers validated props and counts model questions toward lesson objectives", () => {
    expect(widgetSchemas.HashRingPlayer.safeParse({ seed: 1 }).success).toBe(true);
    expect(widgetSchemas.IsolationPlayer.safeParse({ level: "serializable", anomaly: "writeSkew" }).success).toBe(true);
    expect(widgetSchemas.IsolationPlayer.safeParse({ level: "readUncommitted" }).success).toBe(false);
    expect(widgetSchemas.ModelQuestion.safeParse({ id: "ring", objective: "movement", model: "hashRing", seed: 1.5 }).success).toBe(false);
    const props = widgetSchemas.ModelQuestion.parse({ id: "ring", objective: "movement", model: "hashRing", seed: 1 });
    expect(assessedObjectives("ModelQuestion", props)).toEqual(["movement"]);
  });

  it("renders both players in a lesson with keyboard playback and invariant displays", () => {
    const ring = inLesson(createElement(HashRingPlayer, { seed: 7 }));
    expect(ring).toContain("Hash ring diagram");
    expect(ring).toContain('aria-label="Step forward"');
    expect(ring).toContain('aria-label="Invariants"');
    const isolation = inLesson(createElement(IsolationPlayer, { level: "snapshot", anomaly: "writeSkew" }));
    expect(isolation).toContain("Anomalies observed under Snapshot");
    expect(isolation).toContain("Run the next operation of");
    expect(isolation).toContain('type="range"');
  });

  it.each([1, 17, 1234])("uses the model-generated question for seed %s", (seed) => {
    const props = { id: "question", objective: "model", seed };
    expect(inLesson(createElement(ModelQuestion, { ...props, model: "hashRing" }))).toContain(generateHashRingVariant(seed).prompt);
    expect(inLesson(createElement(ModelQuestion, { ...props, model: "isolation" }))).toContain(generateIsolationVariant(seed).prompt);
  });
});
