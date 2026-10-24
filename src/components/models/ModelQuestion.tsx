"use client";

import { useId, useState, type ReactNode } from "react";
import { useStepDone } from "@/components/lesson/stepper";
import { parseAnswer, randomSeed, seedFrom } from "@/lib/content/variants";
import { anomalyNames, generateHashRingVariant, generateIsolationVariant, solveHashRingVariant, solveIsolationVariant, type Anomaly } from "@/models";
import { ANOMALY_NAMES, LEVEL_NAMES, opText } from "./IsolationPlayer";
import { focusedQuestion, checkFocusedAnswer, displayAnswer, type FocusedModelName } from "./question-data";
import { describeAction } from "./FocusedPlayer";

const TOLERANCE = 0.3;

export type ModelName = "hashRing" | "isolation" | FocusedModelName;

/** Seeded variant question over a focused model; the model's solver is the answer key (PLAN §9). */
export function ModelQuestion({ id, model, seed }: { id: string; objective: string; model: ModelName; seed?: number }) {
  const [current, setCurrent] = useState(() => seed ?? seedFrom(`${model}:${id}`));
  const fresh = () => setCurrent(randomSeed());
  return (
    <div role="group" aria-label="Model question" className="panel my-6 p-5 sm:p-6">
      {model === "hashRing" ? <RingQuestion key={`${model}-${current}`} seed={current} onFresh={fresh} /> : model === "isolation" ? <IsolationQuestion key={`${model}-${current}`} seed={current} onFresh={fresh} /> : <FocusedQuestion key={`${model}-${current}`} model={model} seed={current} onFresh={fresh} />}
    </div>
  );
}

function FocusedQuestion({ model, seed, onFresh }: { model: FocusedModelName; seed: number; onFresh: () => void }) {
  const done = useStepDone();
  const question = focusedQuestion(model, seed);
  const [answers, setAnswers] = useState<string[]>(question.fields.map(() => ""));
  const [result, setResult] = useState<boolean | null>(null);
  return <form onSubmit={e => {
    e.preventDefault();
    const ok = question.fields.every((field, i) => checkFocusedAnswer(field, answers[i]));
    setResult(ok);
    if (ok) done();
  }}>
    <p className="mb-3 font-medium">{question.prompt}</p>
    <p className="mb-2 text-sm text-muted">Seed {seed}. Start from the supplied configuration and replay the actions in order.</p>
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface-2 p-3 text-xs" aria-label="Question configuration">{JSON.stringify(question.context, null, 2)}</pre>
    <ol className="my-4 max-h-80 list-decimal overflow-auto pl-6 text-sm" aria-label="Question schedule">{question.actions.map((a, i) => <li key={i} className="break-words py-1 num">{describeAction(a)}</li>)}</ol>
    <fieldset disabled={result !== null} className="grid gap-3">
      <legend className="sr-only">Your prediction</legend>
      {question.fields.map((field, i) => {
        const choices = typeof field.answer === "boolean" ? ["yes", "no"] : field.choices;
        return <label key={field.label} className="grid gap-1 text-sm">{field.label}
          {choices ? <select className="field" required value={answers[i]} onChange={e => setAnswers(answers.map((v, j) => j === i ? e.target.value : v))}><option value="">Choose an answer</option>{choices.map(c => <option key={c}>{c}</option>)}</select> : <input className="field" required inputMode={typeof field.answer === "number" ? "decimal" : "text"} value={answers[i]} onChange={e => setAnswers(answers.map((v, j) => j === i ? e.target.value : v))} />}
        </label>;
      })}
    </fieldset>
    {result === null && <button type="submit" className="btn btn-primary mt-4">Check</button>}
    <div aria-live="polite">{result !== null && <Result ok={result} onFresh={onFresh}>
      <p>{question.explanation}</p>
      <ul>{question.fields.map(field => <li key={field.label}>{field.label}: {displayAnswer(field.answer)}</li>)}</ul>
    </Result>}</div>
  </form>;
}

function Result({ ok, children, onFresh }: { ok: boolean; children: ReactNode; onFresh: () => void }) {
  return (
    <>
      <div className={`mt-4 flex gap-3 rounded-md border p-4 ${ok ? "border-success/40 bg-success/10" : "border-danger/40 bg-danger/10"}`}>
        <span aria-hidden className={`font-bold ${ok ? "text-success" : "text-danger"}`}>
          {ok ? "✓" : "✕"}
        </span>
        <div>
          <p className="font-semibold">{ok ? "Correct" : "Not quite"}</p>
          <div className="text-muted">{children}</div>
        </div>
      </div>
      <button type="button" className="btn mt-4" onClick={onFresh}>
        {ok ? "Practise another variant" : "Try a fresh variant"}
      </button>
    </>
  );
}

