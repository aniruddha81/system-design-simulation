import type { Design, EndpointId, EntitySpec, InvariantKind, Scenario } from "@/engine/types";

// Case-study contract (PLAN §3 Track 5, §10). Interview mode reads these: stages, rubric,
// deep-dive cards (failure scenarios) and the reference design it diffs against.

export const RUBRIC_STAGES = ["requirements", "estimates", "api", "data model", "high level", "deep dive", "wrap-up"] as const;
export type RubricStage = (typeof RUBRIC_STAGES)[number];

/** A worked back-of-envelope number: what, how, result. */
export type Estimate = { label: string; formula: string; result: string; note?: string };

export type ApiCall = {
  signature: string; // e.g. "POST /v1/urls"
  request: string;
  response: string;
  notes?: string;
  endpointId?: EndpointId; // the matching endpoint in the reference design, if simulated
};

/** Machine-checked claim about one run (seed 1). Keeps the prose honest; interview mode can reuse it. */
export type Check = {
  minGoodput?: number;
  maxGoodput?: number;
  /** Every listed invariant must be violated at least once. */
  violations?: InvariantKind[];
  /** No invariant violations at all. */
  clean?: boolean;
  /** Bounds on the p99 latency of successful requests, in ms. */
  minP99Ms?: number;
  maxP99Ms?: number;
};

export type FailureScenario = {
  id: string;
  title: string;
  explanation: string;
  scenario: Scenario;
  /** What the learner should see when the reference design runs this scenario. */
  expect: string;
  check?: Check;
};

export type Alternative = {
  title: string;
  tradeoffs: string;
  design?: Design;
  /** Run `design` against the baseline ("baseline") or a failure scenario id and see this. */
  check?: Check & { scenario: string };
};

export type CaseStudy = {
  id: string; // also the MDX slug in content/en/case-studies
  title: string;
  summary: string;
  requirements: { functional: string[]; nonFunctional: string[] };
  estimates: Estimate[];
  api: ApiCall[];
  dataModel: { entities: EntitySpec[]; notes: string[] };
  design: Design;
  /** The normal-day workload the reference design is sized for (a reduced Exact-mode cell). */
  scenario: Scenario;
  alternatives: Alternative[];
  failureScenarios: FailureScenario[];
  deepDives: { title: string; body: string }[];
  rubric: { stage: RubricStage; descriptors: [string, string, string, string] }[];
  clarifyingQuestions: string[];
  commonMistakes: string[];
};
