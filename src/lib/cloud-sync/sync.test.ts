import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { check, type PushRecord } from "../../server/sync-validate";
import { openStore, type DesignRecord, type RunRecord, type Store } from "../persistence";
import { syncNow } from "./sync";

// In-memory stand-in for /api/sync with the same rules as the SQL: last-write-wins, no-op pushes keep their seq.
function fakeServer() {
  const rows = new Map<string, { store: string; key: string; data: unknown; updatedAt: number; deleted: boolean; seq: number }>();
  let seq = 0;
  const handler = async (url: string, init?: RequestInit) => {
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response;
    if (init?.method === "POST") {
      let accepted = 0;
      for (const rec of JSON.parse(init.body as string).records as PushRecord[]) {
        const c = check(rec);
        if (typeof c === "string") continue;
        accepted++;
        const id = `${c.store}/${c.key}`;
        const old = rows.get(id);
        const same = old && JSON.stringify(old.data) === JSON.stringify(c.data) && old.deleted === c.deleted;
        if (old && (c.updatedAt < old.updatedAt || same)) continue;
        rows.set(id, { store: c.store, key: c.key, data: c.data, updatedAt: c.updatedAt, deleted: c.deleted, seq: ++seq });
      }
      return json({ accepted, rejected: [] });
    }
    const since = Number(new URL(url, "http://x").searchParams.get("since"));
    const records = [...rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
    return json({ records, cursor: records.at(-1)?.seq ?? since, hasMore: false });
  };
  return { handler, seq: () => seq };
}

const design = (id: string, updatedAt = 1): DesignRecord => ({
  schemaVersion: 1, revision: 0, id, createdAt: 1, updatedAt,
  design: { schemaVersion: 1, id, name: id, nodes: [{ id: "c", kind: "client", label: "Client", position: { x: 0, y: 0 }, params: { entry: "s" } }], edges: [], endpoints: [] },
});

const pct = { p50: 1, p90: 2, p99: 3, p999: null };
const run = (designId: string): RunRecord => ({
  schemaVersion: 1, revision: 0, id: "run1", designId, createdAt: 1, replayCompatId: "v1",
  runKey: { engineVersion: "1", scenarioVersion: 1, designHash: "h", seed: 1, settings: { traceSampleRate: 0.1 }, chaosTimeline: [], liveEditLog: [] },
  summary: { outcome: "finished", invariantCounts: {}, metrics: { offered: 10, admitted: 10, succeeded: 9, failed: 1, attempts: 10, unfinished: 0, retryAmplification: 1, goodput: 0.9, availability: 0.9, successLatency: pct, allLatency: pct, throughput: { offeredPerSec: 10, admittedPerSec: 10, completedPerSec: 10 }, costPerMonth: 1, statusCounts: { "200": 9, "503": 1 } } },
});

const stores: Store[] = [];
// Each device has its own IndexedDB and its own localStorage (sync cursor).
const local = new Map<Store, Map<string, string>>();
const device = async () => {
  const s = await openStore({ name: `sds-sync-${crypto.randomUUID()}`, userId: "u1" });
  stores.push(s);
  local.set(s, new Map());
  return s;
};
const sync = (s: Store) => {
  const mem = local.get(s)!;
  vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
  return syncNow(s, "u1");
};
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.unstubAllGlobals();
});

describe("cloud sync", () => {
  it("rejects another account's local records before making a request", async () => {
    const a = await device();
    await a.designs.put(design("private-A"), 0);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(syncNow(a, "u2")).rejects.toThrow("another account");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("binds requests to the initiating account and stops before applying an aborted pull", async () => {
    const a = await device();
    const controller = new AbortController();
    const apply = vi.spyOn(a.remote, "apply");
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("x-sds-user")).toBe("u1");
      controller.abort();
      return Response.json({ records: [], cursor: 0, hasMore: false });
    });
    await expect(syncNow(a, "u1", controller.signal)).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
  });
  it("mirrors progress and designs between two devices, propagates deletes, and settles", async () => {
    const server = fakeServer();
    vi.stubGlobal("fetch", server.handler);
    const a = await device();
    const b = await device();

    await a.progress.upsert({ schemaVersion: 1, revision: 0, itemId: "lesson:caching", kind: "lesson", mastery: 0.9 });
    await a.designs.put(design("d1"), 0);
    await a.runs.add(run("d1"));
    await sync(a);
    await sync(b);
    expect((await b.progress.get("lesson:caching"))?.mastery).toBe(0.9);
    expect((await b.designs.get("d1"))?.design.name).toBe("d1");
    expect((await b.runs.listForDesign("d1")).map((r) => r.id)).toEqual(["run1"]);

    // Settled: more rounds on both devices change nothing on the server (no ping-pong).
    await sync(b);
    await sync(a);
    await sync(b);
    const settled = server.seq();
    await sync(a);
    await sync(b);
    expect(server.seq()).toBe(settled);

    // Progress never goes backwards: a lower mastery from the other device is max-merged.
    await b.progress.upsert({ schemaVersion: 1, revision: 0, itemId: "lesson:caching", kind: "lesson", mastery: 0.5 });
    await sync(b);
    await sync(a);
    expect((await a.progress.get("lesson:caching"))?.mastery).toBe(0.9);

    await b.designs.delete("d1");
    await sync(b);
    await sync(a);
    expect(await a.designs.get("d1")).toBeUndefined();
    expect(await a.runs.listForDesign("d1")).toEqual([]);
  });
});