function RingQuestion({ seed, onFresh }: { seed: number; onFresh: () => void }) {
  const done = useStepDone();
  const variant = generateHashRingVariant(seed);
  const answer = solveHashRingVariant(variant);
  const [text, setText] = useState("");
  const [result, setResult] = useState<boolean | null>(null);
  const inputId = useId();
  const share = Math.round(variant.keys.length / variant.nodes.length);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = parseAnswer(text);
        if (v === null) return;
        const ok = Math.abs(v - answer) <= Math.max(1, answer * TOLERANCE);
        setResult(ok);
        if (ok) done();
      }}
    >
      <p className="mb-2 font-medium">{variant.prompt}</p>
      <p className="mb-4 text-sm text-muted">Keys are placed by hash on the ring; each key belongs to the first virtual node clockwise. Estimate it: answers within ±30% of the model&apos;s exact count are accepted.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          Keys that move
        </label>
        <input id={inputId} inputMode="numeric" autoComplete="off" className="field w-32" value={text} disabled={result !== null} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={result !== null || !text.trim()}>
          Check
        </button>
      </div>
      <div aria-live="polite">
        {result !== null && (
          <Result ok={result} onFresh={onFresh}>
            {result ? (
              <p>Exactly the keys owned by {variant.action.type === "removeNode" ? variant.action.node : "that node"} move: the model gives {answer} of {variant.keys.length}.</p>
            ) : (
              <p>
                Only the removed node&apos;s keys move, so the answer is its current load: about keys ÷ nodes ≈ {share}, but the exact count depends on where its {variant.vnodes} virtual node
                {variant.vnodes === 1 ? "" : "s"} sit. The model gives {answer}.
              </p>
            )}
          </Result>
        )}
      </div>
    </form>
  );
}

function IsolationQuestion({ seed, onFresh }: { seed: number; onFresh: () => void }) {
  const done = useStepDone();
  const variant = generateIsolationVariant(seed);
  const answer = solveIsolationVariant(variant);
  const [picked, setPicked] = useState<Anomaly[]>([]);
  const [result, setResult] = useState<boolean | null>(null);
  const { scenario } = variant;
  const right = picked.length === answer.length && picked.every((a) => answer.includes(a));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setResult(right);
        if (right) done();
      }}
    >
      <p className="mb-3 font-medium">{variant.prompt}</p>
      <dl className="mb-3 grid gap-1 text-sm">
        <div>
          <dt className="inline text-muted">Isolation level: </dt>
          <dd className="inline font-medium">{LEVEL_NAMES[variant.level]}</dd>
        </div>
        <div>
          <dt className="inline text-muted">Initial values: </dt>
          <dd className="num inline">{Object.entries(scenario.initial).map(([k, v]) => `${k} = ${v}`).join(", ")}</dd>
        </div>
        {scenario.transactions.map((tx) => (
          <div key={tx.id}>
            <dt className="inline text-muted">{tx.id}: </dt>
            <dd className="num inline">{tx.ops.map(opText).join("; ")}</dd>
          </div>
        ))}
        <div>
          <dt className="inline text-muted">Schedule (who runs their next operation): </dt>
          <dd className="num inline">{scenario.actions.map((a) => a.transaction).join(" → ")}</dd>
        </div>
      </dl>
      <fieldset disabled={result !== null}>
        <legend className="mb-2 text-sm text-muted">Select every anomaly observed; select none if all are prevented.</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {anomalyNames.map((a) => (
            <label key={a} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-border px-3">
              <input type="checkbox" className="size-4" checked={picked.includes(a)} onChange={() => setPicked((p) => (p.includes(a) ? p.filter((x) => x !== a) : [...p, a]))} />
              {ANOMALY_NAMES[a]}
            </label>
          ))}
        </div>
      </fieldset>
      {result === null && (
        <button type="submit" className="btn btn-primary mt-4">
          Check
        </button>
      )}
      <div aria-live="polite">
        {result !== null && (
          <Result ok={result} onFresh={onFresh}>
            {result ? (
              <p>The scheduler observed: {answer.length ? answer.map((a) => ANOMALY_NAMES[a]).join(", ") : "no anomaly (all prevented)"}.</p>
            ) : (
              <p>Replay the schedule step by step: watch which reads see committed versions, which writes wait for locks, and which commit is rejected.</p>
            )}
          </Result>
        )}
      </div>
    </form>
  );
}
