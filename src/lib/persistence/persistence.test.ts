import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDB, deleteDB } from "idb";
import { compressToEncodedURIComponent } from "lz-string";
import type { Design } from "../../engine/types";
import { cacheAsideDesign, noCacheDesign } from "../../engine/fixtures";
import {
  openStore, type Store, type DesignRecord, type RunRecord, type ProgressRecord,
  RevisionConflict, ImportError, ReadOnlyStoreError, StorageQuotaError, BackupTooLargeError,
  designSchema, mergeProgress, scheduleReview, autosave,
  exportDesign, exportAllDesigns, importAllDesigns, exportBackup, importDesign, restoreBackup, resetProgress, resetAllData,
  encodeShareLink, decodeShareLink, onExternalChange, DATABASE_VERSION, DESIGN_IMPORT_LIMIT, BACKUP_IMPORT_LIMIT,
} from "./index";

const stores: Store[] = [];
const names = new Set<string>();
const design: Design = {
  schemaVersion: 1, id: "draft", name: "Example", nodes: [{ id: "client", kind: "client", label: "Client", position: { x: 0, y: 1 }, params: { entry: "service" } }], edges: [], endpoints: [],
};
const rec = (id = "draft"): DesignRecord => ({ schemaVersion: 1, revision: 0, id, design: { ...design, id }, createdAt: 1, updatedAt: 1 });
const progress = (itemId = "objective"): ProgressRecord => ({ schemaVersion: 1, revision: 0, itemId, kind: "objective" });
const percentile = { p50: 1, p90: 2, p99: 3, p999: null };
const run = (designId = "draft"): RunRecord => ({
  schemaVersion: 1, revision: 0, id: "run", designId, createdAt: 1, replayCompatId: "v1",
  runKey: { engineVersion: "1", scenarioVersion: 1, designHash: "hash", seed: 1, settings: { traceSampleRate: 0.1 }, chaosTimeline: [], liveEditLog: [] },
  summary: { outcome: "finished", invariantCounts: {}, metrics: { offered: 10, admitted: 10, succeeded: 9, failed: 1, attempts: 10, unfinished: 0, retryAmplification: 1, goodput: 0.9, availability: 0.9, successLatency: percentile, allLatency: percentile, throughput: { offeredPerSec: 10, admittedPerSec: 10, completedPerSec: 10 }, costPerMonth: 1, statusCounts: { "200": 9, "503": 1 } } },
});
const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: "application/json" });
function name() { const value = `sds-test-${crypto.randomUUID()}`; names.add(value); return value; }
async function connect(dbName = name(), options: Parameters<typeof openStore>[0] = {}) {
  const store = await openStore({ ...options, name: dbName });
  stores.push(store);
  return store;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const dbName of names) {
    await deleteDB(dbName);
    await deleteDB(`${dbName}-backup-v1`);
  }
  names.clear();
});

