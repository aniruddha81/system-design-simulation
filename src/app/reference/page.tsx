import type { Metadata } from "next";
import type { ReactNode } from "react";
import { formatDuration } from "@/lib/format";
import { EstimationCalculator, NinesCalculator } from "./calculators";

export const metadata: Metadata = {
  title: "Reference",
  description: "Latency numbers every engineer should know, plus calculators for availability nines and back-of-envelope capacity estimates.",
  alternates: { canonical: "/reference" },
};

// Rounded orders of magnitude for 2020s server hardware; individual systems vary by 2–10×.
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
const MAX = Math.log10(LATENCIES.at(-1)![1] / LATENCIES[0][1]);

function Block({ id, title, kind, children, intro }: { id: string; title: string; kind: string; intro: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="panel p-5 sm:p-7">
      <div className="mb-6 max-w-2xl">
        <p className="text-sm text-muted">{kind}</p>
        <h2 id={id} className="text-2xl font-semibold tracking-tight">
          {title}
        </h2>
        <p className="mt-2 text-muted">{intro}</p>
      </div>
      {children}
    </section>
  );
}

export default function ReferencePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-12">
      <header className="mb-10 max-w-2xl">
        <h1 className="text-4xl font-semibold tracking-tight">Reference</h1>
        <p className="mt-4 text-lg leading-relaxed text-muted">
          The numbers you estimate with. Estimates use SI units: 1 KB is 1,000 bytes, and bandwidth is in bits per second.
        </p>
      </header>

      <div className="grid gap-8">
        <Block
          id="latency"
          title="Latency numbers"
          kind="Table"
          intro="Rounded orders of magnitude for current server hardware. Each bar is on a log scale, so every step right is ten times slower."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-[0.9375rem]">
              <caption className="sr-only">Typical latencies, fastest first</caption>
              <thead className="text-sm text-muted">
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Operation
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">
                    Typical
                  </th>
                  <th scope="col" className="w-2/5 py-2 font-normal">
                    <span className="sr-only">Relative scale</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {LATENCIES.map(([op, us]) => (
                  <tr key={op} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="py-2.5 pr-4 font-normal">
                      {op}
                    </th>
                    <td className="num whitespace-nowrap py-2.5 pr-4 text-right">{formatDuration(us)}</td>
                    <td aria-hidden className="py-2.5">
                      <div className="h-1.5 rounded-full bg-accent/70" style={{ width: `${Math.max(2, (Math.log10(us / LATENCIES[0][1]) / MAX) * 100)}%` }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-muted">
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
            .
          </p>
        </Block>

        <Block
          id="nines"
          title="Nines to downtime"
          kind="Calculator"
          intro="How much downtime an availability target allows. Request-based availability over a short run is not the same as yearly SLA attainment."
        >
          <NinesCalculator />
        </Block>

        <Block
          id="estimate"
          title="Load, storage and bandwidth"
          kind="Calculator"
          intro="Back-of-envelope sizing from daily users. Peak load is what you provision for; storage counts every replica."
        >
          <EstimationCalculator />
        </Block>
      </div>
    </div>
  );
}
