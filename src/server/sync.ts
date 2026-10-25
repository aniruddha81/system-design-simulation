import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { syncRecords } from "./db/schema";
import { check, MAX_BATCH, MAX_PAGE, MAX_RECORDS_PER_USER, type Checked, type PushRecord } from "./sync-validate";

export { MAX_PAGE, pushSchema } from "./sync-validate";

export async function pushRecords(userId: string, records: PushRecord[]) {
  const ok: Checked[] = [];
  const rejected: string[] = [];
  for (const r of records) {
    const c = check(r);
    if (typeof c === "string") rejected.push(c);
    else ok.push(c);
  }
  if (!ok.length) return { accepted: 0, rejected };
  const db = getDb();
  const [{ n }] = await db.select({ n: count() }).from(syncRecords).where(eq(syncRecords.userId, userId));
  if (n + ok.length > MAX_RECORDS_PER_USER + MAX_BATCH) return { accepted: 0, rejected: [...rejected, "storage quota reached: export and delete old designs"] };
  // One statement = atomic. Last write wins on updatedAt; an older push never overwrites a newer row, and a no-op push does not bump seq.
  await db
    .insert(syncRecords)
    .values(ok.map((r) => ({ userId, store: r.store, key: r.key, data: r.data, updatedAt: r.updatedAt, deleted: r.deleted, bytes: r.bytes, seq: sql<number>`nextval('sync_seq')` })))
    .onConflictDoUpdate({
      target: [syncRecords.userId, syncRecords.store, syncRecords.key],
      set: { data: sql`excluded.data`, updatedAt: sql`excluded.updated_at`, deleted: sql`excluded.deleted`, bytes: sql`excluded.bytes`, seq: sql`nextval('sync_seq')`, serverTime: sql`now()` },
      setWhere: sql`excluded.updated_at >= ${syncRecords.updatedAt} and (excluded.data is distinct from ${syncRecords.data} or excluded.deleted <> ${syncRecords.deleted})`,
    });
  // A deleted design takes its run history with it, so no orphaned runs linger in the cloud copy.
  for (const r of ok) {
    if (r.store === "designs" && r.deleted) await db.delete(syncRecords).where(and(eq(syncRecords.userId, userId), eq(syncRecords.store, "runs"), sql`${syncRecords.data}->>'designId' = ${r.key}`));
  }
  return { accepted: ok.length, rejected };
}

export async function pullRecords(userId: string, since: number, limit = MAX_PAGE) {
  const rows = await getDb()
    .select({ store: syncRecords.store, key: syncRecords.key, data: syncRecords.data, updatedAt: syncRecords.updatedAt, deleted: syncRecords.deleted, seq: syncRecords.seq })
    .from(syncRecords)
    .where(and(eq(syncRecords.userId, userId), gt(syncRecords.seq, since)))
    .orderBy(asc(syncRecords.seq))
    .limit(Math.min(limit, MAX_PAGE) + 1);
  const hasMore = rows.length > Math.min(limit, MAX_PAGE);
  const page = hasMore ? rows.slice(0, -1) : rows;
  return { records: page, cursor: page.at(-1)?.seq ?? since, hasMore };
}
