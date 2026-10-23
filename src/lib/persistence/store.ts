import { openDB, type IDBPDatabase } from "idb";
import {
  STORE_NAMES, keyPaths, recordSchemas, mergeProgress, scheduleReview, newId,
  RevisionConflict, ReadOnlyStoreError, StorageQuotaError,
  type Records, type StoreName, type DesignRecord, type ProgressRecord, type RunRecord,
  type ReviewRecord, type SettingsRecord, type MetaRecord,
} from "./schemas";

export const DATABASE_VERSION = 2;
export type OpenStoreOptions = {
  name?: string;
  onVersionChange?: () => void;
  onBlocked?: () => void;
  onFallback?: (reason: string) => void;
};
type Key = string | number;
export interface Transaction {
  get(store: StoreName, key: Key): Promise<unknown>;
  entries(store: StoreName): Promise<[Key, unknown][]>;
  put(store: StoreName, value: unknown): Promise<void>;
  delete(store: StoreName, key: Key): Promise<void>;
  clear(store: StoreName): Promise<void>;
}
type Snapshot = Partial<Record<StoreName, [Key, unknown][]>>;
type Backend = { transaction<T>(names: StoreName[], body: (tx: Transaction) => Promise<T>): Promise<T>; close(): void };
const initialMeta = (): MetaRecord => ({ id: "state", schemaVersion: 1, revision: 0, restoreGeneration: 0, designRevisions: {} });

function migrateRecord(name: StoreName, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  let result = record;
  if (record.schemaVersion === 0 || record.schemaVersion === undefined) result = { ...record, schemaVersion: 1, revision: record.revision ?? 0 };
  if (name === "designs" && result.design && typeof result.design === "object" && "schemaVersion" in result.design && result.design.schemaVersion === 0) result = { ...result, design: { ...result.design, schemaVersion: 1 } };
  return result;
}

async function connectDatabase(name: string, version: number | undefined, options: Parameters<typeof openDB>[2], onBlocked?: () => void): Promise<IDBPDatabase> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abandoned = false;
  const blocked = new Promise<never>((_resolve, reject) => {
    options = { ...options, blocked() {
      onBlocked?.();
      timer = setTimeout(() => { abandoned = true; reject(new Error("Database upgrade is blocked.")); }, 1000);
    } };
  });
  const opening = openDB(name, version, options);
  void opening.then(db => { if (abandoned) db.close(); }).catch(() => {});
  try { return await Promise.race([opening, blocked]); }
  finally { if (timer) clearTimeout(timer); }
}

function memoryBackend(snapshot: Snapshot): Backend {
  let data = new Map(STORE_NAMES.map(name => [name, new Map(snapshot[name] ?? [])]));
  let tail: Promise<unknown> = Promise.resolve();
  return {
    close() {},
    transaction<T>(_names: StoreName[], body: (tx: Transaction) => Promise<T>) {
      const next = tail.then(async () => {
        const copy = structuredClone(data);
        const tx: Transaction = {
          async get(name, key) { return copy.get(name)!.get(key); },
          async entries(name) { return [...copy.get(name)!]; },
          async put(name, value) {
            const key = (value as Record<string, Key>)[keyPaths[name]];
            copy.get(name)!.set(key, structuredClone(value));
          },
          async delete(name, key) { copy.get(name)!.delete(key); },
          async clear(name) { copy.get(name)!.clear(); },
        };
        const result = await body(tx);
        data = copy;
        return structuredClone(result);
      });
      tail = next.catch(() => {});
      return next;
    },
  };
}

function indexedBackend(db: IDBPDatabase): Backend {
  return {
    close() { db.close(); },
    async transaction(names, body) {
      const transaction = db.transaction(names, "readwrite");
      // Observe completion immediately: an aborted request can reject before body unwinds.
      const done = transaction.done;
      void done.catch(() => {});
      const tx: Transaction = {
        async get(name, key) { return transaction.objectStore(name).get(key); },
        async entries(name) {
          const store = transaction.objectStore(name);
          const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()]);
          return keys.map((key, index) => [key as Key, values[index]]);
        },
        async put(name, value) { await transaction.objectStore(name).put(value); },
        async delete(name, key) { await transaction.objectStore(name).delete(key); },
        async clear(name) { await transaction.objectStore(name).clear(); },
      };
      try {
        const result = await body(tx);
        await done;
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* Already aborted or committed. */ }
        await done.catch(() => {});
        if (error instanceof Error && error.name === "QuotaExceededError") throw new StorageQuotaError();
        throw error;
      }
    },
  };
}

