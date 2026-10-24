import { runToCompletion } from './simulation';
import { validateDesign } from './validation';
import { computeMonthlyCost } from './core';
import type { ChallengeSpec, Design, GradeReport, RunResult, Scenario } from './types';

export function gradeChallenge(design: Design, challenge: ChallengeSpec): GradeReport {
  const hints: GradeReport['hints'] = [
    'Compare database utilisation and queue wait during the measurement window.',
    'Cache popular reads, invalidate writes, and let cache failures fall back to the database.',
    'Size the cache for the hot key set; keep database headroom for a cold cache and avoid aggressive retries.',
  ];
  const issues = validateDesign(design, challenge.scenario);
  let costPerMonth = computeMonthlyCost(design);
  if (issues.length || !challenge.slos.some(s => s.kind === 'goodput') || design.nodes.some(n => !challenge.allowedKinds.includes(n.kind))) return { verdict: 'fail', stars: 0, perSeed: [], costPerMonth, hints };
  if (!challenge.seeds.length) return { verdict: 'inconclusive', stars: 0, perSeed: [], costPerMonth, hints };
  const assess = (result: RunResult) => {
    const failures: string[] = [];
    let insufficient = result.outcome === 'inconclusive';
    for (const invariant of new Set(result.violations.map(v => v.kind))) failures.push(`Invariant ${invariant} violated.`);
    for (const slo of challenge.slos) {
      const value = slo.kind === 'goodput' ? result.metrics.goodput : result.metrics.successLatency[slo.percentile];
      if (value === null) { insufficient = true; failures.push(`Insufficient samples for ${slo.kind === 'goodput' ? 'goodput' : slo.percentile}.`); }
      else if (slo.kind === 'goodput' ? value < slo.min : value > slo.maxUs) failures.push(`${slo.kind === 'goodput' ? 'goodput' : `success ${slo.percentile}`} SLO failed in measurement window [${challenge.scenario.warmupUs}, ${challenge.scenario.warmupUs + challenge.scenario.measureUs})us: ${value}.`);
    }
    if (result.metrics.costPerMonth > challenge.budgetPerMonth) failures.push(`Monthly cost ${result.metrics.costPerMonth} exceeds budget ${challenge.budgetPerMonth}.`);
    if (result.inconclusiveReason) failures.push(result.inconclusiveReason);
    return { failures, insufficient };
  };
  let insufficient = false;
  const run = (scenario: Scenario) => challenge.seeds.map(seed => {
    const result = runToCompletion(design, scenario, seed, { traceSampleRate: 0 });
    costPerMonth = Math.max(costPerMonth, result.metrics.costPerMonth);
    const a = assess(result); insufficient ||= a.insufficient;
    return { seed, result, failures: a.failures };
  });
  const perSeed = run(challenge.scenario);
  if (insufficient) return { verdict: 'inconclusive', stars: 0, perSeed, costPerMonth, hints };
  if (perSeed.some(s => s.failures.length)) return { verdict: 'fail', stars: 0, perSeed, costPerMonth, hints };
  let stars: GradeReport['stars'] = costPerMonth <= .8 * challenge.budgetPerMonth ? 2 : 1;
  if (stars === 2 && challenge.variantChaos.length) {
    let variantsPass = true;
    for (const chaos of challenge.variantChaos) {
      const variants = run({ ...challenge.scenario, chaos });
      if (variants.some(s => s.failures.length || s.result.outcome !== 'finished')) variantsPass = false;
      perSeed.push(...variants);
    }
    if (insufficient) return { verdict: 'inconclusive', stars: 0, perSeed, costPerMonth, hints };
    if (variantsPass) stars = 3;
  }
  return { verdict: 'pass', stars, perSeed, costPerMonth, hints };
}
