// One place for numbers and units (PLAN §17). English only in v1.
// SI units (KB = 1,000 B) in estimates; binary units (KiB = 1,024 B) in memory contexts.

const LOCALE = "en-US";
const cache = new Map<string, Intl.NumberFormat>();
function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let f = cache.get(key);
  if (!f) cache.set(key, (f = new Intl.NumberFormat(LOCALE, options)));
  return f;
}

/** 12,345.68 — grouping on, at most `maxFractionDigits` decimals. */
export function formatNumber(n: number, maxFractionDigits = 2): string {
  return nf({ maximumFractionDigits: maxFractionDigits }).format(n);
}

/** 0.987 → "98.7%". */
export function formatPercent(fraction: number, maxFractionDigits = 1): string {
  return nf({ style: "percent", maximumFractionDigits: maxFractionDigits }).format(fraction);
}

/** Requests per second, e.g. "12,000 rps". */
export function formatRps(n: number): string {
  return `${formatNumber(n, n < 10 ? 2 : 0)} rps`;
}

const DURATION_STEPS: [limitUs: number, divisorUs: number, unit: string][] = [
  [1, 1e-3, "ns"],
  [1e3, 1, "µs"],
  [1e6, 1e3, "ms"],
  [60e6, 1e6, "s"],
  [3600e6, 60e6, "min"],
  [86400e6, 3600e6, "h"],
  [Infinity, 86400e6, "d"],
];

/** Duration given in microseconds (the engine's time unit): "850 µs", "12.5 ms", "1.5 s", "8.8 h". */
export function formatDuration(us: number): string {
  const abs = Math.abs(us);
  // 0.9995: a value that would round up to 1,000 of a unit (999.99 µs) shows as the next unit.
  const [, divisor, unit] = DURATION_STEPS.find(([limit]) => abs < limit * 0.9995)!;
  const v = us / divisor;
  return `${formatNumber(v, Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0)} ${unit}`;
}

const SI = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
const BINARY = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

/** Bytes in SI units (KB = 1,000 B) by default; `binary: true` gives KiB = 1,024 B. */
export function formatBytes(bytes: number, { binary = false } = {}): string {
  const base = binary ? 1024 : 1000;
  const units = binary ? BINARY : SI;
  let i = 0;
  let v = bytes;
  while (Math.abs(v) >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  return `${formatNumber(v, i === 0 ? 0 : Math.abs(v) < 10 ? 2 : 1)} ${units[i]}`;
}

/** Bandwidth from bytes/s, shown in bits/s (network convention): "80 Mbps". */
export function formatBandwidth(bytesPerSecond: number): string {
  return formatBytes(bytesPerSecond * 8).replace(/B$/, "bps");
}

/** USD only, always labelled as an estimate (PLAN §17, §22). */
export function formatUsdEstimate(usd: number): string {
  return `${nf({ style: "currency", currency: "USD", maximumFractionDigits: usd < 10 ? 2 : 0 }).format(usd)} (estimate)`;
}
