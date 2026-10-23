import { describe, expect, it } from "vitest";
import { formatBandwidth, formatBytes, formatDuration, formatNumber, formatPercent, formatRps, formatUsdEstimate } from "./format";

describe("format", () => {
  it("formats numbers, percents and rps", () => {
    expect(formatNumber(12345.678)).toBe("12,345.68");
    expect(formatPercent(0.987)).toBe("98.7%");
    expect(formatRps(12000)).toBe("12,000 rps");
  });

  it("picks a duration unit from microseconds", () => {
    expect(formatDuration(0.1)).toBe("100 ns");
    expect(formatDuration(850)).toBe("850 µs");
    expect(formatDuration(999.9999)).toBe("1 ms");
    expect(formatDuration(12_500)).toBe("12.5 ms");
    expect(formatDuration(1_500_000)).toBe("1.5 s");
    expect(formatDuration(0.001 * 365.25 * 86400e6)).toBe("8.77 h");
  });

  it("keeps SI and binary bytes distinct", () => {
    expect(formatBytes(1000)).toBe("1 KB");
    expect(formatBytes(1024)).toBe("1.02 KB");
    expect(formatBytes(1024, { binary: true })).toBe("1 KiB");
    expect(formatBytes(1.5e12)).toBe("1.5 TB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBandwidth(10e6)).toBe("80 Mbps");
  });

  it("labels currency as an estimate", () => {
    expect(formatUsdEstimate(1234)).toBe("$1,234 (estimate)");
  });
});
