import type { Metadata, Viewport } from "next";
import { Fraunces, IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";
import Link from "next/link";
import { ViewTransition } from "react";
import { MobileNavMenu, NavLinks, Providers, ThemeToggle } from "@/components/ui/shell";
import { CommandPalette } from "@/components/search";
import { SITE_NAME, SITE_URL } from "@/lib/content/schema";
import "./globals.css";

// Display: Fraunces (soft, wonky italic for flourishes). Text: Schibsted Grotesk. Data: IBM Plex Mono.
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], style: ["normal", "italic"], axes: ["SOFT", "WONK", "opsz"] });
const schibsted = Schibsted_Grotesk({ variable: "--font-schibsted", subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

const description =
  "Learn system design by running it: step-by-step lessons, a simulator you can break, and graded challenges with explained verdicts.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description,
  openGraph: { siteName: SITE_NAME, type: "website", description },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2efe6" },
    { media: "(prefers-color-scheme: dark)", color: "#111916" },
  ],
};

// Mirrors applyPrefs() in components/ui/shell.tsx; runs before first paint (no theme flash).
// Paper by default; saved Slate and explicit System preferences are respected.
const PREFS_SCRIPT = `(function(){try{var d=document.documentElement,t=localStorage.getItem("theme")||"light",m=localStorage.getItem("motion")||"system";if(t==="system")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";d.setAttribute("data-theme",t);if(m!=="system")d.setAttribute("data-motion",m)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${fraunces.variable} ${schibsted.variable} ${plexMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREFS_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col overflow-x-clip">
        <a
          href="#main"
          className="sr-only z-50 rounded-sm bg-accent px-4 py-2 font-medium text-accent-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to content
        </a>
        <Providers>
          <header className="sticky top-0 z-40 border-b border-rule bg-surface-2">
            <nav
              aria-label="Main"
              className="mx-auto flex h-13 max-w-7xl flex-nowrap items-center justify-between gap-2 px-3 sm:gap-4 sm:px-6"
            >
              <Link
                href="/"
                className="group flex min-w-0 shrink-0 items-center gap-2 py-1 sm:gap-2.5 lg:border-r lg:border-border lg:pr-5"
              >
                <Logo />
                <span className="truncate font-display text-[1rem] leading-none tracking-tight sm:text-[1.125rem]">
                  System Design <em className="text-accent">Simulator</em>
                </span>
              </Link>
              <div className="hidden min-w-0 flex-1 self-end lg:block">
                <NavLinks />
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2 lg:ml-0">
                <CommandPalette />
                <ThemeToggle />
                <MobileNavMenu />
              </div>
            </nav>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 overflow-x-clip outline-none">
            <ViewTransition>{children}</ViewTransition>
          </main>
          <Colophon />
        </Providers>
      </body>
    </html>
  );
}

function Colophon() {
  return (
    <footer className="mt-auto bg-surface-2">
      <div className="mx-auto max-w-6xl px-4 pb-10 pt-3">
        <div className="rule-manual" aria-hidden />
        <div className="mt-8 grid gap-8 md:grid-cols-[1.2fr_1fr] md:items-end">
          <p className="font-display text-3xl leading-tight tracking-tight sm:text-4xl">
            Draw it, run it, <em className="text-accent">break it</em>, then explain it.
          </p>
          <div className="grid gap-3 text-sm text-muted">
            <p>
              <strong className="font-medium text-fg">Progress lives on this device.</strong> No account, no server copy. Export a backup from{" "}
              <Link href="/settings" className="text-fg underline underline-offset-4 hover:text-accent">
                Settings
              </Link>
              .
            </p>
            <p>English only. Simulations are models, not packet-level networks.</p>
          </div>
        </div>
      </div>
    </footer>
  );
}

function Logo() {
  // A pencil sketch of the product: a request forks into a cache and a store.
  return (
    <svg aria-hidden viewBox="0 0 28 28" className="size-6 shrink-0 sm:size-7" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.6 3.4c7.6-.6 15.2-.5 22.8-.2.6 7.1.7 14.2.3 21.4-7.6.5-15.2.5-22.8.1-.5-7.1-.6-14.2-.3-21.3Z" stroke="var(--text)" strokeWidth="1.4" />
      <circle cx="8" cy="14" r="2.3" fill="var(--accent)" />
      <path d="M10.4 14h3.4l4.3-4.6M13.8 14l4.3 4.4" stroke="var(--text)" strokeWidth="1.4" />
      <rect x="18.3" y="7" width="4.4" height="4.4" rx=".6" fill="var(--highlight)" stroke="var(--text)" strokeWidth="1.2" />
      <path d="M18.4 17.4c1.4-.5 3-.5 4.4 0v3.6c-1.4.5-3 .5-4.4 0Z" stroke="var(--accent-2)" strokeWidth="1.3" />
    </svg>
  );
}
