import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms", description: "Plain-language terms for this system-design learning tool." };

export default function TermsPage() {
  return <article className="mx-auto max-w-3xl px-4 py-12">
    <p className="figcap">Before you run it</p><h1 className="mt-2 font-display text-4xl">Terms</h1>
    <div className="mt-8 grid gap-4 sm:grid-cols-2">{[
      ["Learn and experiment", "Use the lessons and simulator responsibly. Do not abuse the service or upload secrets or other people's personal data."],
      ["Models have limits", "Simulations simplify real systems. Costs and availability are estimates, with no promise of production accuracy or uninterrupted service."],
      ["Keep a backup", "Offline copies can be evicted by your browser. Export from Settings regularly; sync is not a backup guarantee."],
      ["You control your records", "Accounts are optional. Export in Settings. Use Account, then Delete account to erase cloud data; reset local data separately in Settings."],
    ].map(([title, text]) => <section key={title} className="border-y border-rule bg-surface p-4"><h2 className="font-display text-xl">{title}</h2><p className="mt-2 text-sm text-ink-2">{text}</p></section>)}</div>
    <p className="mt-8">See <Link href="/privacy" className="inline-flex min-h-6 items-center underline">Privacy</Link> for storage, sync and cookies.</p>
    <p className="mt-6 text-sm text-muted">Contact: Open an issue on the project repository.</p>
    <p className="mt-4 border-l-2 border-rule pl-4 text-sm text-muted">This is not legal advice. The operator should review these terms before launch.</p>
  </article>;
}
