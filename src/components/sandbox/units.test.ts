import { describe, expect, it } from "vitest";
import { parseUnit, toUnit } from "./units";

describe("parseUnit", () => {
  it("converts durations to µs", () => {
    expect(parseUnit("2s", "duration")).toEqual({ ok: true, value: 2_000_000 });
    expect(parseUnit("150", "duration")).toEqual({ ok: true, value: 150_000 }); // bare = ms
    expect(parseUnit("300 µs", "duration")).toEqual({ ok: true, value: 300 });
    expect(parseUnit("1,500ms", "duration")).toEqual({ ok: true, value: 1_500_000 });
  });
  it("converts bytes, fractions and money", () => {
    expect(parseUnit("64MB", "bytes")).toEqual({ ok: true, value: 64 * 1024 ** 2 });
    expect(parseUnit("1%", "fraction")).toEqual({ ok: true, value: 0.01 });
    expect(parseUnit("$12.5", "money")).toEqual({ ok: true, value: 12.5 });
  });
  it("rejects invalid input with a message", () => {
    for (const [t, k] of [["abc", "duration"], ["2 parsecs", "duration"], ["-1", "count"], ["150%", "fraction"], ["3x", "count"]] as const) {
      const r = parseUnit(t, k);
      expect(r.ok).toBe(false);
    }
  });
  it("round-trips to the display unit", () => {
    expect(toUnit(2_000_000, "duration")).toBe("2000");
    expect(toUnit(64 * 1024 ** 2, "bytes")).toBe("64");
  });
});
