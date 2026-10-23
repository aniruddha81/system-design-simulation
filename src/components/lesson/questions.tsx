"use client";

import { motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { formatNumber, formatPercent } from "@/lib/format";
import { diagnose, generate, isCorrect, parseAnswer, randomSeed, rng, seedFrom, templates, type Variant } from "@/lib/content/variants";
import { ids, saveProgress } from "./progress";
import { useLesson, useStepDone } from "./stepper";

// ---------- shared pieces ----------

function Card({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="group" aria-label={label} className="panel my-6 p-5 sm:p-6">
      {children}
    </div>
  );
}

/** Spring check on correct, shake on wrong; under reduced motion only the crossfade remains. */
function Feedback({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: ok ? 0.96 : 1 }}
      animate={ok ? { opacity: 1, scale: 1 } : { opacity: 1, x: [0, -8, 7, -5, 3, 0] }}
      transition={ok ? { type: "spring", stiffness: 520, damping: 22 } : { duration: 0.42, ease: "easeOut" }}
      className={`mt-4 flex gap-3 rounded-md border p-4 text-[0.9375rem] leading-relaxed ${
        ok ? "border-success/40 bg-success/10" : "border-danger/40 bg-danger/10"
      }`}
    >
      <motion.span
        aria-hidden
        initial={{ scale: ok ? 0.4 : 1 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 600, damping: 15 }}
        className={`grid size-6 shrink-0 place-items-center rounded-full text-sm font-bold ${ok ? "bg-success text-bg" : "bg-danger text-bg"}`}
      >
        {ok ? "✓" : "✕"}
      </motion.span>
      <div>
        <p className="font-semibold">{ok ? "Correct" : "Not quite"}</p>
        <div className="text-muted [&_strong]:text-fg">{children}</div>
      </div>
    </motion.div>
  );
}

function Prompt({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className="mb-4 font-medium leading-relaxed text-fg">
      {children}
    </p>
  );
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// ---------- Choice: single or multiple, feedback per distractor ----------

type Option = { id: string; text: string; correct?: boolean; feedback: string };

export function Choice({ id, prompt, multiple = false, options }: { id: string; objective: string; prompt: string; multiple?: boolean; options: Option[] }) {
  const done = useStepDone();
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const correctIds = options.filter((o) => o.correct).map((o) => o.id);
  const right = sameSet(selected, correctIds);
  const name = `${useId()}-${id}`;

  const toggle = (oid: string) =>
    setSelected((s) => (multiple ? (s.includes(oid) ? s.filter((x) => x !== oid) : [...s, oid]) : [oid]));

  const shown = options.filter((o) => selected.includes(o.id) || (multiple && o.correct));

  return (
    <Card label="Question">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (right) done();
        }}
      >
        <fieldset disabled={submitted}>
          <legend className="contents">
            <Prompt>{prompt}</Prompt>
          </legend>
          {multiple && <p className="-mt-2 mb-3 text-sm text-muted">Select all that apply.</p>}
          <div className="grid gap-2">
            {options.map((o) => {
              const checked = selected.includes(o.id);
              const mark = submitted ? (o.correct && checked ? "✓" : !o.correct && checked ? "✕" : o.correct && multiple ? "missed" : "") : "";
              return (
                <label
                  key={o.id}
                  className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3.5 py-2.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                    checked ? "border-accent bg-accent/10" : "border-border hover:border-muted"
                  }`}
                >
                  <input
                    type={multiple ? "checkbox" : "radio"}
                    name={name}
                    value={o.id}
                    checked={checked}
                    onChange={() => toggle(o.id)}
                    className="mt-1 size-4 shrink-0 accent-[var(--accent)] focus-visible:outline-none"
                  />
                  <span className="flex-1">{o.text}</span>
                  {mark && <span className={`text-sm font-medium ${mark === "✓" ? "text-success" : "text-danger"}`}>{mark === "missed" ? "Missed" : mark}</span>}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div aria-live="polite">
          {submitted && (
            <Feedback ok={right}>
              <ul className="mt-1 grid gap-2">
                {shown.map((o) => (
                  <li key={o.id}>
                    {shown.length > 1 && <strong>{o.text}: </strong>}
                    {o.feedback}
                  </li>
                ))}
              </ul>
            </Feedback>
          )}
        </div>
        <div className="mt-4 flex gap-2">
          {!submitted && (
            <button type="submit" className="btn btn-primary" disabled={selected.length === 0}>
              Check
            </button>
          )}
          {submitted && !right && (
            <button type="button" className="btn" onClick={() => setSubmitted(false)}>
              Try again
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

// ---------- Ordering: keyboard-first reordering with up/down buttons ----------

type Item = { id: string; text: string };

function initialOrder(id: string, items: Item[]): Item[] {
  const next = rng(seedFrom(id));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (out.every((x, i) => x.id === items[i].id)) out.push(out.shift()!); // never start solved
  return out;
}

export function Ordering({ id, prompt, items, explanation }: { id: string; objective: string; prompt: string; items: Item[]; explanation: string }) {
  const done = useStepDone();
  const [order, setOrder] = useState(() => initialOrder(id, items));
  const [submitted, setSubmitted] = useState(false);
  const placed = order.map((x, i) => x.id === items[i].id);
  const right = placed.every(Boolean);
  const promptId = useId();

  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      const n = [...o];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });

  return (
    <Card label="Ordering question">
      <Prompt id={promptId}>{prompt}</Prompt>
      <ol aria-labelledby={promptId} className="grid gap-2">
        {order.map((item, i) => (
          <motion.li
            layout
            key={item.id}
            transition={{ type: "spring", stiffness: 500, damping: 38 }}
            className={`flex min-h-12 items-center gap-3 rounded-md border bg-surface-2 py-1.5 pl-3 pr-1.5 ${
              submitted ? (placed[i] ? "border-success/50" : "border-danger/50") : "border-border"
            }`}
          >
            <span className="num w-5 text-sm text-muted">{i + 1}</span>
            <span className="flex-1">{item.text}</span>
            {submitted ? (
              <span className={`px-2 text-sm font-medium ${placed[i] ? "text-success" : "text-danger"}`}>{placed[i] ? "✓ In place" : "✕ Out of place"}</span>
            ) : (
              <span className="flex gap-1">
                <button type="button" className="btn btn-ghost size-9 min-h-9 p-0" aria-label={`Move "${item.text}" up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-ghost size-9 min-h-9 p-0"
                  aria-label={`Move "${item.text}" down`}
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
              </span>
            )}
          </motion.li>
        ))}
      </ol>
      <div aria-live="polite">
        {submitted && (
          <Feedback ok={right}>
            {right ? explanation : `${placed.filter(Boolean).length} of ${items.length} are in the right place. Think about what the service must know before it can take the next step.`}
          </Feedback>
        )}
      </div>
      <div className="mt-4">
        {!submitted ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setSubmitted(true);
              if (right) done();
            }}
          >
            Check order
          </button>
        ) : (
          !right && (
            <button type="button" className="btn" onClick={() => setSubmitted(false)}>
              Try again
            </button>
          )
        )}
      </div>
    </Card>
  );
}

