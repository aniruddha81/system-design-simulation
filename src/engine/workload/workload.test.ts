import { expect, it } from 'vitest';
import { Random } from '../core';
import type { Workload } from '../types';
import { arrivalRate, batchBackfill, ddos, diurnal, launchDaySpike, parseReplayCsv, renderKey, sampleInput, sampleKey, toPeakRps, viralKey } from './index';

it('integrates every arrival shape over ten seconds', () => {
  const cases: [Workload['arrival'], number][] = [
    [{ kind: 'poisson', rps: 10 }, 100], [{ kind: 'constant', rps: 10 }, 100],
    [{ kind: 'step', rps: 10, stepAtUs: 5e6, stepRps: 30 }, 200],
    [{ kind: 'spike', rps: 10, spikeAtUs: 2e6, spikeDurUs: 2e6, spikeRps: 50 }, 180],
    [{ kind: 'ramp', fromRps: 10, toRps: 30 }, 200],
    [{ kind: 'diurnal', meanRps: 10, amplitude: .9, periodUs: 10e6 }, 100],
    [{ kind: 'replay', points: [{ atUs: 0, rps: 10 }, { atUs: 5e6, rps: 30 }, { atUs: 10e6, rps: 10 }] }, 200],
  ];
  for (const [arrival, expected] of cases) {
    let count = 0;
    for (let t = 500; t < 10e6; t += 1000) count += arrivalRate(arrival, t, 10e6) / 1000;
    expect(count).toBeCloseTo(expected, 3);
  }
  expect(arrivalRate({ kind: 'replay', points: [] }, 10)).toBe(0);
  expect(arrivalRate({ kind: 'replay', points: [{ atUs: 1, rps: 3 }] }, 100)).toBe(3);
  expect(arrivalRate({ kind: 'ramp', fromRps: 0, toRps: 100 }, 300e6)).toBe(100);
});

it('generates bounded repeatable inputs, independent sequences, sizes and templates', () => {
  const gens = [{ kind: 'uniform', min: 3, max: 10 }, { kind: 'zipf', min: 3, max: 10, s: 1.2 }, { kind: 'size', meanBytes: 100, sdBytes: 10 }] as const;
  for (const gen of gens) {
    const a = new Random(1, 'input'), b = new Random(1, 'input');
    const values = Array.from({ length: 100 }, () => sampleInput(gen, a));
    expect(values).toEqual(Array.from({ length: 100 }, () => sampleInput(gen, b)));
    expect(values.every(x => Number(x) >= (gen.kind === 'size' ? 0 : 3) && (gen.kind === 'size' || Number(x) <= 10))).toBe(true);
  }
  const seq = { kind: 'sequence', start: 7 } as const, rng = new Random(1, 'seq');
  expect([sampleInput(seq, rng), sampleInput(seq, rng)]).toEqual([7, 8]);
  expect(sampleInput(seq, new Random(1, 'seq'))).toBe(7);
  expect(renderKey('user:{userId}:{userId}', { userId: 42 })).toBe('user:42:42');
  expect(() => renderKey('{absent}', {})).toThrow('Missing key input');
  expect(sampleKey({ kind: 'sequential', n: 3 }, rng, 4)).toBe(1);
});

it('rejects hostile CSV and accepts only bounded numeric curves', () => {
  expect(parseReplayCsv('atUs,rps\r\n0,0\r\n1000000,1e3')).toEqual({ points: [{ atUs: 0, rps: 0 }, { atUs: 1e6, rps: 1000 }] });
  for (const input of ['', '0,NaN', '0,Infinity', '0,-1', '-1,5', '1,2\n0,2', '1,2\n1,3', '0,=SUM(1)', '0,+1', '0,@evil', '0,1;eval()', '0,1,2', '0,1e999', '0.1,1', '9'.repeat(1_048_577), Array.from({ length: 10001 }, (_, i) => `${i},1`).join('\n')]) expect(parseReplayCsv(input), input.slice(0, 40)).toHaveProperty('error');
});

it('converts 1B requests/day using an editable peak factor and returns fresh presets', () => {
  expect(toPeakRps(1e9, 3)).toEqual({ avgRps: 1e9 / 86400, peakRps: 1e9 / 86400 * 3 });
  expect(toPeakRps(1e9, 5).peakRps).toBeCloseTo(57870.37037);
  expect(() => toPeakRps(-1, 2)).toThrow(RangeError);
  expect(() => toPeakRps(1, NaN)).toThrow(RangeError);
  for (const preset of [launchDaySpike, diurnal, viralKey, ddos, batchBackfill]) { expect(preset('x').mix).toEqual({ x: 1 }); expect(preset()).not.toBe(preset()); }
});
