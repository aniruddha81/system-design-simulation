import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PasswordForm } from "../password-form";

export const metadata: Metadata = { title: "Reset password", robots: { index: false }, referrer: "no-referrer" };

async function Reset({ searchParams }: { searchParams: Promise<{ token?: string | string[]; error?: string | string[] }> }) {
  const params = await searchParams;
  return <PasswordForm mode="reset" token={!params.error && typeof params.token === "string" ? params.token : undefined} />;
}

export default function ResetPage(props: { searchParams: Promise<{ token?: string | string[]; error?: string | string[] }> }) {
  return <div className="mx-auto grid max-w-xl gap-5 px-4 py-10"><h1 className="font-display text-4xl">Reset password</h1><Suspense fallback={<p aria-busy="true">Loading?</p>}><Reset {...props} /></Suspense><Link className="inline-flex min-h-6 underline" href="/account">Back to account</Link></div>;
}
