import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Bars, type BarItem } from "@/components/visual/kit";
import { EstimationCalculator, NinesCalculator } from "./calculators";

export const metadata: Metadata = {
  title: "Reference",
  description: "Latency numbers every engineer should know, plus calculators for availability nines and back-of-envelope capacity estimates.",
  alternates: { canonical: "/reference" },
};

// Rounded orders of magnitude for 2020s server hardware; individual systems vary by 2–10×.
// Values are microseconds; the tone groups memory, local I/O, and the wide area.
const LATENCIES: [string, number][] = [
  ["L1 cache reference", 0.001],
  ["Branch mispredict", 0.003],
  ["L2 cache reference", 0.004],
  ["Mutex lock/unlock", 0.017],
  ["Main memory reference", 0.1],
  ["Compress 1 KB with a fast codec", 2],
  ["Send 1 KB over a 1 Gbps link", 8],
  ["Read 4 KB randomly from an NVMe SSD", 20],
  ["Read 1 MB sequentially from memory", 50],
  ["Read 1 MB sequentially from an NVMe SSD", 300],
  ["Round trip within a datacenter", 500],
  ["Disk seek (spinning disk)", 5_000],
  ["Read 1 MB sequentially from a spinning disk", 5_000],
  ["Round trip US East ↔ US West", 70_000],
  ["Round trip California ↔ Netherlands", 150_000],
];
const BARS: BarItem[] = LATENCIES.map(([label, value]) => ({ label, value, unit: "µs", tone: value < 1 ? "ok" : value < 1_000 ? "info" : value < 50_000 ? "warn" : "bad" }));

const TOOLS: { id: string; title: string; icon: ReactNode }[] = [
  {
    id: "latency",
    title: "Latency",
    icon: <path d="M6 34V26M16 34V18M26 34V12M36 34V6M3 38h38" />,
  },
  {
    id: "nines",
    title: "Nines",
    icon: <path d="M6 32a16 16 0 0 1 32 0M22 32l8-12M8 32h4M32 32h4M22 16v4" />,
  },
  {
    id: "estimate",
    title: "Capacity",
    icon: <path d="M10 4h24v36H10zM15 10h14v7H15zM15 23h4M25 23h4M15 29h4M25 29h4M15 35h4M25 35h4" />,
  },
];

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-24 border-t-2 border-fg pt-6">
      <h2 id={id} className="mb-4 font-display text-3xl tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function ReferencePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-12">
      <header className="mb-8 max-w-2xl">
        <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">Reference</h1>
        <p className="mt-3 text-lg text-ink-2">Numbers to estimate with. SI units: 1 KB is 1,000 bytes.</p>
      </header>

      <nav aria-label="Reference tools" className="mb-12">
        <ul className="grid grid-cols-3 gap-3">
          {TOOLS.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} className="paper-grid grid min-h-24 justify-items-center gap-1 rounded-md border border-rule bg-surface p-3 text-center hover:bg-surface-2">
                <svg aria-hidden viewBox="0 0 44 44" className="size-10 text-accent-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {t.icon}
                </svg>
                <span className="font-display text-lg">{t.title}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="grid gap-14">
        <Block id="latency" title="Latency numbers">
          <Bars title="Typical latencies, fastest first" items={BARS} log />
          <p className="text-sm text-muted">
            Sources:{" "}
            <a className="underline underline-offset-4 hover:text-fg" href="https://norvig.com/21-days.html#answers" target="_blank" rel="noopener noreferrer">
              Peter Norvig and Jeff Dean, approximate timing for various operations
            </a>
            ;{" "}
            <a
              className="underline underline-offset-4 hover:text-fg"
              href="https://colin-scott.github.io/personal_website/research/interactive_latency.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              Colin Scott, Latency numbers every programmer should know (interactive)
            </a>
            . Rounded; real systems vary by 2–10×.
          </p>
        </Block>

        <Block id="nines" title="Nines to downtime">
          <NinesCalculator />
        </Block>

        <Block id="estimate" title="Load, storage and bandwidth">
          <EstimationCalculator />
        </Block>
      </div>
    </div>
  );
}
