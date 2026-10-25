"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

const field = "min-h-11 w-full rounded-md border border-rule bg-bg px-3 focus-visible:outline-2 focus-visible:outline-accent";

export function PasswordForm({ mode, token }: { mode: "forgot" | "reset" | "change"; token?: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    try {
      if (mode === "forgot") {
        await authClient.requestPasswordReset({ email: String(data.get("email")), redirectTo: "/account/reset" });
      } else {
        const result = mode === "reset"
          ? await authClient.resetPassword({ token, newPassword: String(data.get("password")) })
          : await authClient.changePassword({ currentPassword: String(data.get("current")), newPassword: String(data.get("password")), revokeOtherSessions: true });
        if (result.error) {
          setError(result.error.code === "INVALID_TOKEN" ? "This link is invalid or expired. Request a new link." : result.error.message ?? "Could not update password. Try again.");
          return;
        }
      }
      form.reset();
      setDone(true);
    } catch {
      if (mode === "forgot") setDone(true);
      else setError("Could not update password. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (mode === "reset" && !token) return <p role="alert"><span aria-hidden>! </span>This link is invalid or expired. <Link className="inline-flex min-h-6 underline" href="/account/forgot">Request a new link</Link></p>;
  if (done) return <p role="status">{mode === "forgot" ? "If an account matches that email, you will receive a reset link." : "Password updated."} {mode === "reset" && <Link className="inline-flex min-h-6 underline" href="/account">Sign in</Link>}</p>;
  return <form onSubmit={submit} className="grid gap-4">
    {mode === "forgot" ? <label className="grid gap-1">Email<input className={field} name="email" type="email" autoComplete="email" required /></label> : <>
      {mode === "change" && <label className="grid gap-1">Current password<input className={field} name="current" type="password" autoComplete="current-password" required /></label>}
      <label className="grid gap-1">New password<input className={field} name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} required /><span className="text-sm text-muted">10?128 characters</span></label>
    </>}
    {error && <p role="alert" className="text-danger"><span aria-hidden>! </span>{error} {mode === "reset" && <Link className="inline-flex min-h-6 underline" href="/account/forgot">Request a new link</Link>}</p>}
    <button className="btn btn-primary" disabled={busy}>{busy ? "Please wait…" : mode === "forgot" ? "Send reset link" : "Update password"}</button>
  </form>;
}

export function VerificationNotice({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  async function resend() {
    setBusy(true);
    setError("");
    setSent(false);
    try {
      const result = await authClient.sendVerificationEmail({ email, callbackURL: "/account" });
      if (result.error) setError("Could not send email. Try again.");
      else setSent(true);
    } catch {
      setError("Could not send email. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return <section className="grid gap-2 rounded-md border border-rule p-4" aria-label="Email verification">
    <h2 className="font-display text-2xl">Verify your email</h2>
    <p className="text-muted">Open the link in your inbox.</p>
    <button className="btn" disabled={busy} onClick={resend}>{busy ? "Sending…" : "Resend email"}</button>
    {sent && <p role="status">Verification email sent.</p>}
    {error && <p role="alert" className="text-danger"><span aria-hidden>! </span>{error}</p>}
  </section>;
}
