"use client";
import Link from "next/link";
import { useEffect } from "react";
import { reportError } from "@/lib/report-error";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { reportError(error); }, [error]);
  return <main style={{ padding: "48px 16px", maxWidth: 640, margin: "auto", color: "var(--text)", background: "var(--bg)" }}>
    <svg aria-hidden="true" width="96" height="80" viewBox="0 0 96 80" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 6h40l12 12v56H22zM62 6v14h12M32 34h32M32 44h24M32 54h12"/><path d="m62 49 12 12m0-12L62 61"/></svg>
    <h1 style={{ fontFamily: "var(--font-display), serif" }}>This page hit a snag</h1>
    <p>Your saved work stays on this device. Try loading this page again.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 24 }}>
      <button onClick={retry} style={{ minHeight: 44, padding: "8px 16px", border: "1px solid var(--rule)", borderRadius: 4, cursor: "pointer" }}>Try again</button>
      <Link href="/" style={{ display: "inline-flex", alignItems: "center", minHeight: 44, padding: "8px 16px", textDecoration: "underline" }}>Go home</Link>
    </div>
  </main>;
}