describe("atomic storage", () => {
  it("serializes compare-and-put between two connections", async () => {
    const dbName = name();
    const [a, b] = await Promise.all([connect(dbName), connect(dbName)]);
    const saved = await a.designs.put(rec(), 0);
    const outcomes = await Promise.allSettled([
      a.designs.put({ ...saved, design: { ...saved.design, name: "A" } }, saved.revision),
      b.designs.put({ ...saved, design: { ...saved.design, name: "B" } }, saved.revision),
    ]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find(r => r.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(RevisionConflict);
  });

  it("quarantines corrupt records exactly once without throwing", async () => {
    const dbName = name();
    const store = await connect(dbName);
    const db = await openDB(dbName);
    await db.put("designs", { id: "bad", schemaVersion: 1, revision: 1, design: "bad" });
    db.close();
    expect(await store.designs.get("bad")).toBeUndefined();
    expect(await store.designs.list()).toEqual([]);
    const quarantine = await store.quarantine.list();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]).toMatchObject({ store: "designs", key: "bad", schemaVersion: 1, revision: 1 });
  });

  it("merges progress per stable ID by max, including concurrent tabs", async () => {
    const dbName = name();
    const a = await connect(dbName);
    const b = await connect(dbName);
    await Promise.all([
      a.progress.upsert({ ...progress(), mastery: 0.9, completedAt: 10, stars: 1 }),
      b.progress.upsert({ ...progress(), mastery: 0.3, completedAt: 20, stars: 3 }),
    ]);
    expect(await a.progress.get("objective")).toMatchObject({ mastery: 0.9, completedAt: 20, stars: 3 });
    expect(mergeProgress(undefined, progress())).not.toHaveProperty("completedAt");
    await a.progress.upsert(progress("new-objective"));
    expect(await a.progress.get("new-objective")).not.toHaveProperty("mastery");
  });

  it("increments an existing record's revision by exactly one", async () => {
    const store = await connect();
    const first = await store.designs.put(rec(), 0);
    await store.progress.upsert(progress());
    const second = await store.designs.put(first, first.revision);
    expect(second.revision).toBe(first.revision + 1);
  });

  it("notifies external changes over BroadcastChannel", async () => {
    vi.stubGlobal("window", {});
    const listener = vi.fn();
    const unsubscribe = onExternalChange(listener);
    const peer = new BroadcastChannel("sds-changes");
    try {
      peer.postMessage({ store: "designs", id: "external" });
      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ store: "designs", id: "external" }));
    } finally { unsubscribe(); peer.close(); }
  });

  it("keeps monotonic revisions after delete/recreate and strips raw run events", async () => {
    const store = await connect();
    const first = await store.designs.put(rec(), 0);
    await store.runs.add({ ...run(), rawEvents: ["not persisted"] } as RunRecord);
    expect((await store.runs.listForDesign("draft"))[0]).not.toHaveProperty("rawEvents");
    await store.designs.delete("draft");
    expect(await store.runs.listForDesign("draft")).toEqual([]);
    const second = await store.designs.put(rec(), 0);
    expect(second.revision).toBeGreaterThan(first.revision);
    await expect(store.designs.put(first, first.revision)).rejects.toBeInstanceOf(RevisionConflict);
  });

  it("surfaces quota errors as typed failures and rolls back", async () => {
    const store = await connect();
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      if (this.name === "designs") throw new DOMException("Full", "QuotaExceededError");
      return original.apply(this, args);
    });
    await expect(store.designs.put(rec(), 0)).rejects.toBeInstanceOf(StorageQuotaError);
    expect(await store.designs.list()).toEqual([]);
  });

  it("requests persistent storage only after the first meaningful save", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("navigator", { storage: { persist } });
    const store = await connect();
    expect(persist).not.toHaveBeenCalled();
    await store.designs.put(rec(), 0);
    await store.progress.upsert(progress());
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe("validation and transfers", () => {
  it.each([cacheAsideDesign, noCacheDesign])("preserves the shared $name engine fixture", fixture => {
    expect(designSchema.parse(fixture)).toEqual(fixture);
    expect(decodeShareLink(encodeShareLink(fixture)!)).toEqual({ ...fixture, id: expect.any(String) });
  });

  it("strips unknown fields at every graph level and enforces graph limits", () => {
    const parsed = designSchema.parse({ ...design, secret: true, nodes: [{ ...design.nodes[0], extra: true, params: { entry: "service", extra: true } }] });
    expect(parsed).not.toHaveProperty("secret");
    expect(parsed.nodes[0]).not.toHaveProperty("extra");
    expect(parsed.nodes[0].params).toEqual({ entry: "service" });
    expect(designSchema.safeParse({ ...design, nodes: Array(201).fill(design.nodes[0]) }).success).toBe(false);
    expect(designSchema.safeParse({ ...design, edges: Array(601).fill({ id: "edge", from: "a", to: "b", latency: { kind: "constant", us: 1 }, bandwidthBytesPerSec: 1, lossRate: 0 }) }).success).toBe(false);
  });

  it("round-trips exports to new draft IDs without overwriting originals", async () => {
    const store = await connect();
    const original = await store.designs.put(rec(), 0);
    const exported = await exportDesign(original.id, store);
    const imported = await importDesign(exported, store);
    expect(imported.id).not.toBe(original.id);
    expect(imported.design).toEqual({ ...original.design, id: imported.id });
    expect(await store.designs.get(original.id)).toEqual(original);
    const all = await exportAllDesigns(store);
    const imports = await importAllDesigns(all, store);
    expect(imports).toHaveLength(2);
    expect(await store.designs.list()).toHaveLength(4);
  });

  it("migrates supported older design schemas", async () => {
    const store = await connect();
    const imported = await importDesign(json({ ...design, schemaVersion: 0 }), store);
    expect(imported.design.schemaVersion).toBe(1);
  });

  it("rejects oversized, newer-version, wrong-type and deeply nested hostile imports", async () => {
    const store = await connect();
    const oversized = { size: DESIGN_IMPORT_LIMIT + 1, text: vi.fn() };
    await expect(importDesign(oversized, store)).rejects.toBeInstanceOf(ImportError);
    expect(oversized.text).not.toHaveBeenCalled();
    for (const value of [{ ...design, schemaVersion: 2 }, { type: "sds-backup", schemaVersion: 1 }, { ...design, nodes: "wrong" }, { type: "sds-design", schemaVersion: 1, design: { ...design, schemaVersion: 9 } }]) {
      await expect(importDesign(json(value), store)).rejects.toBeInstanceOf(ImportError);
    }
    await expect(importDesign(new Blob(['{"x":'.repeat(100) + '0' + '}'.repeat(100)]), store)).rejects.toBeInstanceOf(ImportError);
    await expect(restoreBackup({ size: BACKUP_IMPORT_LIMIT + 1, text: vi.fn() }, "replace", { store })).rejects.toBeInstanceOf(ImportError);
    expect(await store.designs.list()).toEqual([]);
  });
});

describe("share links", () => {
  it("round-trips to an unsaved new draft and handles unicode", () => {
    const original = { ...design, name: "বাংলা 🚀" };
    const hash = encodeShareLink(original)!;
    expect(hash.startsWith("#d=")).toBe(true);
    const decoded = decodeShareLink(hash);
    expect(decoded).toEqual({ ...original, id: expect.any(String) });
    expect("id" in decoded && decoded.id).not.toBe(original.id);
  });

  it("rejects malformed, oversized and bomb payloads during decompression", () => {
    const bomb = compressToEncodedURIComponent(JSON.stringify({ ...design, name: "x".repeat(500000) }));
    expect(bomb.length).toBeLessThan(8192);
    expect(decodeShareLink(`#d=${bomb}`)).toHaveProperty("error");
    for (const hash of ["", "#d=", "#d=%FF", "#d=AAAA", `#d=${"a".repeat(8193)}`, "#d=abc&analytics=1"]) expect(decodeShareLink(hash)).toHaveProperty("error");
    expect(encodeShareLink({ ...design, name: "x".repeat(65536) })).toBeNull();
  });

  it("decodes a range of lz-string dictionary widths", () => {
    for (let length = 1; length <= 8000; length *= 2) {
      const text = Array.from({ length }, (_, i) => String.fromCharCode(32 + ((i * 31 + i * i) % 90))).join("");
      const hash = encodeShareLink({ ...design, name: text });
      expect(hash).not.toBeNull();
      expect(decodeShareLink(hash!)).toMatchObject({ name: text });
    }
  });
});

describe("backup restore", () => {
  async function source() {
    const store = await connect();
    await store.designs.put(rec(), 0);
    await store.runs.add(run());
    await store.progress.upsert({ ...progress(), mastery: 0.8, completedAt: 10, stars: 1 });
    await store.reviews.record("objective", 1, 10);
    await store.settings.put({ id: "settings", schemaVersion: 1, revision: 0, theme: "light" });
    return exportBackup({ store });
  }

  it("merges with new IDs, remaps runs, maxes progress and unions reviews", async () => {
    const backup = await source();
    const target = await connect();
    await target.progress.upsert({ ...progress(), mastery: 0.9, completedAt: 5, stars: 3 });
    const currentReview = await target.reviews.record("objective", 4, 20);
    await target.settings.put({ id: "settings", schemaVersion: 1, revision: 0, theme: "dark" });
    const result = await restoreBackup(backup, "merge", { store: target });
    const id = result.idMap.draft;
    expect(id).not.toBe("draft");
    expect(await target.designs.get(id)).toMatchObject({ id, design: { id } });
    expect(await target.runs.listForDesign(id)).toHaveLength(1);
    expect((await target.runs.listForDesign(id))[0].id).not.toBe("run");
    expect(await target.progress.get("objective")).toMatchObject({ mastery: 0.9, completedAt: 10, stars: 3 });
    expect(await target.reviews.get("objective")).toEqual(currentReview);
    expect(await target.settings.get()).toMatchObject({ theme: "dark" });
    await restoreBackup(backup, "merge", { store: target, restoreSettings: true });
    expect(await target.settings.get()).toMatchObject({ theme: "light" });
  });

  it("replaces atomically, backs up first, preserves revision maxima and rejects stale tabs", async () => {
    const backup = await source();
    const dbName = name();
    const target = await connect(dbName);
    const staleTab = await connect(dbName);
    const first = await target.designs.put(rec("old"), 0);
    await staleTab.designs.get("old");
    const downloadBackup = vi.fn(async (file: Blob) => {
      expect(await target.designs.get("old")).toEqual(first);
      expect(JSON.parse(await file.text()).data.designs).toHaveLength(1);
    });
    const result = await restoreBackup(backup, "replace", { store: target, downloadBackup });
    expect(result.safetyBackup).toBeInstanceOf(Blob);
    expect(downloadBackup).toHaveBeenCalledOnce();
    expect(await target.designs.get("old")).toBeUndefined();
    const saved = (await target.designs.get("draft"))!;
    expect(saved.revision).toBeGreaterThan(first.revision);
    expect(saved.restoreGeneration).toBe(1);
    await expect(staleTab.designs.put(rec("another"), 0)).rejects.toBeInstanceOf(RevisionConflict);
    await expect(target.designs.put(first, first.revision)).rejects.toBeInstanceOf(RevisionConflict);
  });

  it("rejects invalid replace before any write or automatic download", async () => {
    const backup = JSON.parse(await (await source()).text());
    backup.data.designs.push({ id: "invalid" });
    const target = await connect();
    const original = await target.designs.put(rec("keep"), 0);
    const downloadBackup = vi.fn();
    await expect(restoreBackup(json(backup), "replace", { store: target, downloadBackup })).rejects.toBeInstanceOf(ImportError);
    expect(await target.designs.list()).toEqual([original]);
    expect(await target.quarantine.list()).toEqual([]);
    expect(downloadBackup).not.toHaveBeenCalled();
  });

  it("rolls back clears and partial writes if the replace transaction fails", async () => {
    const backup = await source();
    const target = await connect();
    const original = await target.designs.put(rec("keep"), 0);
    const originalPut = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof originalPut>) {
      if (this.name === "runs") throw new DOMException("Full", "QuotaExceededError");
      return originalPut.apply(this, args);
    });
    await expect(restoreBackup(backup, "replace", { store: target })).rejects.toBeInstanceOf(StorageQuotaError);
    spy.mockRestore();
    expect(await target.designs.list()).toEqual([original]);
    expect(await target.progress.all()).toEqual([]);
    expect(await target.quarantine.list()).toEqual([]);
  });

  it("quarantines invalid merge records and orphaned runs", async () => {
    const backup = JSON.parse(await (await source()).text());
    backup.data.designs = [];
    backup.data.progress.push({ itemId: "bad", mastery: "wrong" });
    const target = await connect();
    const result = await restoreBackup(json(backup), "merge", { store: target });
    expect(result.quarantined).toBe(2);
    expect(await target.quarantine.list()).toHaveLength(2);
    expect(await target.runs.listForDesign("draft")).toEqual([]);
    expect(await target.progress.get("objective")).toMatchObject({ mastery: 0.8 });
  });

  it("exports backups without runs on request", async () => {
    const store = await connect();
    await store.designs.put(rec(), 0);
    await store.runs.add(run());
    const result = JSON.parse(await (await exportBackup({ store, withoutRuns: true })).text());
    expect(result.data.runs).toEqual([]);
    expect(result.data.designs).toHaveLength(1);
  });

  it("keeps orphaned run data in quarantine so exported backups remain importable", async () => {
    const source = await connect();
    await source.runs.add(run("unsaved"));
    const backup = await exportBackup({ store: source });
    const target = await connect();
    await restoreBackup(backup, "replace", { store: target });
    expect(await target.runs.listForDesign("unsaved")).toEqual([]);
    expect(await target.quarantine.list()).toMatchObject([{ store: "runs", key: "run" }]);
  });

  it("refuses oversized backup output and offers export without runs", async () => {
    const store = await connect();
    const NativeBlob = Blob;
    vi.stubGlobal("Blob", class extends NativeBlob { get size() { return BACKUP_IMPORT_LIMIT + 1; } });
    await expect(exportBackup({ store })).rejects.toMatchObject({ name: "BackupTooLargeError", offerWithoutRuns: true });
    await expect(exportBackup({ store })).rejects.toBeInstanceOf(BackupTooLargeError);
  });

  it("aborts a replace if a tab saves while the automatic backup is being downloaded", async () => {
    const backup = await source();
    const target = await connect();
    const saved = await target.designs.put(rec("keep"), 0);
    await expect(restoreBackup(backup, "replace", { store: target, downloadBackup: async () => {
      await target.designs.put({ ...saved, design: { ...saved.design, name: "new edit" } }, saved.revision);
    } })).rejects.toBeInstanceOf(RevisionConflict);
    expect((await target.designs.get("keep"))?.design.name).toBe("new edit");
  });

  it("requires typed confirmation for resets and preserves an export first", async () => {
    const store = await connect();
    await store.designs.put(rec(), 0);
    await store.progress.upsert(progress());
    await store.reviews.record("objective", 1);
    await expect(resetProgress("wrong", { store })).rejects.toBeInstanceOf(ImportError);
    expect(await store.progress.all()).toHaveLength(1);
    const backup = await resetProgress("RESET PROGRESS", { store });
    expect(JSON.parse(await backup.text()).data.progress).toHaveLength(1);
    expect(await store.progress.all()).toEqual([]);
    expect(await store.reviews.all()).toEqual([]);
    expect(await store.designs.list()).toHaveLength(1);
    await expect(resetAllData("wrong", { store })).rejects.toBeInstanceOf(ImportError);
    const result = await resetAllData("RESET ALL DATA", { store });
    expect(result.safetyBackup).toBeInstanceOf(Blob);
    expect(await store.designs.list()).toEqual([]);
  });
});

