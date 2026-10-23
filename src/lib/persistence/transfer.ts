import { z } from "zod";
import type { Design } from "../../engine/types";
import {
  BACKUP_IMPORT_LIMIT, DESIGN_IMPORT_LIMIT, SCHEMA_VERSION, STORE_NAMES, keyPaths,
  recordSchemas, designSchema, mergeProgress, newId,
  ImportError, BackupTooLargeError, RevisionConflict,
  type DesignRecord, type StoreName, type Records,
} from "./schemas";
import { openStore, readAll, readRecord, type Store } from "./store";

type ReadableFile = Pick<Blob, "size" | "text">;
type BackupData = { [K in StoreName]: Records[K][] };
const backupEnvelope = z.object({ type: z.literal("sds-backup"), schemaVersion: z.literal(1), exportedAt: z.number().nonnegative(), data: z.object({ designs: z.array(z.unknown()), runs: z.array(z.unknown()), progress: z.array(z.unknown()), reviews: z.array(z.unknown()), settings: z.array(z.unknown()), meta: z.array(z.unknown()).default([]), quarantine: z.array(z.unknown()).default([]) }) });
const blob = (value: unknown) => new Blob([JSON.stringify(value)], { type: "application/json" });

function checkDepth(value: unknown) {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (depth > 64) throw new ImportError("JSON nesting is too deep.");
    if (item && typeof item === "object") for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
}
async function readFile(file: ReadableFile, limit: number): Promise<unknown> {
  if (file.size > limit) throw new ImportError(`File exceeds the ${limit === DESIGN_IMPORT_LIMIT ? "2" : "50"} MB import limit.`);
  try {
    const text = await file.text();
    if (new TextEncoder().encode(text).length > limit) throw new ImportError("File exceeds the import limit.");
    const value: unknown = JSON.parse(text);
    checkDepth(value);
    if (value && typeof value === "object" && "schemaVersion" in value && typeof value.schemaVersion === "number" && value.schemaVersion > SCHEMA_VERSION) throw new ImportError("This file uses a newer schemaVersion. Update the app.");
    return value;
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("File is not valid JSON.");
  }
}
function migrateDesign(value: unknown): Design {
  if (!value || typeof value !== "object") throw new ImportError("Expected a design.");
  if ("schemaVersion" in value && typeof value.schemaVersion === "number" && value.schemaVersion > SCHEMA_VERSION) throw new ImportError("This design uses a newer schemaVersion. Update the app.");
  const migrated = "schemaVersion" in value && value.schemaVersion === 0 ? { ...value, schemaVersion: 1 } : value;
  const result = designSchema.safeParse(migrated);
  if (!result.success) throw new ImportError(`Invalid design: ${result.error.message}`);
  return result.data;
}

export async function exportDesign(design: string | Design, store?: Store): Promise<Blob> {
  let value: Design;
  if (typeof design === "string") {
    const record = await (store ?? await openStore()).designs.get(design);
    if (!record) throw new ImportError("Design not found.");
    value = record.design;
  } else value = designSchema.parse(design);
  const result = blob({ type: "sds-design", schemaVersion: SCHEMA_VERSION, design: value });
  if (result.size > DESIGN_IMPORT_LIMIT) throw new ImportError("Design exceeds the 2 MB import limit.");
  return result;
}
export async function exportAllDesigns(store?: Store): Promise<Blob> {
  const records = await (store ?? await openStore()).designs.list();
  const result = blob({ type: "sds-designs", schemaVersion: SCHEMA_VERSION, designs: records.map(r => r.design) });
  if (result.size > BACKUP_IMPORT_LIMIT) throw new BackupTooLargeError();
  return result;
}

