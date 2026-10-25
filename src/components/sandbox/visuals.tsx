export function EmptyPlot({ caption }: { caption: string }) {
  return <figure className="grid justify-items-center gap-2 py-4 text-center text-sm text-muted">
    <svg aria-hidden="true" viewBox="0 0 160 64" className="h-16 w-40" fill="none" stroke="var(--rule)" strokeWidth="2">
      <path d="M8 8v48h144" /><path d="m16 48 28-12 28 6 28-24 40-8" stroke="var(--accent-2)" strokeDasharray="4 4" />
      <circle cx="100" cy="18" r="4" fill="var(--surface)" />
    </svg><figcaption>{caption}</figcaption>
  </figure>;
}
