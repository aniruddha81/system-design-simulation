import { createSimulation, validateDesign } from './index';
import type { FromWorker, Packet, Simulation, Speed, ToWorker } from './types';

// A structural worker scope keeps this module type-checkable without DOM imports.
const scope = globalThis as unknown as { postMessage(message: FromWorker): void; onmessage: ((event: { data: ToWorker }) => void) | null };
let simulation: Simulation | undefined;
let inputs: Extract<ToWorker, { type: 'start' }> | undefined;
let speed: Speed = 'max';
let paused = true, doneSent = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let anchorWall = 0, anchorSim = 0, heartbeatAt = 0;
let currentTime = 0;
let generation = 0;
const post = (message: FromWorker) => scope.postMessage(message);
const anchor = () => { anchorWall = performance.now(); anchorSim = currentTime; };
const emit = () => {
  if (!simulation) return;
  const snapshot = simulation.snapshot();
  currentTime = snapshot.simTimeUs;
  post({ type: 'snapshot', snapshot });
};
function tick() {
  timer = undefined;
  if (paused || !simulation) return;
  try {
    const untilUs = speed === 'max' ? undefined : anchorSim + Math.floor((performance.now() - anchorWall) * 1000 * speed);
    const state = simulation.advance({ maxWallMs: 8, untilUs });
    emit();
    if (performance.now() - heartbeatAt >= 1000) { post({ type: 'heartbeat' }); heartbeatAt = performance.now(); }
    if (state === 'done') { paused = true; if (!doneSent) { doneSent = true; post({ type: 'done', result: simulation.result() }); } }
    else timer = setTimeout(tick, speed === 'max' ? 0 : 8);
  } catch (error) { paused = true; post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
}
function cancelScheduled() { generation++; if (timer) clearTimeout(timer); timer = undefined; }
function resume() { if (!simulation || doneSent) return; cancelScheduled(); paused = false; anchor(); timer = setTimeout(tick, 0); }
scope.onmessage = ({ data }) => {
  try {
    switch (data.type) {
      case 'start': {
        paused = true; cancelScheduled(); simulation = undefined;
        const issues = validateDesign(data.design, data.scenario);
        if (issues.length) { post({ type: 'invalid', issues }); return; }
        inputs = data; speed = data.speed; doneSent = false; currentTime = 0;
        simulation = createSimulation(data.design, data.scenario, data.seed, data.settings);
        post({ type: 'started', runKey: simulation.result().runKey }); heartbeatAt = performance.now(); resume(); break;
      }
      case 'pause': paused = true; cancelScheduled(); break;
      case 'resume': resume(); break;
      case 'setSpeed': speed = data.speed; anchor(); break;
      case 'step': {
        paused = true;
        if (!simulation || doneSent) return;
        cancelScheduled();
        const thisGeneration = generation, target = currentTime + 1000;
        const stepSlice = () => {
          timer = undefined;
          if (!simulation || thisGeneration !== generation) return;
          const state = simulation.advance(data.by === 'event' ? { maxEvents: 1, maxWallMs: 8 } : { untilUs: target, maxWallMs: 8 });
          emit();
          if (state === 'done') { doneSent = true; post({ type: 'done', result: simulation.result() }); }
          else if (data.by === '1ms' && currentTime < target) timer = setTimeout(stepSlice, 0);
        };
        stepSlice();
        break;
      }
      case 'replayTo': {
        if (!inputs) return;
        cancelScheduled();
        paused = true; doneSent = false;
        simulation = createSimulation(inputs.design, inputs.scenario, inputs.seed, inputs.settings);
        currentTime = 0;
        const target = data.cursor;
        const thisGeneration = generation;
        const replayPackets: Packet[] = [];
        const replaySlice = () => {
          timer = undefined;
          if (!simulation || thisGeneration !== generation) return;
          const started = performance.now();
          while (performance.now() - started < 8) {
            const snapshot = simulation.snapshot(), cursor = snapshot.cursor;
            replayPackets.push(...snapshot.packets);
            if (replayPackets.length > 10000) replayPackets.splice(0, replayPackets.length - 10000);
            currentTime = snapshot.simTimeUs;
            if (cursor.timeUs === target.timeUs && cursor.seq === target.seq) { post({ type: 'snapshot', snapshot: { ...snapshot, packets: replayPackets } }); return; }
            const state = simulation.advance({ maxEvents: 1, untilUs: target.timeUs });
            const after = simulation.snapshot();
            replayPackets.push(...after.packets);
            if ((after.cursor.timeUs === cursor.timeUs && after.cursor.seq === cursor.seq) || state === 'done') {
              currentTime = after.simTimeUs;
              post({ type: 'snapshot', snapshot: { ...after, packets: replayPackets.slice(-10000) } }); return;
            }
          }
          timer = setTimeout(replaySlice, 0);
        };
        timer = setTimeout(replaySlice, 0); break;
      }
      case 'ping': post({ type: 'pong' }); break;
    }
  } catch (error) { post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
