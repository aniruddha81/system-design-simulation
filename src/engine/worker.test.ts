import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulation, runToCompletion } from './index';
import { cacheAsideDesign, cachingScenario } from './fixtures';
import type { FromWorker, ToWorker } from './types';

type WorkerScope = { onmessage: (event: { data: ToWorker }) => void };
const scope = globalThis as unknown as WorkerScope;
const messages: FromWorker[] = [];
const send = (data: ToWorker) => scope.onmessage({ data });
const scenario = { ...cachingScenario, warmupUs: 10000, measureUs: 100000, drainUs: 500000, chaos: [] };
const start = (speed: .1 | 1 | 10 | 'max' = 'max'): ToWorker => ({ type: 'start', design: cacheAsideDesign, scenario, seed: 3, settings: { traceSampleRate: 1 }, speed });

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); messages.length = 0;
  vi.stubGlobal('postMessage', (message: FromWorker) => messages.push(message));
  await import('./engine.worker');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('worker protocol', () => {
  it('validates before starting and answers ping', () => {
    const input = start();
    if (input.type !== 'start') throw new Error('start input');
    input.design = { ...cacheAsideDesign, nodes: [] }; send(input);
    expect(messages[0].type).toBe('invalid');
    send({ type: 'ping' }); expect(messages[1].type).toBe('pong');
  });
  it.each([.1, 1, 10, 'max'] as const)('speed %s finishes with the same deterministic result', async speed => {
    send(start(speed)); await vi.runAllTimersAsync();
    const done = messages.find((m): m is Extract<FromWorker, { type: 'done' }> => m.type === 'done');
    expect(done?.result).toEqual(runToCompletion(cacheAsideDesign, scenario, 3, { traceSampleRate: 1 }));
    expect(messages.some(m => m.type === 'snapshot' && m.snapshot.packets.length > 0)).toBe(true);
    if (speed === .1) expect(messages.some(m => m.type === 'heartbeat')).toBe(true);
  });
  it('pauses, steps one event and 1ms, changes speed and resumes', async () => {
    send(start(1)); send({ type: 'pause' }); await vi.advanceTimersByTimeAsync(50);
    expect(messages.filter(m => m.type === 'snapshot')).toHaveLength(0);
    send({ type: 'step', by: 'event' });
    let snapshots = messages.filter((m): m is Extract<FromWorker, { type: 'snapshot' }> => m.type === 'snapshot');
    expect(snapshots).toHaveLength(1); const firstTime = snapshots[0].snapshot.simTimeUs;
    send({ type: 'step', by: '1ms' }); await vi.runAllTimersAsync();
    snapshots = messages.filter((m): m is Extract<FromWorker, { type: 'snapshot' }> => m.type === 'snapshot');
    expect(snapshots.at(-1)!.snapshot.simTimeUs).toBe(firstTime + 1000);
    send({ type: 'setSpeed', speed: 'max' }); send({ type: 'resume' }); await vi.runAllTimersAsync();
    expect(messages.some(m => m.type === 'done')).toBe(true);
  });
  it('replays exactly to a cursor and resumes to an identical result', async () => {
    const sim = createSimulation(cacheAsideDesign, scenario, 3, { traceSampleRate: 1 });
    sim.advance({ maxEvents: 100 }); const target = sim.snapshot().cursor;
    send(start()); send({ type: 'pause' }); send({ type: 'replayTo', cursor: target }); await vi.runAllTimersAsync();
    const snapshots = messages.filter((m): m is Extract<FromWorker, { type: 'snapshot' }> => m.type === 'snapshot');
    expect(snapshots.at(-1)!.snapshot.cursor).toEqual(target);
    send({ type: 'resume' }); await vi.runAllTimersAsync();
    const done = messages.find((m): m is Extract<FromWorker, { type: 'done' }> => m.type === 'done');
    expect(done?.result).toEqual(runToCompletion(cacheAsideDesign, scenario, 3, { traceSampleRate: 1 }));
  });
});