async function snapshotDatabase(db: IDBPDatabase): Promise<Snapshot> {
  const names = STORE_NAMES.filter(name => db.objectStoreNames.contains(name));
  if (!names.length) return {};
  const tx = db.transaction(names, "readonly");
  const snapshot: Snapshot = {};
  await Promise.all(names.map(async name => {
    const [keys, values] = await Promise.all([tx.objectStore(name).getAllKeys(), tx.objectStore(name).getAll()]);
    snapshot[name] = keys.map((key, i) => [key as Key, values[i]]);
  }));
  await tx.done;
  return snapshot;
}

async function backupDatabase(name: string, version: number, snapshot: Snapshot) {
  const backup = await openDB(`${name}-backup-v${version}`, 1, {
    upgrade(db) { for (const store of STORE_NAMES) db.createObjectStore(store); },
  });
  try {
    const tx = backup.transaction(STORE_NAMES, "readwrite");
    const done = tx.done;
    void done.catch(() => {});
    try {
      for (const store of STORE_NAMES) {
        await tx.objectStore(store).clear();
        for (const [key, value] of snapshot[store] ?? []) await tx.objectStore(store).put(value, key);
      }
      await done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already aborted. */ }
      await done.catch(() => {});
      throw error;
    }
  } finally { backup.close(); }
}

export type ExternalChange = { store: StoreName | "restore"; id?: string };
const listeners = new Set<(event: ExternalChange) => void>();
let notificationChannel: BroadcastChannel | undefined;
function channel() {
  if (!notificationChannel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    notificationChannel = new BroadcastChannel("sds-changes");
    notificationChannel.onmessage = event => {
      const value = event.data as Partial<ExternalChange> | null;
      if (value && (value.store === "restore" || STORE_NAMES.includes(value.store as StoreName))) {
        for (const listener of listeners) listener(value as ExternalChange);
      }
    };
  }
  return notificationChannel;
}
export function onExternalChange(callback: (event: ExternalChange) => void): () => void {
  channel();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
    if (!listeners.size) { notificationChannel?.close(); notificationChannel = undefined; }
  };
}
function notify(event: ExternalChange) {
  try { channel()?.postMessage(event); } catch { /* Notifications never determine whether a save succeeded. */ }
}

export async function readRecord<K extends StoreName>(tx: Transaction, name: K, key: Key): Promise<Records[K] | undefined> {
  const value = await tx.get(name, key);
  if (value === undefined) return undefined;
  let reason: string;
  try {
    const result = recordSchemas[name].safeParse(value);
    if (result.success) return result.data as Records[K];
    reason = result.error.message;
  } catch { reason = "Record could not be validated (excessive nesting or malformed data)."; }
  // Quarantine and removal share the reading transaction; invalid data never reaches callers.
  const quarantined = { id: newId(), schemaVersion: 1, revision: 1, store: name, key, value, reason, quarantinedAt: Date.now() };
  await tx.put("quarantine", quarantined);
  await tx.delete(name, key);
  return undefined;
}
export async function readAll<K extends StoreName>(tx: Transaction, name: K): Promise<Records[K][]> {
  const result: Records[K][] = [];
  for (const [key] of await tx.entries(name)) {
    const value = await readRecord(tx, name, key);
    if (value) result.push(value);
  }
  return result;
}

export class Store {
  private generation = 0;
  private requestedPersistence = false;
  constructor(private backend: Backend, readonly persistent: boolean, readonly readOnly = false, readonly fallbackReason?: string) {}

