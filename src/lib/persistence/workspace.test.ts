import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import type { Store } from "./store";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.unstubAllGlobals(); });
it("isolates account workspaces and preserves guest data without uploading it", async () => {
  const local = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => local.set(k, v) });
  const workspace = async (id: string | null) => {
    vi.resetModules();
    vi.stubGlobal("fetch", async () => Response.json(id ? { user: { id } } : null));
    const { openStore } = await import("./store");
    const store = await openStore();
    stores.push(store);
    return store;
  };
  const guest = await workspace(null);
  await guest.progress.upsert({ schemaVersion: 1, revision: 0, itemId: "guest-only", kind: "lesson", mastery: 1 });
  const idA = crypto.randomUUID(), idB = crypto.randomUUID();
  const a = await workspace(idA);
  expect(await a.progress.all()).toEqual([]);
  await a.progress.upsert({ schemaVersion: 1, revision: 0, itemId: "A-only", kind: "lesson", mastery: 1 });
  const b = await workspace(idB);
  expect(await b.progress.all()).toEqual([]);
  expect((await (await workspace(idA)).progress.all()).map(r => r.itemId)).toEqual(["A-only"]);
  expect((await (await workspace(null)).progress.all()).map(r => r.itemId)).toEqual(["guest-only"]);
});
