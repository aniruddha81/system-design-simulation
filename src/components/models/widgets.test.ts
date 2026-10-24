import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LessonStepper, Step } from "@/components/lesson/stepper";
import { assessedObjectives, widgetSchemas } from "@/lib/content/schema";
import { generateHashRingVariant, generateIsolationVariant } from "@/models";
import { HashRingPlayer, IsolationPlayer, ModelQuestion } from "./index";

const inLesson = (widget: ReturnType<typeof createElement>) => renderToStaticMarkup(
  createElement(LessonStepper, { lessonId: "test", revision: 1, stepIds: ["model"], stepTitles: ["Model"] } as ComponentProps<typeof LessonStepper>, createElement(Step, { id: "model", title: "Model" }, widget)),
);

describe("model lesson widgets", () => {
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
