import { z } from "zod";
import { keyPaths, recordSchemas } from "../lib/persistence/schemas";

export const SYNC_STORES = ["designs", "progress", "reviews"] as const;
export const MAX_BATCH = 200;
export const MAX_PAGE = 500;
export const MAX_RECORDS_PER_USER = 5000;
const MAX_BYTES = { designs: 2 * 1024 * 1024, progress: 4096, reviews: 4096 } as const;

export const pushSchema = z.object({
  records: z
    .array(z.object({ store: z.enum(SYNC_STORES), key: z.string().min(1).max(512), updatedAt: z.number().int().nonnegative(), deleted: z.boolean().optional(), data: z.unknown().optional() }))
    .max(MAX_BATCH),
});
export type PushRecord = z.infer<typeof pushSchema>["records"][number];

export type Checked = { store: PushRecord["store"]; key: string; updatedAt: number; deleted: boolean; data: unknown; bytes: number };

/** Validates one pushed record against the same zod schema the browser store uses. Returns an error string or the row to write. */
export function check(rec: PushRecord): Checked | string {
  if (rec.deleted) return { store: rec.store, key: rec.key, updatedAt: rec.updatedAt, deleted: true, data: null, bytes: 0 };
  const parsed = recordSchemas[rec.store].safeParse(rec.data);
  if (!parsed.success) return `${rec.store}/${rec.key}: invalid record`;
  if (String((parsed.data as Record<string, unknown>)[keyPaths[rec.store]]) !== rec.key) return `${rec.store}/${rec.key}: key does not match record`;
  // Per-device counters stay out of the cloud copy, so identical content is byte-identical and never ping-pongs between devices.
  const { revision: _r, restoreGeneration: _g, ...data } = parsed.data as Record<string, unknown>;
  const bytes = Buffer.byteLength(JSON.stringify(data));
  if (bytes > MAX_BYTES[rec.store]) return `${rec.store}/${rec.key}: record too large`;
  return { store: rec.store, key: rec.key, updatedAt: rec.updatedAt, deleted: false, data, bytes };
}

