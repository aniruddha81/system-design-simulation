import { bigint, boolean, index, integer, jsonb, pgSequence, pgTable, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export * from "./auth-schema";

export const apiRateLimit = pgTable("api_rate_limit", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  requests: integer("requests").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
}, (t) => [index("api_rate_limit_window").on(t.windowStart)]);

export const clientErrors = pgTable("client_errors", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  message: varchar("message", { length: 500 }).notNull(),
  stack: varchar("stack", { length: 4096 }),
  url: text("url").notNull(),
  userAgent: varchar("user_agent", { length: 200 }),
  release: varchar("release", { length: 100 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("client_errors_created").on(t.createdAt)]);

/** Global monotonic cursor: clients pull "everything after seq N". */
export const syncSeq = pgSequence("sync_seq");

/**
 * One row per synced record (designs, progress, reviews, runs). `data` is validated against the
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
