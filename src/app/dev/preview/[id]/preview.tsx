"use client";

import Link from "next/link";
import { useState, type ComponentType } from "react";
import { Step, LessonStepper } from "@/components/lesson/stepper";
import { ScalePanel } from "@/components/scale";
import { cacheAsideDesign, cachingScenario, noCacheDesign } from "@/engine/fixtures";
import type { NodeId, Scenario } from "@/engine/types";
import { widgetSchemas, type WidgetName } from "@/lib/content/schema";
import { diagnose, generate, isCorrect, randomSeed, seedFrom, templateIds, templates } from "@/lib/content/variants";
import { generateHashRingVariant, generateIsolationVariant, solveHashRingVariant, solveIsolationVariant } from "@/models";
import type { ModelName } from "@/components/models/ModelQuestion";
import * as modelWidgets from "@/components/models";
import { focusedModelNames, focusedQuestion, displayAnswer } from "@/components/models/question-data";
import { useMDXComponents } from "../../../../../mdx-components";

type Ctx = { seed: number; template: string; model: ModelName };

const SAMPLES: Record<WidgetName, (c: Ctx) => Record<string, unknown>> = {
  Step: () => ({ id: "preview", title: "A preview step", children: "Step body. Every lesson step needs one interactive widget." }),
  Choice: () => ({
    id: "sample-choice",
    objective: "sample",
    prompt: "Which component absorbs repeated reads of the same key?",
    options: [
      { id: "cache", text: "A cache", correct: true, feedback: "Right: repeated reads are answered from memory." },
      { id: "lb", text: "A load balancer", feedback: "It spreads requests but stores nothing." },
    ],
  }),
  Ordering: () => ({
    id: "sample-order",
    objective: "sample",
    prompt: "Put a cache-aside read in order.",
    items: [
      { id: "get", text: "GET the key from the cache" },
      { id: "db", text: "On a miss, read the database" },
      { id: "set", text: "SET the value in the cache" },
    ],
    explanation: "Read the cache first, fall back to the database, then fill the cache.",
  }),
  VariantQuestion: (c) => ({ template: c.template }),
  HitRateCalculator: () => ({}),
  MasteryCheck: () => ({ templates: templateIds, count: 3 }),
  HashRingPlayer: (c) => ({ seed: c.seed }),
  IsolationPlayer: (c) => ({ seed: c.seed }),
  RaftPlayer: (c) => ({ seed: c.seed }),
  ClocksPlayer: (c) => ({ seed: c.seed }),
  TwoPhasePlayer: (c) => ({ seed: c.seed }),
  GossipPlayer: (c) => ({ seed: c.seed }),
  QuorumPlayer: (c) => ({ seed: c.seed }),
  CrdtPlayer: (c) => ({ seed: c.seed }),
  MatchingPlayer: (c) => ({ seed: c.seed }),
  SpatialPlayer: (c) => ({ seed: c.seed }),
  SketchesPlayer: (c) => ({ seed: c.seed }),
  WindowingPlayer: (c) => ({ seed: c.seed }),
  ModelQuestion: (c) => ({ id: "preview", objective: "sample", model: c.model, seed: c.seed }),
};

const readsOnly: Scenario = { ...cachingScenario, id: "reads-only", chaos: [], workload: { ...cachingScenario.workload, mix: { get: 1 } } };