  /** Internal transaction boundary, also used for atomic multi-store restore. */
  async transaction<T>(body: (tx: Transaction) => Promise<T>, write = false): Promise<T> {
    if (write && this.readOnly) throw new ReadOnlyStoreError();
    return this.backend.transaction(STORE_NAMES, body);
  }
  async initialize() {
    const meta = await this.transaction(async tx => {
      const state = await readRecord(tx, "meta", "state") ?? initialMeta();
      await tx.put("meta", state);
      return state;
    });
    this.generation = meta.restoreGeneration;
    return this;
  }
  close() { this.backend.close(); }
  async assertGeneration(tx: Transaction, expected = this.generation) {
    const meta = await readRecord(tx, "meta", "state") ?? initialMeta();
    if (meta.restoreGeneration !== expected || meta.restoreGeneration !== this.generation) throw new RevisionConflict();
    return meta;
  }
  acceptRestoreGeneration(generation: number) { this.generation = generation; }
  async nextRevision(tx: Transaction, current = 0, designId?: string) {
    const meta = await readRecord(tx, "meta", "state") ?? initialMeta();
    const previous = designId && Object.hasOwn(meta.designRevisions, designId) ? meta.designRevisions[designId] : 0;
    const revision = Math.max(current, previous) + 1;
    const clock = Math.max(meta.revision + 1, revision);
    if (!Number.isSafeInteger(clock)) throw new RangeError("Revision counter exhausted.");
    await tx.put("meta", { ...meta, revision: clock, designRevisions: designId ? { ...meta.designRevisions, [designId]: revision } : meta.designRevisions });
    return revision;
  }
  changed(store: ExternalChange["store"], id?: string) {
    notify({ store, id });
    if (this.persistent && !this.requestedPersistence && typeof navigator !== "undefined") {
      this.requestedPersistence = true;
      try { void navigator.storage?.persist?.().catch(() => {}); } catch { /* Persistence is best effort. */ }
    }
  }
  private async list<K extends StoreName>(name: K) { return this.transaction(tx => readAll(tx, name)); }
  private async get<K extends StoreName>(name: K, key: Key) { return this.transaction(tx => readRecord(tx, name, key)); }
  private async save<K extends StoreName>(name: K, record: Records[K], expectedRevision?: number) {
    const parsed = recordSchemas[name].parse(record) as Records[K];
    const key = (parsed as unknown as Record<string, Key>)[keyPaths[name]];
    const saved = await this.transaction(async tx => {
      await this.assertGeneration(tx, "restoreGeneration" in parsed ? parsed.restoreGeneration as number | undefined : undefined);
      const old = await readRecord(tx, name, key);
      if (expectedRevision !== undefined && (old?.revision ?? 0) !== expectedRevision) throw new RevisionConflict();
      const result = { ...parsed, revision: await this.nextRevision(tx, old?.revision ?? 0, name === "designs" ? String(key) : undefined) };
      if (name === "designs") Object.assign(result, { restoreGeneration: this.generation });
      await tx.put(name, result);
      return result as Records[K];
    }, true);
    this.changed(name, String(key));
    return saved;
  }
  designs = {
    list: () => this.list("designs"),
    get: (id: string) => this.get("designs", id),
    put: (record: DesignRecord, expectedRevision: number) => this.save("designs", record, expectedRevision),
    delete: async (id: string) => {
      await this.transaction(async tx => {
        await this.assertGeneration(tx);
        await tx.delete("designs", id);
        for (const run of await readAll(tx, "runs")) if (run.designId === id) await tx.delete("runs", run.id);
      }, true);
      this.changed("designs", id);
    },
  };
  runs = {
    add: (record: RunRecord) => this.save("runs", record, 0),
    listForDesign: async (designId: string, limit = 10) => (await this.list("runs")).filter(run => run.designId === designId).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(0, limit)),
  };
  progress = {
    get: (itemId: string) => this.get("progress", itemId),
    all: () => this.list("progress"),
    upsert: async (record: ProgressRecord) => {
      const parsed = recordSchemas.progress.parse(record);
      const saved = await this.transaction(async tx => {
        await this.assertGeneration(tx);
        const old = await readRecord(tx, "progress", parsed.itemId);
        const result = mergeProgress(old, parsed);
        result.revision = await this.nextRevision(tx, old?.revision ?? 0);
        await tx.put("progress", result);
        return result;
      }, true);
      this.changed("progress", parsed.itemId);
      return saved;
    },
  };
  reviews = {
    get: (itemId: string) => this.get("reviews", itemId),
    all: () => this.list("reviews"),
    due: async (now = Date.now()) => (await this.list("reviews")).filter(review => review.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt),
    record: async (itemId: string, quality: number, now = Date.now()): Promise<ReviewRecord> => {
      const result = await this.transaction(async tx => {
        await this.assertGeneration(tx);
        const old = await readRecord(tx, "reviews", itemId);
        const record = recordSchemas.reviews.parse(scheduleReview(old, itemId, quality, now));
        record.revision = await this.nextRevision(tx, old?.revision);
        await tx.put("reviews", record);
        return record;
      }, true);
      this.changed("reviews", itemId);
      return result;
    },
  };
  settings = {
    get: () => this.get("settings", "settings"),
    put: (record: SettingsRecord) => this.save("settings", record, record.revision),
  };
  quarantine = { list: () => this.list("quarantine") };
}