async function snapshot(store: Store) {
  return store.transaction(async tx => {
    const data = {} as BackupData;
    for (const name of STORE_NAMES) Object.assign(data, { [name]: await readAll(tx, name) });
    const designIds = new Set(data.designs.map(record => record.id));
    data.runs = data.runs.filter(record => {
      if (designIds.has(record.designId)) return true;
      // A deleted/unsaved design cannot be restored alongside this run reference.
      data.quarantine.push({ id: newId(), schemaVersion: 1, revision: 0, store: "runs", key: record.id, value: record, reason: "Run references a missing design", quarantinedAt: Date.now() });
      return false;
    });
    return data;
  });
}
function backupBlob(data: BackupData, withoutRuns = false) {
  const value = { type: "sds-backup", schemaVersion: SCHEMA_VERSION, exportedAt: Date.now(), data: { ...data, runs: withoutRuns ? [] : data.runs } };
  checkDepth(value);
  const result = blob(value);
  if (result.size > BACKUP_IMPORT_LIMIT) throw new BackupTooLargeError();
  return result;
}
export async function exportBackup(options: { withoutRuns?: boolean; store?: Store } = {}): Promise<Blob> {
  return backupBlob(await snapshot(options.store ?? await openStore()), options.withoutRuns);
}
export async function importDesign(file: ReadableFile, store?: Store): Promise<DesignRecord> {
  const value = await readFile(file, DESIGN_IMPORT_LIMIT);
  let candidate: unknown = value;
  if (value && typeof value === "object" && "type" in value) {
    if (value.type !== "sds-design" || !("design" in value)) throw new ImportError("Expected a single design export.");
    candidate = value.design;
  }
  const design = { ...migrateDesign(candidate), id: newId() };
  const now = Date.now();
  return (store ?? await openStore()).designs.put({ id: design.id, design, schemaVersion: 1, revision: 0, createdAt: now, updatedAt: now }, 0);
}