describe("database lifecycle and fallback", () => {
  it("provides a complete memory fallback when storage is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const onFallback = vi.fn();
    const store = await connect(name(), { onFallback });
    expect(store.persistent).toBe(false);
    expect(onFallback).toHaveBeenCalledOnce();
    const saved = await store.designs.put(rec(), 0);
    expect(await store.designs.get("draft")).toEqual(saved);
    await expect(store.designs.put(saved, 0)).rejects.toBeInstanceOf(RevisionConflict);
    const backup = await exportBackup({ store });
    await restoreBackup(backup, "replace", { store });
    expect(await store.designs.list()).toHaveLength(1);
  });

  it("opens newer databases as a read-only memory snapshot", async () => {
    const dbName = name();
    const initial = await connect(dbName);
    const saved = await initial.designs.put(rec(), 0);
    initial.close();
    const newer = await openDB(dbName, DATABASE_VERSION + 1);
    newer.close();
    const store = await connect(dbName);
    expect(store.persistent).toBe(false);
    expect(store.readOnly).toBe(true);
    expect(await store.designs.get("draft")).toEqual(saved);
    await expect(store.designs.put(rec("blocked"), 0)).rejects.toBeInstanceOf(ReadOnlyStoreError);
    const db = await openDB(dbName);
    expect(await db.get("designs", "draft")).toEqual(saved);
    db.close();
  });

  it("commits a backup before migrating the live database", async () => {
    const dbName = name();
    const old = await openDB(dbName, 1, { upgrade(db) { db.createObjectStore("designs", { keyPath: "id" }); } });
    await old.put("designs", { ...rec(), schemaVersion: 0 });
    old.close();
    const store = await connect(dbName);
    expect(store.persistent).toBe(true);
    expect(await store.designs.get("draft")).toMatchObject({ schemaVersion: 1 });
    const backup = await openDB(`${dbName}-backup-v1`);
    expect(await backup.get("designs", "draft")).toMatchObject({ schemaVersion: 0 });
    backup.close();
  });

  it("closes on versionchange and invokes the update callback", async () => {
    const dbName = name();
    const onVersionChange = vi.fn();
    await connect(dbName, { onVersionChange });
    const upgraded = await openDB(dbName, DATABASE_VERSION + 1);
    expect(onVersionChange).toHaveBeenCalledOnce();
    upgraded.close();
  });

  it("notifies blocked upgrades so another tab can be closed", async () => {
    const dbName = name();
    const blocker = await openDB(dbName, 1, { upgrade(db) { db.createObjectStore("designs", { keyPath: "id" }); } });
    const onBlocked = vi.fn(() => blocker.close());
    const store = await connect(dbName, { onBlocked });
    expect(onBlocked).toHaveBeenCalledOnce();
    expect(store.persistent).toBe(true);
  });

  it("falls back to a memory snapshot when another tab keeps an upgrade blocked", async () => {
    const dbName = name();
    const blocker = await openDB(dbName, 1, { upgrade(db) { db.createObjectStore("designs", { keyPath: "id" }); } });
    await blocker.put("designs", rec());
    const onBlocked = vi.fn();
    const store = await connect(dbName, { onBlocked });
    expect(store.persistent).toBe(false);
    expect(await store.designs.get("draft")).toMatchObject({ id: "draft" });
    expect(onBlocked).toHaveBeenCalledOnce();
    blocker.close();
  });

  it("retains the backup and old schema after a failed migration", async () => {
    const dbName = name();
    const old = await openDB(dbName, 1, { upgrade(db) { db.createObjectStore("designs", { keyPath: "id" }); } });
    await old.put("designs", rec());
    old.close();
    const create = IDBDatabase.prototype.createObjectStore;
    vi.spyOn(IDBDatabase.prototype, "createObjectStore").mockImplementation(function (this: IDBDatabase, ...args: Parameters<typeof create>) {
      if (this.name === dbName && this.version === DATABASE_VERSION && args[0] === "quarantine") throw new DOMException("Migration failure", "AbortError");
      return create.apply(this, args);
    });
    const store = await connect(dbName);
    expect(store.persistent).toBe(false);
    expect(await store.designs.get("draft")).toMatchObject({ id: "draft" });
    const db = await openDB(dbName);
    expect(db.version).toBe(1);
    expect(db.objectStoreNames.contains("quarantine")).toBe(false);
    db.close();
    const backup = await openDB(`${dbName}-backup-v1`);
    expect(await backup.get("designs", "draft")).toMatchObject({ id: "draft" });
    backup.close();
  });
});