// ---------- Numeric variants ----------

function formatAnswer(v: Variant): string {
  const t = templates[v.templateId];
  return `${formatNumber(v.answer, v.answer < 100 ? 1 : 0)} ${t.unit}`;
}

function NumericForm({
  variant,
  onAnswer,
  disabled,
}: {
  variant: Variant;
  onAnswer: (value: number) => void;
  disabled: boolean;
}) {
  const t = templates[variant.templateId];
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = parseAnswer(text);
        setInvalid(value === null);
        if (value !== null) onAnswer(value);
      }}
    >
      <Prompt>{t.prompt(variant.params)}</Prompt>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          Your answer in {t.unit}
        </label>
        <div className="flex items-center rounded-md border border-border bg-bg focus-within:border-accent">
          <input
            id={inputId}
            inputMode="decimal"
            autoComplete="off"
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={`${inputId}-tol`}
            className="field w-40 border-0 bg-transparent focus-visible:outline-none"
          />
          <span className="pr-3 text-sm text-muted">{t.unit}</span>
        </div>
        <button type="submit" className="btn btn-primary" disabled={disabled || !text.trim()}>
          Check
        </button>
        <span id={`${inputId}-tol`} className="text-sm text-muted">
          Within ±{formatPercent(t.tolerance, 0)}
        </span>
      </div>
      {invalid && <p className="mt-2 text-sm text-danger">Enter a number, for example 12,000.</p>}
    </form>
  );
}

export function VariantQuestion({ template: templateId }: { template: string }) {
  const done = useStepDone();
  const t = templates[templateId];
  // First variant is seeded from the id so server and client agree; later ones are random.
  const [seed, setSeed] = useState(() => seedFrom(templateId));
  const [result, setResult] = useState<{ ok: boolean; value: number } | null>(null);
  const variant = generate(t, seed);

  return (
    <Card label="Numeric question">
      <NumericForm
        key={seed}
        variant={variant}
        disabled={result !== null}
        onAnswer={(value) => {
          const ok = isCorrect(t, variant, value);
          setResult({ ok, value });
          if (ok) done();
        }}
      />
      <div aria-live="polite">
        {result && (
          <Feedback ok={result.ok}>
            {result.ok ? (
              <p>
                The solver&apos;s answer is <strong>{formatAnswer(variant)}</strong>.
              </p>
            ) : (
              <>
                <p>{diagnose(t, variant, result.value)}</p>
                <p className="mt-2">
                  <a href={`#step-${t.step}`} className="text-accent underline underline-offset-4">
                    Re-read this step
                  </a>
                  , then try a fresh variant.
                </p>
              </>
            )}
          </Feedback>
        )}
      </div>
      {result && (
        <button
          type="button"
          className="btn mt-4"
          onClick={() => {
            setSeed(randomSeed());
            setResult(null);
          }}
        >
          {result.ok ? "Practise another variant" : "Try a fresh variant"}
        </button>
      )}
    </Card>
  );
}

