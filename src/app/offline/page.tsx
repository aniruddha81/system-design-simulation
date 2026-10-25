import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Offline", robots: { index: false } };

export default function OfflinePage() {
  return <section className="mx-auto max-w-2xl px-4 py-16">
    <p className="stamp">Offline copy unavailable</p>
    <h1 className="mt-4 font-display text-4xl">This page needs a connection</h1>
    <p className="mt-4 text-ink-2">Your device&apos;s saved designs and progress remain in IndexedDB. Previously cached lessons and case studies can open offline. Sync and account actions need a connection.</p>
    <Link prefetch={false} href="/learn" className="mt-6 inline-flex min-h-6 items-center underline">Open the learning notebook</Link>
    <p className="mt-4 text-sm text-muted">Reconnect, then reload your original page to try again. Browser storage limits can remove offline copies.</p>
  </section>;
}
