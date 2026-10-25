import type { Store } from "../persistence";

// Local-first: IndexedDB stays the source of truth and works signed out. Signed in, this mirrors
// designs, progress, reviews and run history (RunKey + summary, never raw events) to Postgres.

type Wire = { store: "designs" | "progress" | "reviews" | "runs"; key: string; data?: unknown; updatedAt: number; deleted?: boolean };
type Pulled = Wire & { seq: number };
type State = { cursor: number; pushedRevision: number; designs: string[] };
export type SyncResult = { pushed: number; pulled: number; rejected: string[] };

const BATCH = 100;
const stateKey = (userId: string) => `sds-sync:${userId}`;

function load(userId: string): State {
  try {
    return { cursor: 0, pushedRevision: 0, designs: [], ...JSON.parse(localStorage.getItem(stateKey(userId)) ?? "{}") };
  } catch {
    return { cursor: 0, pushedRevision: 0, designs: [] };
  }
}
const save = (userId: string, s: State) => {
  try {
    localStorage.setItem(stateKey(userId), JSON.stringify(s));
  } catch {
    /* sync restarts from scratch next time; harmless */
  }
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" }, credentials: "same-origin" });
  if (!res.ok) throw new Error(`sync ${res.status}`);
  return res.json() as Promise<T>;
}

export async function syncNow(store: Store, userId: string): Promise<SyncResult> {
  const st = load(userId);
  const [designs, progress, reviews, runs] = await Promise.all([store.designs.list(), store.progress.all(), store.reviews.all(), store.runs.all()]);
  const now = Date.now();

  const out: Wire[] = [];
  let maxRevision = st.pushedRevision;
  for (const d of designs) if (d.revision > st.pushedRevision) out.push({ store: "designs", key: d.id, data: d, updatedAt: d.updatedAt });
  for (const p of progress) if (p.revision > st.pushedRevision) out.push({ store: "progress", key: p.itemId, data: p, updatedAt: now });
  for (const r of reviews) if (r.revision > st.pushedRevision) out.push({ store: "reviews", key: r.itemId, data: r, updatedAt: r.updatedAt });
  for (const r of runs) if (r.revision > st.pushedRevision) out.push({ store: "runs", key: r.id, data: r, updatedAt: r.createdAt });
  for (const r of [...designs, ...progress, ...reviews, ...runs]) maxRevision = Math.max(maxRevision, r.revision);
  // A design that was synced before and is gone locally was deleted here: send a tombstone.
  const live = new Set(designs.map((d) => d.id));
  for (const id of st.designs) if (!live.has(id)) out.push({ store: "designs", key: id, deleted: true, updatedAt: now });

  let pushed = 0;
  const rejected: string[] = [];
  for (let i = 0; i < out.length; i += BATCH) {
    const r = await call<{ accepted: number; rejected: string[] }>("/api/sync", { method: "POST", body: JSON.stringify({ records: out.slice(i, i + BATCH) }) });
    pushed += r.accepted;
    rejected.push(...r.rejected);
  }

  let pulled = 0;
  let cursor = st.cursor;
  for (;;) {
    const page = await call<{ records: Pulled[]; cursor: number; hasMore: boolean }>(`/api/sync?since=${cursor}`);
    pulled += await store.remote.apply(page.records);
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  save(userId, { cursor, pushedRevision: maxRevision, designs: (await store.designs.list()).map((d) => d.id) });
  return { pushed, pulled, rejected };
}
