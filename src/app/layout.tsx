import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { ViewTransition } from "react";
import { NavLinks, Providers, ThemeToggle } from "@/components/ui/shell";
import { SITE_NAME, SITE_URL } from "@/lib/content/schema";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const description =
  "Learn system design by running it: step-by-step lessons, a simulator you can break, and graded challenges with explained verdicts.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description,
  openGraph: { siteName: SITE_NAME, type: "website", description },
};

// Mirrors applyPrefs() in components/ui/shell.tsx; runs before first paint (no theme flash).
const PREFS_SCRIPT = `(function(){try{var d=document.documentElement,t=localStorage.getItem("theme")||"system",m=localStorage.getItem("motion")||"system";if(t==="system")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";d.setAttribute("data-theme",t);if(m!=="system")d.setAttribute("data-motion",m)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREFS_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-accent px-4 py-2 font-medium text-accent-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to content
        </a>
        <Providers>
          <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md">
            <div className="brand-rule" aria-hidden />
            <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 px-4 sm:flex-nowrap">
              <Link href="/" className="flex min-h-14 flex-1 items-center gap-2.5 font-semibold tracking-tight sm:flex-none">
                <Logo />
                <span>System Design Simulator</span>
              </Link>
              <div className="order-last -mx-4 w-[calc(100%+2rem)] border-t border-border px-2 py-1 sm:order-none sm:mx-0 sm:ml-auto sm:w-auto sm:border-0 sm:p-0">
                <NavLinks />
              </div>
              <ThemeToggle />
            </nav>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 outline-none">
            <ViewTransition>{children}</ViewTransition>
          </main>
          <footer className="border-t border-border">
            <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
              <p>
                <strong className="font-medium text-fg">Progress lives on this device.</strong> No account, no server copy.
                Export a backup from <Link href="/settings" className="underline underline-offset-4 hover:text-fg">Settings</Link>.
              </p>
              <p>English only. Simulations are models, not packet-level networks.</p>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}

function Logo() {
  // A request path: client node → fork into cache and store.
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="none">
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6" stroke="url(#logo-g)" strokeWidth="1.5" />
      <circle cx="7" cy="12" r="2" fill="var(--accent)" />
      <path d="M9 12h3l4-4M12 12l4 4" stroke="url(#logo-g)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="17" cy="7.5" r="1.6" fill="var(--accent-2)" />
      <circle cx="17" cy="16.5" r="1.6" fill="var(--accent-2)" />
    </svg>
  );
}
