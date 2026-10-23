"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cacheAsideDesign, noCacheDesign } from "@/engine/fixtures";
import type { Design } from "@/engine/types";
import { newId, openStore, type DesignRecord } from "@/lib/persistence";

const TEMPLATES: { id: string; title: string; blurb: string; make: () => Design }[] = [
  {
    id: "empty", title: "Empty board", blurb: "Start from nothing. The GET/PUT user endpoints are pre-declared so the caching scenario can drive traffic.",
    make: () => ({ schemaVersion: 1, id: "", name: "Untitled design", nodes: [], edges: [], endpoints: structuredClone(cacheAsideDesign.endpoints) }),
  },
  { id: "no-cache", title: "Without caching", blurb: "Client → load balancer → two services → database. Every read hits the database.", make: () => structuredClone(noCacheDesign) },
  { id: "cache-aside", title: "Cache-aside", blurb: "Services check the cache first, read the database on a miss and invalidate on writes.", make: () => structuredClone(cacheAsideDesign) },
];

async function createDraft(design: Design): Promise<string> {
  const id = newId();
  const now = Date.now();
  const store = await openStore();
  await store.designs.put({ schemaVersion: 1, id, design: { ...design, id }, revision: 0, createdAt: now, updatedAt: now }, 0);
  return id;
}

export function TemplatePicker() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<DesignRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(false);

  // /sandbox?template=cache-aside (linked from lessons) opens that template directly.
  // Read client-side so the page stays static; the ref stops Activity re-shows from creating duplicates.
  useEffect(() => {
    const t = TEMPLATES.find((x) => x.id === new URLSearchParams(location.search).get("template"));
    if (!t || opened.current) return;
    opened.current = true;
    createDraft(t.make()).then((id) => router.replace(`/sandbox/${id}`)).catch(() => {});
  }, [router]);

  useEffect(() => {
    openStore()
      .then((s) => s.designs.list())
      .then((list) => setDrafts(list.filter((r) => !r.id.startsWith("challenge-")).sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch(() => setDrafts([]));
  }, []);

  async function create(make: () => Design) {
    setError(null);
    try {
      router.push(`/sandbox/${await createDraft(make())}`);
    } catch (e) {
      setError(`Couldn't create the draft: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="tpl-h">
        <h2 id="tpl-h" className="mb-3 text-xs font-medium uppercase tracking-wider text-(--text-muted)">Start from a template</h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {TEMPLATES.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => void create(t.make)}
                className="flex h-full w-full flex-col gap-1.5 rounded-(--radius) border border-(--border) bg-(--surface) p-4 text-left transition-colors hover:border-(--accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
              >
                <span className="font-medium text-(--text)">{t.title}</span>
                <span className="text-sm text-(--text-muted)">{t.blurb}</span>
              </button>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="mt-3 text-sm text-(--danger)">✕ {error}</p>}
      </section>
      <section aria-labelledby="drafts-h">
        <h2 id="drafts-h" className="mb-3 text-xs font-medium uppercase tracking-wider text-(--text-muted)">Your drafts (this browser)</h2>
        {drafts === null ? (
          <div className="h-12 animate-pulse rounded-(--radius) bg-(--surface) motion-reduce:animate-none" />
        ) : drafts.length === 0 ? (
          <p className="text-sm text-(--text-muted)">No drafts yet.</p>
        ) : (
          <ul className="divide-y divide-(--border) rounded-(--radius) border border-(--border) bg-(--surface)">
            {drafts.map((d) => (
              <li key={d.id}>
                <Link href={`/sandbox/${d.id}`} className="flex min-h-11 items-center justify-between gap-4 px-4 py-2 hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)">
                  <span className="truncate">{d.design.name}</span>
                  <span className="shrink-0 text-xs text-(--text-muted)">{d.design.nodes.length} components · {new Date(d.updatedAt).toLocaleString()}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