// ---------- Mastery check: unseen variants, ≥ 80% to master ----------

const PASS = 0.8;

export function MasteryCheck({ templates: templateIds, count }: { templates: string[]; count: number }) {
  const done = useStepDone();
  const { lessonId, revision, stepIds } = useLesson();
  const [items, setItems] = useState<Variant[] | null>(null);
  const [results, setResults] = useState<{ ok: boolean; value: number }[]>([]);
  const index = results.length;
  const [showing, setShowing] = useState(false); // feedback for the latest answer is on screen
  const finished = items !== null && results.length === items.length && !showing;

  const start = () => {
    // Random 32-bit seeds: effectively never a variant seen before; retries never reuse items.
    setItems(Array.from({ length: count }, (_, i) => generate(templates[templateIds[i % templateIds.length]], randomSeed())));
    setResults([]);
    setShowing(false);
  };

  const record = (ok: boolean, value: number) => {
    const next = [...results, { ok, value }];
    setResults(next);
    setShowing(true);
    if (next.length === items!.length) save(items!, next);
  };

  const save = (variants: Variant[], res: { ok: boolean }[]) => {
    const score = res.filter((r) => r.ok).length / res.length;
    const now = Date.now();
    void saveProgress({ itemId: ids.lesson(lessonId), kind: "lesson", mastery: score }, revision);
    const byObjective = new Map<string, boolean[]>();
    variants.forEach((v, i) => {
      const o = templates[v.templateId].objective;
      byObjective.set(o, [...(byObjective.get(o) ?? []), res[i].ok]);
    });
    for (const [o, oks] of byObjective) {
      void saveProgress(
        { itemId: ids.objective(lessonId, o), kind: "objective", mastery: oks.filter(Boolean).length / oks.length, completedAt: now },
        revision,
      );
    }
    done();
  };

  if (!items) {
    return (
      <Card label="Mastery check">
        <p className="mb-1 font-semibold">Mastery check</p>
        <p className="mb-4 text-muted">
          {count} questions on fresh variants. One attempt each, no time limit. Score {formatPercent(PASS, 0)} or more to master the lesson.
        </p>
        <button type="button" className="btn btn-primary" onClick={start}>
          Start the check
        </button>
      </Card>
    );
  }

  if (finished) {
    const score = results.filter((r) => r.ok).length / items.length;
    const missedSteps = [...new Set(items.filter((_, i) => !results[i].ok).map((v) => templates[v.templateId].step))].filter((s) =>
      stepIds.includes(s),
    );
    const passed = score >= PASS;
    return (
      <Card label="Mastery check result">
        <div aria-live="polite">
          <Feedback ok={passed}>
            <p>
              You scored <strong className="num">{formatPercent(score, 0)}</strong>.{" "}
              {passed ? "Lesson mastered. Missed objectives still go to your review queue." : `You need ${formatPercent(PASS, 0)} to master the lesson.`}
            </p>
            {missedSteps.length > 0 && (
              <p className="mt-2">
                Review:{" "}
                {missedSteps.map((s, i) => (
                  <span key={s}>
                    {i > 0 && ", "}
                    <a href={`#step-${s}`} className="text-accent underline underline-offset-4">
                      step {stepIds.indexOf(s) + 1}
                    </a>
                  </span>
                ))}
              </p>
            )}
          </Feedback>
        </div>
        <button type="button" className="btn mt-4" onClick={start}>
          Retake with new variants
        </button>
      </Card>
    );
  }

  const currentIndex = showing ? index - 1 : index;
  const v = items[currentIndex];
  const t = templates[v.templateId];
  const last = results[currentIndex];

  return (
    <Card label="Mastery check">
      <p className="mb-4 text-sm text-muted">
        Question <span className="num text-fg">{currentIndex + 1}</span> of <span className="num">{items.length}</span>
      </p>
      <NumericForm key={`${currentIndex}-${v.seed}`} variant={v} disabled={showing} onAnswer={(value) => record(isCorrect(t, v, value), value)} />
      <div aria-live="polite">
        {showing && last && (
          <Feedback ok={last.ok}>
            {last.ok ? (
              <p>
                The solver&apos;s answer is <strong>{formatAnswer(v)}</strong>.
              </p>
            ) : (
              <>
                <p>{diagnose(t, v, last.value)}</p>
                <p className="mt-2">
                  <a href={`#step-${t.step}`} className="text-accent underline underline-offset-4">
                    Review the step that teaches this
                  </a>
                  . The next question is a fresh variant.
                </p>
              </>
            )}
          </Feedback>
        )}
      </div>
      {showing && (
        <button type="button" className="btn btn-primary mt-4" onClick={() => setShowing(false)}>
          {currentIndex + 1 === items.length ? "See result" : "Next question"}
        </button>
      )}
    </Card>
  );
}
