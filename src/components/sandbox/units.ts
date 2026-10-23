// Unit-aware parsing for inspector fields (PLAN §8: "2s" -> 2,000 ms; invalid keeps last valid).

export type UnitKind = "duration" | "bytes" | "rate" | "money" | "count" | "fraction" | "number";
export type Parsed = { ok: true; value: number } | { ok: false; error: string };

// Factors to the stored base unit: duration -> µs, bytes -> B.
const FACTORS: Partial<Record<UnitKind, Record<string, number>>> = {
  duration: { us: 1, µs: 1, μs: 1, ms: 1e3, s: 1e6, sec: 1e6, m: 6e7, min: 6e7, h: 3.6e9 },
  bytes: { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4 },
  rate: { "/s": 1, "req/s": 1, rps: 1, "/min": 1 / 60, "/h": 1 / 3600 },
};

/** Default display unit for each kind (bare numbers are read in this unit). */
export const DEFAULT_UNIT: Record<UnitKind, string> = {
  duration: "ms", bytes: "MB", rate: "req/s", money: "$", count: "", fraction: "", number: "",
};

export function parseUnit(text: string, kind: UnitKind, unit = DEFAULT_UNIT[kind]): Parsed {
  const m = /^\s*\$?\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-zµμ/%$]*)\s*$/i.exec(text.replace(/[,_](?=\d)/g, ""));
  if (!m) return { ok: false, error: "Enter a number" + (unit ? ` (e.g. 2${unit === "$" ? "" : unit})` : "") };
  let value = Number(m[1]);
  const suffix = m[2].toLowerCase();
  if (!Number.isFinite(value)) return { ok: false, error: "Enter a finite number" };
  const table = FACTORS[kind];
  if (table) {
    const key = suffix || unit.toLowerCase();
    const f = table[key];
    if (f === undefined) return { ok: false, error: `Unknown unit "${m[2]}" — use ${Object.keys(table).slice(0, 5).join(", ")}` };
    value *= f;
  } else if (kind === "fraction") {
    if (suffix === "%") value /= 100;
    else if (suffix) return { ok: false, error: "Use a fraction (0.01) or a percentage (1%)" };
    if (value < 0 || value > 1) return { ok: false, error: "Must be between 0 and 1 (0%–100%)" };
  } else if (suffix && !(kind === "money" && suffix === "$")) {
    return { ok: false, error: "No unit expected" };
  }
  if (value < 0) return { ok: false, error: "Must not be negative" };
  if (kind === "count" || kind === "duration" || kind === "bytes") {
    value = Math.round(value);
    if (kind === "count" && !Number.isSafeInteger(value)) return { ok: false, error: "Too large" };
  }
  return { ok: true, value };
}

/** Base value -> number in the display unit, for the input box. */
export function toUnit(value: number, kind: UnitKind, unit = DEFAULT_UNIT[kind]): string {
  const f = FACTORS[kind]?.[unit.toLowerCase()] ?? 1;
  return String(+(value / f).toPrecision(6));
}

const nf = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function fmtMs(us: number | null | undefined): string {
  if (us == null) return "insufficient data";
  if (us >= 1e6) return `${nf.format(us / 1e6)} s`;
  if (us >= 1e3) return `${nf.format(us / 1e3)} ms`;
  return `${nf.format(us)} µs`;
}

export function fmtPct(x: number | null | undefined, digits = 1): string {
  return x == null ? "N/A" : `${(x * 100).toFixed(digits)}%`;
}

export function fmtNum(x: number): string {
  return nf.format(x);
}

export function fmtMoney(x: number): string {
  return new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(x);
}