export type RestoreOptions = {
  store?: Store;
  restoreSettings?: boolean;
  /** The browser downloads automatically; hosts can supply their own download UI. */
  downloadBackup?: (backup: Blob) => void | Promise<void>;
};
function download(backup: Blob) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(backup);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `sds-before-restore-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function parseBackup(value: unknown, strict: boolean): { data: BackupData; quarantined: number } {
  const envelope = backupEnvelope.safeParse(value);
  if (!envelope.success) throw new ImportError("Expected a versioned full backup.");
  const data = Object.fromEntries(STORE_NAMES.map(name => [name, []])) as unknown as BackupData;
  const invalid: Records["quarantine"][] = [];
  for (const name of STORE_NAMES) {
    const seen = new Set<string>();
    for (const record of envelope.data.data[name]) {
      const parsed = recordSchemas[name].safeParse(record);
      const key = parsed.success ? String((parsed.data as unknown as Record<string, unknown>)[keyPaths[name]]) : "invalid";
      if (!parsed.success || seen.has(key)) {
        if (strict) throw new ImportError(`Invalid or duplicate ${name} record; nothing was restored.`);
        invalid.push({ schemaVersion: 1, revision: 0, id: newId(), store: name, key, value: record, quarantinedAt: Date.now(), reason: parsed.success ? "Duplicate record" : parsed.error.message });
      } else { seen.add(key); (data[name] as unknown[]).push(parsed.data); }
    }
  }
  const designIds = new Set(data.designs.map(r => r.id));
  data.runs = data.runs.filter(record => {
    if (designIds.has(record.designId)) return true;
    if (strict) throw new ImportError("Run references a missing design; nothing was restored.");
    invalid.push({ schemaVersion: 1, revision: 0, id: newId(), store: "runs", key: record.id, value: record, quarantinedAt: Date.now(), reason: "Run references a missing design" });
    return false;
  });
  data.quarantine.push(...invalid);
  return { data, quarantined: invalid.length };
}

export async function restoreBackup(file: ReadableFile, mode: "merge" | "replace" = "merge", options: RestoreOptions = {}) {
  if (mode !== "merge" && mode !== "replace") throw new ImportError("Unknown restore mode.");
  const { data, quarantined } = parseBackup(await readFile(file, BACKUP_IMPORT_LIMIT), mode === "replace");
  const store = options.store ?? await openStore();
  const before = await snapshot(store);
  const safetyBackup = mode === "replace" ? backupBlob(before) : undefined;
  if (safetyBackup) await (options.downloadBackup ?? download)(safetyBackup);
  const idMap = Object.fromEntries(data.designs.map(record => [record.id, mode === "merge" ? newId() : record.id]));
  const generation = await store.transaction(async tx => {
    const meta = await store.assertGeneration(tx);
    if (mode === "replace" && meta.revision !== (before.meta[0]?.revision ?? 0)) throw new RevisionConflict();
    let revision = meta.revision;
    for (const name of STORE_NAMES) {
      for (const [, value] of await tx.entries(name)) {
        if (value && typeof value === "object" && "revision" in value && typeof value.revision === "number" && Number.isSafeInteger(value.revision)) revision = Math.max(revision, value.revision);
      }
      for (const record of data[name]) revision = Math.max(revision, record.revision);
    }
    const nextGeneration = meta.restoreGeneration + (mode === "replace" ? 1 : 0);
    if (!Number.isSafeInteger(nextGeneration)) throw new ImportError("Restore generation counter exhausted.");
    const designRevisions = mode === "merge" ? { ...meta.designRevisions } : {};
    if (mode === "replace") for (const name of STORE_NAMES) await tx.clear(name);
    async function put(name: StoreName, record: Records[StoreName]) {
      if (!Number.isSafeInteger(++revision)) throw new ImportError("Revision counter exhausted.");
      await tx.put(name, { ...record, revision });
      if (name === "designs" && "id" in record) designRevisions[record.id] = revision;
    }
    for (const record of data.designs) {
      const id = idMap[record.id];
      await put("designs", { ...record, id, design: { ...record.design, id }, restoreGeneration: nextGeneration });
    }
    for (const record of data.runs) await put("runs", { ...record, id: mode === "merge" ? newId() : record.id, designId: idMap[record.designId] });
    for (const record of data.progress) await put("progress", mode === "merge" ? mergeProgress(await readRecord(tx, "progress", record.itemId), record) : record);
    for (const record of data.reviews) {
      const old = mode === "merge" ? await readRecord(tx, "reviews", record.itemId) : undefined;
      if (!old || record.updatedAt > old.updatedAt) await put("reviews", record);
    }
    if (mode === "replace" || options.restoreSettings) for (const record of data.settings) await put("settings", record);
    for (const record of data.quarantine) await put("quarantine", { ...record, id: mode === "merge" ? newId() : record.id });
    if (!Number.isSafeInteger(++revision)) throw new ImportError("Revision counter exhausted.");
    await tx.put("meta", { id: "state", schemaVersion: 1, restoreGeneration: nextGeneration, revision, designRevisions });
    return nextGeneration;
  }, true);
  store.acceptRestoreGeneration(generation);
  store.changed("restore");
  return { idMap, quarantined, safetyBackup };
}

/** Each file returned by all-design export can be imported as a fresh draft. */
export async function importAllDesigns(file: ReadableFile, store?: Store): Promise<DesignRecord[]> {
  const value = await readFile(file, BACKUP_IMPORT_LIMIT);
  const parsed = z.object({ type: z.literal("sds-designs"), schemaVersion: z.literal(1), designs: z.array(z.unknown()) }).safeParse(value);
  if (!parsed.success) throw new ImportError("Expected an all-designs export.");
  const designs = parsed.data.designs.map(migrateDesign);
  // Validate sizes before saving any draft.
  const files = await Promise.all(designs.map(design => exportDesign(design)));
  const target = store ?? await openStore();
  const records: DesignRecord[] = [];
  for (const file of files) records.push(await importDesign(file, target));
  return records;
}

export async function resetProgress(confirmation: string, options: RestoreOptions = {}): Promise<Blob> {
  if (confirmation !== "RESET PROGRESS") throw new ImportError("Type RESET PROGRESS to confirm.");
  const store = options.store ?? await openStore();
  const backup = await exportBackup({ store });
  await (options.downloadBackup ?? download)(backup);
  await store.transaction(async tx => {
    await store.assertGeneration(tx);
    await tx.clear("progress");
    await tx.clear("reviews");
    await store.nextRevision(tx);
  }, true);
  store.changed("progress");
  return backup;
}

export async function resetAllData(confirmation: string, options: RestoreOptions = {}) {
  if (confirmation !== "RESET ALL DATA") throw new ImportError("Type RESET ALL DATA to confirm.");
  const data = Object.fromEntries(STORE_NAMES.map(name => [name, []])) as unknown as BackupData;
  return restoreBackup(backupBlob(data), "replace", options);
}
