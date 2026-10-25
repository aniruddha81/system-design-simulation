import type { Metadata } from "next";
import Link from "next/link";
import { PasswordForm } from "../password-form";

export const metadata: Metadata = { title: "Forgot password?", robots: { index: false }, referrer: "no-referrer" };

export default function ForgotPage() {
  return <div className="mx-auto grid max-w-xl gap-5 px-4 py-10"><h1 className="font-display text-4xl">Forgot password?</h1><PasswordForm mode="forgot" /><Link className="inline-flex min-h-6 underline" href="/account">Back to account</Link></div>;
}