export function Preview({ id, ids }: { id: string; ids: string[] }) {
  const [seed, setSeed] = useState(1);
  const [template, setTemplate] = useState(templateIds[0]);
  const [model, setModel] = useState<Ctx["model"]>("hashRing");
  const widgets = { ...useMDXComponents(), ...modelWidgets } as unknown as Record<string, ComponentType<Record<string, unknown>>>;
  const isWidget = id in widgetSchemas;
  const name = id as WidgetName;
  const props = isWidget ? SAMPLES[name]({ seed, template, model }) : {};
  const valid = isWidget ? widgetSchemas[name].safeParse(props) : null;
  const Widget = widgets[id];
  const seeded = id.endsWith("Player") || id === "ModelQuestion";

  return (
    <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 md:grid-cols-[12rem_1fr]">
      <nav aria-label="Widgets">
        <p className="mb-2 text-sm font-semibold">Author preview</p>
        <ul className="grid gap-1 text-sm">
          {ids.map((w) => (
            <li key={w}>
              <Link href={`/dev/preview/${w}`} aria-current={w === id ? "page" : undefined} className={`flex min-h-8 items-center rounded-md px-2 ${w === id ? "bg-accent/15 text-fg" : "text-muted hover:text-fg"}`}>
                {w}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="grid min-w-0 content-start gap-4">
        <h1 className="text-2xl font-semibold">{id}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Variant shuffler">
          {seeded && (
            <>
              <label className="flex items-center gap-2">
                Seed
                <input type="number" className="field w-36" value={seed} onChange={(e) => Number.isSafeInteger(e.target.valueAsNumber) && setSeed(e.target.valueAsNumber)} />
              </label>
              <button type="button" className="btn" onClick={() => setSeed(randomSeed())}>
                New seed
              </button>
            </>
          )}
          {(id === "VariantQuestion" || id === "MasteryCheck") && <p className="text-muted">Use the widget below to generate fresh variants. Solver checks here describe the initial sample only.</p>}
          {id === "VariantQuestion" && (
            <select aria-label="Template" className="field" value={template} onChange={(e) => setTemplate(e.target.value)}>
              {templateIds.map((t) => <option key={t}>{t}</option>)}
            </select>
          )}
          {id === "ModelQuestion" && (
            <select aria-label="Model" className="field" value={model} onChange={(e) => setModel(e.target.value as Ctx["model"])}>
              <option value="hashRing">hashRing</option>
              <option value="isolation">isolation</option>
              {focusedModelNames.map(name => <option key={name}>{name}</option>)}
            </select>
          )}
        </div>
        {valid && (
          <p className={`text-sm ${valid.success ? "text-success" : "text-danger"}`}>
            {valid.success ? `✓ Sample props valid against widgetSchemas.${id}` : `✕ Invalid props: ${valid.error.message}`}
          </p>
        )}
        <Invariants id={id} ctx={{ seed, template, model }} />
        <div className="panel p-4">
          {id === "ScalePanel" ? (
            <ScalePreview />
          ) : (
            <LessonStepper lessonId="dev-preview" revision={1} stepIds={["preview"]} stepTitles={["Preview"]}>
              {id === "Step" ? (
                <Widget key={seed} {...props} />
              ) : (
                <Step id="preview" title={`${id} (seed ${seed})`}>
                  <Widget key={`${seed}-${template}-${model}`} {...props} />
                </Step>
              )}
            </LessonStepper>
          )}
        </div>
      </div>
    </div>
  );
}

/** Solver-checked invariants for the shuffled seed. */
function Invariants({ id, ctx }: { id: string; ctx: Ctx }) {
  const rows: [string, string][] = [];
  if (id === "VariantQuestion" || id === "MasteryCheck") {
    for (const tid of id === "VariantQuestion" ? [ctx.template] : templateIds) {
      const t = templates[tid];
      const seed = id === "VariantQuestion" ? seedFrom(tid) : ctx.seed;
      const v = generate(t, seed);
      const mistakesDistinct = (t.mistakes?.(v.params) ?? []).every((m) => !isCorrect(t, v, m.value) && diagnose(t, v, m.value) === m.feedback);
      rows.push([`${tid} @ seed ${seed}`, `params ${JSON.stringify(v.params)} → answer ${v.answer} ${t.unit}; solver accepts its answer ${isCorrect(t, v, v.answer) ? "✓" : "✕"}; distractors distinct ${mistakesDistinct ? "✓" : "✕"}`]);
    }
    if (id === "VariantQuestion") rows.push(["note", "The widget's first variant is seeded from its template id; use “Try a fresh variant” inside it to shuffle."]);
  } else if (id === "ModelQuestion") {
    if (ctx.model === "hashRing") {
      const v = generateHashRingVariant(ctx.seed);
      rows.push([v.id, `${v.prompt} → solver: ${solveHashRingVariant(v)} keys move`]);
    } else if (ctx.model === "isolation") {
      const v = generateIsolationVariant(ctx.seed);
      rows.push([v.id, `${v.level}, ${v.scenario.anomaly} schedule → solver observes: ${solveIsolationVariant(v).join(", ") || "none"}`]);
    } else {
      const question = focusedQuestion(ctx.model, ctx.seed);
      rows.push([`${ctx.model} @ seed ${ctx.seed}`, question.fields.map(f => `${f.label}: ${displayAnswer(f.answer)}`).join("; ")]);
    }
  } else if (id.endsWith("Player")) {
    rows.push(["invariants", "Shown live inside the player (violated invariants list), recomputed after every step."]);
  }
  if (!rows.length) return null;
  return (
    <dl className="grid gap-1 rounded-md border border-border p-3 text-sm">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="num inline text-muted">{k}: </dt>
          <dd className="inline">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ScalePreview() {
  const [which, setWhich] = useState<"chaos" | "reads" | "capacity">("chaos");
  const [heat, setHeat] = useState<Record<NodeId, number> | null>(null);
  return (
    <div className="grid gap-4">
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Fixture scenario
        <select className="field" value={which} onChange={(e) => setWhich(e.target.value as typeof which)}>
          <option value="chaos">cachingScenario (writes + cache kill)</option>
          <option value="reads">reads only, no chaos (inside the cache envelope)</option>
          <option value="capacity">reads only, no cache (capacity ladder)</option>
        </select>
      </label>
      <p className="text-sm" aria-label="onHeat output">
        <span className="text-muted">onHeat: </span>
        <span className="num">{heat === null ? "null" : Object.entries(heat).map(([n, h]) => `${n} ${h.toFixed(2)}`).join(", ")}</span>
      </p>
      <ScalePanel key={which} design={which === "capacity" ? noCacheDesign : cacheAsideDesign} scenario={which === "chaos" ? cachingScenario : readsOnly} onHeat={setHeat} />
    </div>
  );
}
