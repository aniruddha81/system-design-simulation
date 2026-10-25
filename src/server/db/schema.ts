import { bigint, boolean, index, integer, jsonb, pgSequence, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export * from "./auth-schema";

/** Global monotonic cursor: clients pull "everything after seq N". */
export const syncSeq = pgSequence("sync_seq");

/**
 * One row per synced record (designs, progress, reviews). `data` is validated against the
 * client persistence schemas on write. Last write wins by `updatedAt`; `deleted` is a tombstone.
 */
export const syncRecords = pgTable(
  "sync_records",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    store: text("store").notNull(),
    key: text("key").notNull(),
    data: jsonb("data"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    deleted: boolean("deleted").notNull().default(false),
    seq: bigint("seq", { mode: "number" }).notNull(),
    bytes: integer("bytes").notNull().default(0),
    serverTime: timestamp("server_time").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.store, t.key] }), index("sync_records_user_seq").on(t.userId, t.seq)],
);
