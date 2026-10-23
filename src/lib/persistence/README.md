# Browser persistence API

Import from `@/lib/persistence`. Browser globals are guarded at module import.

`openStore()` shares the default `sds` connection. `openStore(options)` and
`createStore(options)` open independent connections. Options: `name`,
`onVersionChange()`, `onBlocked()`, and `onFallback(reason)`. A blocked upgrade
falls back after one second; a later successful open is closed automatically.

`Store` exposes `persistent`, `readOnly`, `fallbackReason`, `close()`, and:

| API | Result |
| --- | --- |
| `designs.list()` | `Promise<DesignRecord[]>` |
| `designs.get(id)` | `Promise<DesignRecord \| undefined>` |
| `designs.put(record, expectedRevision)` | `Promise<DesignRecord>`; new drafts expect revision `0` |
| `designs.delete(id)` | `Promise<void>`; also removes the design's run history |
| `runs.add(record)` | `Promise<RunRecord>`; inserts only |
| `runs.listForDesign(designId, limit = 10)` | `Promise<RunRecord[]>`; newest first |
| `progress.get(itemId)` / `progress.all()` | One record or all records |
| `progress.upsert(record)` | `Promise<ProgressRecord>`; max merge |
| `reviews.get(itemId)` / `reviews.all()` | One record or all records |
| `reviews.due(now = Date.now())` | `Promise<ReviewRecord[]>`; earliest due first |
| `reviews.record(itemId, quality, now?)` | `Promise<ReviewRecord>`; SM-2 quality `0..5`, missed objectives use `<3` |
| `settings.get()` / `settings.put(record)` | Optional settings / saved settings; put compares `record.revision` |
| `quarantine.list()` | `Promise<QuarantineRecord[]>` |

Every record has `schemaVersion: 1` and `revision`. `DesignRecord` additionally
has `id`, `design: Design`, `createdAt`, `updatedAt`, and optional
`restoreGeneration`. Preserve the generation returned by reads when saving an
edited record. `ProgressRecord` has stable `itemId`, `kind`, and optional
`mastery` (`0..1`), `completedAt` (Unix milliseconds), `stars` (`0..3`), and
`contentRevision`. The content layer excludes removed content from calculations.
`RunRecord` has `id`, `designId`, `createdAt`, `runKey: RunKey`, `replayCompatId`,
and `summary: { metrics, outcome, invariantCounts, verdict?, inconclusiveReason? }`.
Raw events and time series are discarded. Settings require `id: "settings"`;
optional `theme`, `reducedMotion`, and additional JSON preferences are supported.

| Exported helper | Signature / behavior |
| --- | --- |
| `exportDesign` | `(designIdOrDesign, store?) => Promise<Blob>`; single-design JSON |
| `exportAllDesigns` | `(store?) => Promise<Blob>`; all-designs JSON |
| `exportBackup` | `({ withoutRuns?, store? }?) => Promise<Blob>`; full backup |
| `importDesign` | `(file, store?) => Promise<DesignRecord>`; 2 MB cap, new ID |
| `importAllDesigns` | `(file, store?) => Promise<DesignRecord[]>`; all-designs JSON as new drafts |
| `restoreBackup` | `(file, mode = "merge", options?) => Promise<{ idMap, quarantined, safetyBackup? }>`; 50 MB cap |
| `resetProgress` | `("RESET PROGRESS", options?) => Promise<Blob>`; exports first, clears progress and reviews |
| `resetAllData` | `("RESET ALL DATA", options?)`; exports first, clears all data and invalidates stale drafts |
| `encodeShareLink` | `(design: Design) => string \| null`; `#d=` fragment |
| `decodeShareLink` | `(hash) => Design \| { error: string }`; unsaved draft with a new ID |
| `onExternalChange` | `(callback: (event: { store, id? }) => void) => unsubscribe` |
| `autosave` | `(designId, { store?, onStatusChange? }?) => Autosave` |
| `mergeProgress` | `(previous: ProgressRecord \| undefined, incoming) => ProgressRecord`; pure |
| `scheduleReview` | `(previous: ReviewRecord \| undefined, itemId, quality, now?) => ReviewRecord`; pure |
| `newId` | `() => string`; UUID |

Restore options: `{ store?, restoreSettings?, downloadBackup? }`.
Merge remaps imported design/run IDs, merges progress, takes the newest review,
and leaves settings unchanged unless requested. Replace validates everything
first and automatically downloads the safety backup before one atomic
transaction. Hosts can supply `downloadBackup(blob)`; outside a browser the
safety backup is returned. Invalid merge records are quarantined; invalid
replace changes nothing. A save during safety-backup downloading aborts replace.

`Autosave` has getters `status: "saved" | "saving" | "error"` and `error`, plus
`schedule(designOrRecord)`, `flush()`, `retry()`, `subscribe(callback)`, and
`dispose()`. Schedule a `Design` for repeated edits. A supplied `DesignRecord`
preserves its explicit expected revision. Saves debounce 800 ms; pending/failed
saves activate the unload prompt. Revision conflicts require reload or saving
a copy; retry preserves the expected revision.

Schema exports: `designSchema`, `designRecordSchema`, `runKeySchema`,
`metricsSchema`, `runRecordSchema`, `progressRecordSchema`, `reviewRecordSchema`,
`settingsRecordSchema`, `metaRecordSchema`, `quarantineRecordSchema`,
`recordSchemas`. Record types: `DesignRecord`, `RunRecord`, `ProgressRecord`,
`ReviewRecord`, `SettingsRecord`, `MetaRecord`, `QuarantineRecord`, `Records`,
`StoreName`. Supporting types: `Store`, `OpenStoreOptions`, `ExternalChange`,
`RestoreOptions`, `Autosave`, `SaveStatus`.

Errors: `RevisionConflict`, `StorageQuotaError`, `ReadOnlyStoreError`,
`ImportError`, `BackupTooLargeError` (with `offerWithoutRuns: true`). Constants:
`SCHEMA_VERSION`, `DATABASE_VERSION`, `DESIGN_IMPORT_LIMIT`,
`BACKUP_IMPORT_LIMIT`, `SHARE_COMPRESSED_LIMIT`, `SHARE_DECOMPRESSED_LIMIT`,
`STORE_NAMES`, `keyPaths`.

Checks: `npx.cmd tsc --noEmit --incremental false`,
`npx.cmd eslint src/lib/persistence`, and
`npx.cmd vitest run src/lib/persistence --configLoader native --pool threads`.
The native config loader avoids Vite's prohibited `net use` child process in
the Windows sandbox; test configuration is unchanged.
