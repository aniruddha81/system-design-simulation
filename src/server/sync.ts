import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { syncRecords } from "./db/schema";
import { check, MAX_BATCH, MAX_BYTES_PER_USER, MAX_PAGE, MAX_RECORDS_PER_USER, type Checked, type PushRecord } from "./sync-validate";

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
  // ponytail: count-then-insert is not atomic (neon-http has no transactions), so parallel pushes can overshoot slightly. Move the check into the INSERT if that matters.
  const [{ n, b }] = await db.select({ n: count(), b: sql<number>`coalesce(sum(${syncRecords.bytes}), 0)::float8` }).from(syncRecords).where(eq(syncRecords.userId, userId));
  const incoming = ok.reduce((sum, r) => sum + r.bytes, 0);
  if (n + ok.length > MAX_RECORDS_PER_USER + MAX_BATCH || b + incoming > MAX_BYTES_PER_USER) return { accepted: 0, rejected: [...rejected, "storage quota reached: export and delete old designs"] };
  // One statement = atomic. Last write wins on updatedAt; an older push never overwrites a newer row, and a no-op push does not bump seq.
  const applied = await db
    .insert(syncRecords)
    .values(ok.map((r) => ({ userId, store: r.store, key: r.key, data: r.data, updatedAt: r.updatedAt, deleted: r.deleted, bytes: r.bytes, seq: sql<number>`nextval('sync_seq')` })))
    .onConflictDoUpdate({
      target: [syncRecords.userId, syncRecords.store, syncRecords.key],
      set: { data: sql`excluded.data`, updatedAt: sql`excluded.updated_at`, deleted: sql`excluded.deleted`, bytes: sql`excluded.bytes`, seq: sql`nextval('sync_seq')`, serverTime: sql`now()` },
      setWhere: sql`excluded.updated_at >= ${syncRecords.updatedAt} and (excluded.data is distinct from ${syncRecords.data} or excluded.deleted <> ${syncRecords.deleted})`,
    })
    .returning({ store: syncRecords.store, key: syncRecords.key, deleted: syncRecords.deleted });
  // A deleted design takes its run history with it, so no orphaned runs linger in the cloud copy.
  // Only tombstones that won last-write-wins count; a stale one must not erase history.
  for (const r of applied) {
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
