import { describe, expect, it } from "vitest";
import { check, pushSchema } from "./sync-validate";

const progress = { schemaVersion: 1, revision: 7, itemId: "lesson:caching", kind: "lesson", mastery: 0.9 };

describe("sync record validation", () => {
  it("accepts a valid record and strips per-device counters", () => {
    const c = check({ store: "progress", key: "lesson:caching", updatedAt: 1, data: progress });
    expect(c).toMatchObject({ deleted: false, data: { itemId: "lesson:caching" } });
    expect((c as { data: object }).data).not.toHaveProperty("revision");
  });
  it("rejects schema violations and key mismatches", () => {
    expect(typeof check({ store: "progress", key: "x", updatedAt: 1, data: { nope: 1 } })).toBe("string");
    expect(typeof check({ store: "progress", key: "other", updatedAt: 1, data: progress })).toBe("string");
    expect(typeof check({ store: "progress", key: "lesson:caching", updatedAt: 1, data: { ...progress, mastery: 2 } })).toBe("string");
  });
  it("passes tombstones without data", () => {
    expect(check({ store: "designs", key: "d1", updatedAt: 5, deleted: true })).toMatchObject({ deleted: true, data: null });
  });
  it("bounds batch size and store names", () => {
    expect(pushSchema.safeParse({ records: [{ store: "settings", key: "a", updatedAt: 1 }] }).success).toBe(false);
    expect(pushSchema.safeParse({ records: Array.from({ length: 201 }, (_, i) => ({ store: "progress", key: String(i), updatedAt: 1 })) }).success).toBe(false);
  });
});
