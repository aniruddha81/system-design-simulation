import { describe, expect, it } from 'vitest';
import { checkFidelity, runScale, sweep } from '../../engine/scale';
import { referenceDesigns } from './index';

function expectFinite(value: unknown) {
  if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) expectFinite(child);
}

describe('illustrative planet-scale references', () => {
  it('exports eight distinct, multi-region designs and all six Scale scenarios', () => {
    expect(referenceDesigns.map(r => r.id)).toEqual(['youtube', 'whatsapp', 'uber', 'twitter-timeline', 'netflix-cdn', 'stripe-payments', 'discord', 'google-search']);
    for (const ref of referenceDesigns) {
      expect(ref.label).toBe('illustrative');
      expect(ref.design.id).toBe(ref.id);
      expect(ref.design.regions?.names).toEqual(['us-east', 'eu-west']);
      expect(ref.design.regions?.latencyUs).toEqual([[0, 35_000], [35_000, 0]]);
      expect(new Set(ref.design.nodes.flatMap(n => 'region' in n.params ? [n.params.region] : [])).size).toBe(2);
      expect(ref.assumptions.some(a => a.source)).toBe(true);
      for (const a of ref.assumptions) {
        expect(a.claim.length).toBeGreaterThan(0);
        expect(a.value.length).toBeGreaterThan(0);
        if (a.source) expect(new URL(a.source.url).protocol).toBe('https:');
        else expect(a.claim).toContain('Illustrative');
      }
      expect(ref.scenarios.map(s => s.id)).toEqual(['normal-day', 'peak-event', 'region-outage', 'hot-key-celebrity', 'dependency-brownout', 'ddos']);
      expect(ref.scenarios.every(s => s.mode === 'scale')).toBe(true);
    }
  });

  for (const ref of referenceDesigns) {
    describe(ref.id, () => {
      for (const pack of ref.scenarios) {
        it(`${pack.id}: finite outputs, conserved flow, unknown correctness`, () => {
          const before = structuredClone({ design: ref.design, scenario: pack.scenario });
          const fidelity = checkFidelity(ref.design, pack.scenario);
          expect(fidelity.correctness).toBe('unknown');
          expect(fidelity.predictions.correctness.enabled).toBe(false);
          const hotWrites = pack.id === 'hot-key-celebrity' && ref.design.endpoints.some(e => e.op === 'write');
          for (const prediction of ['utilisation', 'backlog', 'drops', 'timelySuccess'] as const) expect(fidelity.predictions[prediction].enabled).toBe(!hotWrites);
          expect(fidelity.predictions.cost.enabled).toBe(true);
          let records = 0;
          const result = runScale(ref.design, pack.scenario, {
            minDtUs: 250_000, maxDtUs: 250_000, maxSteps: 64,
            onStep(point, conservation) {
              expectFinite(point);
              for (const c of conservation) {
                records++;
                expectFinite(c);
                const expected = c.backlogStart + c.arrivals - c.completions - c.drops;
                expect(Math.abs(c.backlogEnd - expected)).toBeLessThan(1e-6 * Math.max(1, c.arrivals, c.backlogStart));
                expect(c.backlogEnd).toBeGreaterThanOrEqual(0);
              }
            },
          });
          expect(result.outcome).toBe('finished');
          expect(result.steps).toBeLessThanOrEqual(64);
          expect(records).toBeGreaterThan(0);
          expectFinite(result);
          expect(result.correctness).toBe('unknown');
          expect(result.fidelity).toEqual(fidelity);
          const m = result.metrics;
          expect(Math.abs(m.offered - m.succeeded - m.failed - m.unfinished)).toBeLessThan(1e-6 * m.offered);
          if (hotWrites) expect(m.estimatedTimelySuccessRatio).toBeNull();
          else expect(m.estimatedTimelySuccessRatio).not.toBeNull();
          expect({ design: ref.design, scenario: pack.scenario }).toEqual(before);
        });
      }

      it('produces a scenario-specific failure ladder in a bounded independent sweep', () => {
        const result = sweep(ref.design, ref.scenarios[0].scenario, {
          kind: 'independent', levels: 3, maxMultiple: 16, warmupUs: 2_000_000, levelUs: 8_000_000,
          minDtUs: 250_000, maxDtUs: 250_000, maxSteps: 48, maxTotalSteps: 144,
        });
        expect(result.outcome).toBe('finished');
        expect(result.levels.map(l => l.multiple)).toEqual([1, 4, 16]);
        expect(result.ladder.length).toBeGreaterThan(0);
        expectFinite(result);
        expect(result.ladder.every(r => r.why.length && r.remedy.suggestion.length && !r.remedy.verified)).toBe(true);
        expect(result.ladder.slice(0, 3).map(r => [r.multiple, r.component, r.what])).toMatchSnapshot();
      });
    });
  }
});
