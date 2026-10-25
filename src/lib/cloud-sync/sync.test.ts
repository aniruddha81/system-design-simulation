import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { check, type PushRecord } from "../../server/sync-validate";
import { openStore, type DesignRecord, type Store } from "../persistence";
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

const stores: Store[] = [];
// Each device has its own IndexedDB and its own localStorage (sync cursor).
const local = new Map<Store, Map<string, string>>();
const device = async () => {
  const s = await openStore({ name: `sds-sync-${crypto.randomUUID()}` });
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
  it("mirrors progress and designs between two devices, propagates deletes, and settles", async () => {
    const server = fakeServer();
    vi.stubGlobal("fetch", server.handler);
    const a = await device();
    const b = await device();

    await a.progress.upsert({ schemaVersion: 1, revision: 0, itemId: "lesson:caching", kind: "lesson", mastery: 0.9 });
    await a.designs.put(design("d1"), 0);
    await sync(a);
    await sync(b);
    expect((await b.progress.get("lesson:caching"))?.mastery).toBe(0.9);
    expect((await b.designs.get("d1"))?.design.name).toBe("d1");

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
  });
});
