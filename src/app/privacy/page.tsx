import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy", description: "Where your learning data lives and how to export or delete it." };

export default function PrivacyPage() {
  return <article className="mx-auto max-w-3xl px-4 py-12">
    <p className="figcap">Your data notebook</p>
    <h1 className="mt-2 font-display text-4xl">Privacy</h1>
    <p className="mt-4 text-ink-2">An account is optional. No analytics by default.</p>
    <div className="mt-8 overflow-x-auto"><table className="w-full text-left text-sm">
      <caption className="mb-3 text-left font-display text-xl">What is stored where</caption>
      <thead><tr className="border-b border-rule"><th scope="col" className="p-3">Data</th><th scope="col" className="p-3">On this device</th><th scope="col" className="p-3">Signed in + sync</th></tr></thead>
      <tbody>{[
        ["Designs, progress, reviews", "IndexedDB", "Neon Postgres"],
        ["Run summaries", "IndexedDB", "Neon Postgres"],
        ["Raw simulation events", "Device only", "Never sent by sync"],
        ["Account and sessions", "Sign-in cookies", "Neon Postgres"],
        ["Visited public pages and assets", "Browser offline cache", "Not synced"],
      ].map(([data, local, cloud]) => <tr key={data} className="border-b border-rule"><th scope="row" className="p-3 font-medium">{data}</th><td className="p-3">{local}</td><td className="p-3">{cloud}</td></tr>)}</tbody>
    </table></div>
    <section className="mt-8"><h2 className="font-display text-2xl">Sync and sign-in</h2>
      <p className="mt-3">Sync sends designs, progress, reviews and run summaries. The database region is Singapore. Sign-in uses a session cookie; the current authentication configuration also enables a short-lived session cache cookie. Preferences stay on your device.</p>
    </section>
    <section className="mt-8"><h2 className="font-display text-2xl">Export or erase</h2>
      <p className="mt-3">Export your local backup from <Link className="inline-flex min-h-6 items-center underline" href="/settings">Settings</Link>. Let sync finish first to include cloud records. To delete your account and synced data, open <Link className="inline-flex min-h-6 items-center underline" href="/account">Account</Link>, then Delete account. Reset local data separately in Settings; clear site data in your browser to remove offline copies.</p>
    </section>
    <p className="mt-8 text-sm text-muted">Contact: Open an issue on the project repository.</p>
    <p className="mt-4 border-l-2 border-rule pl-4 text-sm text-muted">This is not legal advice. The operator should review this notice before launch.</p>
    <Link href="/terms" className="mt-6 inline-flex min-h-6 items-center underline">Read the terms</Link>
  </article>;
}