export async function createStore(options: OpenStoreOptions = {}): Promise<Store> {
  const name = options.name ?? "sds";
  let snapshot: Snapshot = {};
  let probe: IDBPDatabase | undefined;
  let connection: IDBPDatabase | undefined;
  let needsMigration = false;
  try {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable; progress will not be saved.");
    let fresh = false;
    probe = await connectDatabase(name, undefined, {
      upgrade(db, _old, _next, tx) {
        void tx.done.catch(() => {});
        fresh = true;
        for (const store of STORE_NAMES) db.createObjectStore(store, { keyPath: keyPaths[store] });
      },
      blocking() { probe?.close(); options.onVersionChange?.(); },
    }, options.onBlocked);
    snapshot = await snapshotDatabase(probe);
    const oldVersion = probe.version;
    needsMigration = oldVersion < DATABASE_VERSION;
    if (oldVersion > DATABASE_VERSION) {
      // Explicit versioned open detects rollback through IndexedDB's VersionError.
      probe.close();
      await openDB(name, DATABASE_VERSION);
    }
    if (oldVersion < DATABASE_VERSION && !fresh) await backupDatabase(name, oldVersion, snapshot);
    probe.close();
    connection = await connectDatabase(name, DATABASE_VERSION, {
      upgrade(db, _old, _next, tx) {
        void tx.done.catch(() => {});
        for (const store of STORE_NAMES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: keyPaths[store] });
          else {
            // v1 -> v2 adds envelopes to legacy v0 records; repeating it is harmless.
            void (async () => {
              let cursor = await tx.objectStore(store).openCursor();
              while (cursor) {
                const value = cursor.value;
                const migrated = migrateRecord(store, value);
                if (migrated !== value) await cursor.update(migrated);
                cursor = await cursor.continue();
              }
            })().catch(() => { try { tx.abort(); } catch { /* Already aborted. */ } });
          }
        }
      },
      blocking() { connection?.close(); options.onVersionChange?.(); },
    }, options.onBlocked);
    return await new Store(indexedBackend(connection), true).initialize();
  } catch (error) {
    probe?.close();
    connection?.close();
    const readOnly = error instanceof Error && error.name === "VersionError";
    if (needsMigration && !readOnly) for (const store of STORE_NAMES) snapshot[store] = snapshot[store]?.map(([key, value]) => [key, migrateRecord(store, value)]);
    const reason = readOnly ? "Database is newer than this app; running a read-only in-memory copy. Update the app." : "Storage unavailable; progress will not be saved. Export your work before leaving.";
    options.onFallback?.(reason);
    return new Store(memoryBackend(snapshot), false, readOnly, reason).initialize();
  }
}

let defaultStore: Promise<Store> | undefined;
export function openStore(options?: OpenStoreOptions): Promise<Store> {
  if (options) return createStore(options);
  return defaultStore ??= createStore();
}
