"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { PasswordForm, VerificationNotice } from "./password-form";
import { syncRequest } from "@/components/auth/CloudSync";
import { useSyncState } from "@/components/auth/sync-status";
import { Stats } from "@/components/visual/kit";
import { signIn, signOut, signUp, authClient, useSession } from "@/lib/auth-client";

const field = "min-h-11 w-full rounded-md border border-rule bg-bg px-3 focus-visible:outline-2 focus-visible:outline-accent";

export function AccountView({ providers, emailEnabled }: { providers: ("github" | "google")[]; emailEnabled: boolean }) {
  const { data, isPending } = useSession();
  if (isPending) return <p aria-busy className="text-muted">Loading…</p>;
  return data ? <Signed name={data.user.name} email={data.user.email} verify={emailEnabled && !data.user.emailVerified} /> : <Form providers={providers} emailEnabled={emailEnabled} />;
}

function Form({ providers, emailEnabled }: { providers: ("github" | "google")[]; emailEnabled: boolean }) {
  const [verificationEmail, setVerificationEmail] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    setBusy(true);
    setError("");
    try {
      const { error } = mode === "in" ? await signIn.email({ email, password }) : await signUp.email({ email, password, name: String(f.get("name")), callbackURL: "/account" });
      if (error) {
        setError(error.message ?? "Something went wrong. Try again.");
        if (error.code === "EMAIL_NOT_VERIFIED" && emailEnabled) setVerificationEmail(email);
      } else if (mode === "up" && emailEnabled) setVerificationEmail(email);
    } catch {
      setError("Could not connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="acc" className="grid gap-5">
      <h1 id="acc" className="font-display text-4xl">{mode === "in" ? "Sign in" : "Create account"}</h1>
      <p className="text-muted">Optional. Sync progress and designs across devices.</p>
      <div role="group" aria-label="Mode" className="grid grid-cols-2 gap-2">
        <button type="button" className="btn" aria-pressed={mode === "in"} onClick={() => setMode("in")}>Sign in</button>
        <button type="button" className="btn" aria-pressed={mode === "up"} onClick={() => setMode("up")}>Create account</button>
      </div>
      <form onSubmit={submit} className="grid gap-4">
        {mode === "up" && (
          <label className="grid gap-1">Name<input name="name" required maxLength={80} autoComplete="name" className={field} /></label>
        )}
        <label className="grid gap-1">Email<input name="email" type="email" required autoComplete="email" className={field} /></label>
        <label className="grid gap-1">
          Password
          <input name="password" type="password" required minLength={10} maxLength={128} autoComplete={mode === "in" ? "current-password" : "new-password"} className={field} />
          {mode === "up" && <span className="text-sm text-muted">10+ characters</span>}
        </label>
        {error && <p role="alert" className="text-danger"><span aria-hidden>✕ </span>{error}</p>}
        <button className="btn btn-primary" disabled={busy}>{busy ? "…" : mode === "in" ? "Sign in" : "Create account"}</button>
      </form>
      <Link className="inline-flex min-h-6 items-center underline" href="/account/forgot">Forgot password?</Link>
      {verificationEmail && <VerificationNotice email={verificationEmail} />}
      {providers.map((p) => (
        <button key={p} className="btn" onClick={() => signIn.social({ provider: p, callbackURL: "/account" })}>Continue with {p === "github" ? "GitHub" : "Google"}</button>
      ))}
    </section>
  );
}

function Signed({ name, email, verify }: { name: string; email: string; verify: boolean }) {
  const sync = useSyncState();
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const tone = { off: "muted", idle: "ok", syncing: "warn", error: "bad" } as const;
  const word = { off: "Off", idle: "Synced", syncing: "Syncing", error: "Failed" } as const;

  async function erase() {
    const { error } = await authClient.deleteUser(password ? { password } : {});
    if (error) setError(error.message ?? "Could not delete the account.");
    else if (!password) setError("Check your email for a link that confirms the deletion.");
  }

  return (
    <section aria-labelledby="acc" className="grid gap-6">
      <div className="flex items-center gap-4">
        <span aria-hidden className="grid size-14 place-items-center rounded-full border border-rule bg-surface font-display text-2xl uppercase">{name.slice(0, 1)}</span>
        <div>
          <h1 id="acc" className="font-display text-3xl">{name}</h1>
          <p className="text-muted">{email}</p>
        </div>
      </div>
      {verify && <VerificationNotice email={email} />}
      <Stats
        title="Sync status"
        items={[
          { label: "Status", value: word[sync.phase], tone: tone[sync.phase] },
          { label: "Uploaded", value: String(sync.last?.pushed ?? 0) },
          { label: "Downloaded", value: String(sync.last?.pulled ?? 0) },
          { label: "Last sync", value: sync.at ? new Date(sync.at).toLocaleTimeString() : "—" },
        ]}
      />
      {!!sync.last?.rejected.length && <p role="alert" className="text-warning"><span aria-hidden>! </span>{sync.last.rejected.length} record(s) were not accepted.</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn" onClick={() => syncRequest()} disabled={sync.phase === "syncing"}>Sync now</button>
        <button className="btn" onClick={() => signOut()}>Sign out</button>
      </div>
      <section className="grid gap-4 border-t border-rule pt-4" aria-labelledby="change-password"><h2 id="change-password" className="font-display text-2xl">Change password</h2><PasswordForm mode="change" /></section>
      <details className="rounded-md border border-rule p-4">
        <summary className="cursor-pointer font-medium text-danger">Delete account</summary>
        <p className="mt-2 text-sm text-muted">Erases your account and every synced record. Local data stays on this device.</p>
        <label className="mt-3 grid gap-1 text-sm">Type DELETE<input value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} /></label>
        <label className="mt-3 grid gap-1 text-sm">Password (or leave empty to confirm by email)<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} /></label>
        {error && <p role="alert" className="mt-2 text-danger"><span aria-hidden>! </span>{error}</p>}
        <button className="btn mt-3" disabled={confirm !== "DELETE"} onClick={erase}>Delete my account</button>
      </details>
    </section>
  );
}
