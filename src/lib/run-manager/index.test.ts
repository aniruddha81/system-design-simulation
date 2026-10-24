import { afterEach, expect, it, vi } from "vitest";
import { cacheAsideDesign, cachingScenario } from "@/engine/fixtures";
import type { FromWorker, LiveEdit, ToWorker } from "@/engine/types";
import { close, liveEdit, replayTo, start, useRuns } from "./index";

class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: ToWorker[] = [];
  onmessage?: (event: { data: FromWorker }) => void;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: ToWorker) { this.messages.push(message); }
  terminate() {}
  emit(data: FromWorker) { this.onmessage?.({ data }); }
}

afterEach(() => {
  close("test");
  useRuns.setState({}, true);
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

it("tracks edit acknowledgements and replays their cursors without cancelling replay", () => {
  vi.stubGlobal("Worker", FakeWorker);
  start("test", { design: cacheAsideDesign, scenario: cachingScenario, seed: 42 });
  const worker = FakeWorker.instances[0];
  const edit: LiveEdit = { nodeId: "svc1", path: "concurrency", value: 32, cursor: { timeUs: 100, seq: 5 } };
  liveEdit("test", [edit], "edited-hash");
  expect(worker.messages.at(-1)).toMatchObject({ type: "liveEdit", nodeId: "svc1", value: 32 });
  expect(useRuns.getState().test.edits[0].state).toBe("pending");
  worker.emit({ type: "editAck", edit });
  expect(useRuns.getState().test.edits[0]).toMatchObject({ state: "acked", atUs: 100 });
  expect(useRuns.getState().test.editLog).toEqual([edit]);

  // The display history is bounded; the replay log must keep all acknowledged edits.
  for (let i = 0; i < 35; i++) {
    liveEdit("test", [{ ...edit, value: i }], "edited-hash");
    worker.emit({ type: "editAck", edit: { ...edit, value: i, cursor: { timeUs: 101 + i, seq: 6 + i } } });
  }
  expect(useRuns.getState().test.edits).toHaveLength(30);
  expect(useRuns.getState().test.editLog).toHaveLength(36);
  const cursor = { timeUs: 200, seq: 50 };
  replayTo("test", cursor);
  const replay = FakeWorker.instances.at(-1)!;
  expect(replay.messages.map((m) => m.type)).toEqual(["start", "replayTo", "setSpeed"]);
  expect(replay.messages[0]).toMatchObject({ type: "start", liveEditLog: useRuns.getState().test.editLog });
  expect(replay.messages[1]).toEqual({ type: "replayTo", cursor });
  expect(useRuns.getState().test.designHash).toBe("edited-hash");
});

it("keeps rejected edits out of deterministic replay and marks results mismatched", () => {
  vi.stubGlobal("Worker", FakeWorker);
  start("test", { design: cacheAsideDesign, scenario: cachingScenario, seed: 42 });
  liveEdit("test", [{ nodeId: "svc1", path: "concurrency", value: 0 }], "edited-hash");
  FakeWorker.instances[0].emit({ type: "editRejected", nodeId: "svc1", path: "concurrency", reason: "Invalid concurrency" });
  expect(useRuns.getState().test.edits[0]).toMatchObject({ state: "rejected", reason: "Invalid concurrency" });
  expect(useRuns.getState().test.editLog).toEqual([]);
  expect(useRuns.getState().test.designHash).toMatch(/^rejected:/);
});