describe("review and autosave", () => {
  it("schedules missed objectives and SM-2 intervals on stable IDs", async () => {
    const store = await connect();
    const first = await store.reviews.record("objective", 1, 0);
    expect(first.dueAt).toBe(86400000);
    expect(await store.reviews.due(0)).toEqual([]);
    expect(await store.reviews.due(86400000)).toHaveLength(1);
    const success = await store.reviews.record("objective", 5, 86400000);
    const second = scheduleReview(success, "objective", 5, 2 * 86400000);
    expect(second.intervalDays).toBe(6);
    expect(scheduleReview(second, "objective", 0).repetitions).toBe(0);
  });

  it("debounces 800 ms and retains the latest edit", async () => {
    const store = await connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const save = autosave("draft", { store });
    save.schedule(design);
    await vi.advanceTimersByTimeAsync(700);
    expect(await store.designs.get("draft")).toBeUndefined();
    save.schedule({ ...design, name: "latest" });
    await vi.advanceTimersByTimeAsync(799);
    expect(save.status).toBe("saving");
    await save.flush();
    expect(save.status).toBe("saved");
    expect((await store.designs.get("draft"))?.design.name).toBe("latest");
    save.dispose();
  });

  it("exposes failed saves and retries without losing the draft", async () => {
    const store = await connect();
    const save = autosave("draft", { store });
    vi.spyOn(store.designs, "put").mockRejectedValueOnce(new Error("temporary failure"));
    save.schedule(design);
    await save.flush();
    expect(save.status).toBe("error");
    await save.retry();
    expect(save.status).toBe("saved");
    expect(await store.designs.get("draft")).toBeDefined();
    save.dispose();
  });

  it("only prompts before unloading while a save is pending or failed", async () => {
    const store = await connect();
    let beforeUnload: ((event: BeforeUnloadEvent) => void) | undefined;
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener: (_name: string, listener: typeof beforeUnload) => { beforeUnload = listener; }, removeEventListener });
    const save = autosave("draft", { store });
    const event = { preventDefault: vi.fn(), returnValue: undefined };
    beforeUnload!(event as unknown as BeforeUnloadEvent);
    expect(event.preventDefault).not.toHaveBeenCalled();
    save.schedule(design);
    beforeUnload!(event as unknown as BeforeUnloadEvent);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    vi.spyOn(store.designs, "put").mockRejectedValueOnce(new Error("temporary failure"));
    await save.flush();
    beforeUnload!(event as unknown as BeforeUnloadEvent);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    await save.retry();
    beforeUnload!(event as unknown as BeforeUnloadEvent);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    save.dispose();
    expect(removeEventListener).toHaveBeenCalledWith("beforeunload", beforeUnload);
    // Close the notification channel opened by the successful save.
    onExternalChange(() => {})();
  });
});
