"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { useProgress } from "@/components/lesson/progress";
import { Ring, RingText } from "@/components/lesson/ring";
import { formatPercent } from "@/lib/format";

export type AssignableItem = {
  key: string;
  id: string;
  kind: "lesson" | "challenge" | "case-study";
  title: string;
  subtitle: string;
  href: string;
  interviewHref?: string;
};

type ClassroomDemo = {
  id: string;
  title: string;
  concept: string;
  duration: string;
  launchHref: string;
  launchLabel: string;
  steps: [string, string, string];
  question: string;
};

const CLASSROOM_DEMOS: ClassroomDemo[] = [
  {
    id: "stampede",
    title: "1. Cold-Cache Restart & Stampede Coalescing",
    concept: "Track 1 · Caching & Request Coalescing",
    duration: "5 min live demo",
    launchHref: "/challenges/cache-aside-recovery",
    launchLabel: "Open Cache Recovery Challenge",
    steps: [
      "Run the starter: DB at 100%, p99 above 250 ms.",
      "Add a cache on both edges; compare coalescing off and on.",
      "At t = 7 s, show coalescing absorb the stampede.",
    ],
    question: "Why does a cache without coalescing still fail on restart?",
  },
  {
    id: "oversell",
    title: "2. Flash-Sale Concurrency Race (Oversell)",
    concept: "Track 2 · Transactions & Atomic Conditional Writes",
    duration: "5 min live demo",
    launchHref: "/challenges/flash-sale-no-oversell",
    launchLabel: "Open Flash-Sale Challenge",
    steps: [
      "Run 1,000 RPS at 100 seats; open Invariants.",
      "Trace two buyers reading remaining = 1.",
      "Swap in atomic decrementIfPositive; see clean 409s.",
    ],
    question: "Would more DB concurrency help or hurt the race?",
  },
  {
    id: "lost-ack",
    title: "3. Lost Payment Ack & Idempotency Keys",
    concept: "Track 2 · Retries, Network Partitions & Deduplication",
    duration: "6 min live demo",
    launchHref: "/challenges/idempotent-payment-retry",
    launchLabel: "Open Idempotent Payment Challenge",
    steps: [
      "Drop the ack at 10.6 ms; the ledger already committed.",
      "Spot the duplicateEffect on retry.",
      "Check the dedup store first; branch on dedupHit.",
    ],
    question: "What if the idempotency store loses state on restart?",
  },
  {
    id: "failover",
    title: "4. Unfenced Primary Failover & Split-Brain",
    concept: "Track 2 · Replication Lag, Promotion & Fencing Tokens",
    duration: "7 min live demo",
    launchHref: "/challenges/fenced-leader-failover",
    launchLabel: "Open Fenced Failover Challenge",
    steps: [
      "Crash the primary; read both violations.",
      "Async acks vanish; the old leader writes stale terms.",
      "Switch to semiSync and enable fencing.",
    ],
    question: "Full sync (3) or semi-sync (2 of 3): what is the trade-off?",
  },
  {
    id: "quorum",
    title: "5. Sloppy vs. Intersecting Dynamo Quorums",
    concept: "Track 2 · Leaderless Replication & Read/Write Quorums",
    duration: "5 min live demo",
    launchHref: "/challenges/quorum-fresh-reads",
    launchLabel: "Open Quorum Fresh Reads Challenge",
    steps: [
      "Run R = 1, W = 1 at 50% writes; find staleRead.",
      "R + W = 2 is at most N = 3: no overlap.",
      "Set R = 2, W = 2; every read overlaps.",
    ],
    question: "With R = 1 on N = 3, what must W be?",
  },
  {
    id: "breaking-point",
    title: "6. Planet-Scale Breaking-Point Load Sweep",
    concept: "Track 3 · Capacity Planning & Saturation Cliffs",
    duration: "6 min live demo",
    launchHref: "/sandbox?ref=global-cdn",
    launchLabel: "Open Global CDN in Sandbox",
    steps: [
      "Open Global CDN; click Find breaking point.",
      "Watch the load sweep reach the SLO cliff.",
      "Fix the bottleneck; re-run to see the new ceiling.",
    ],
    question: "Why does p99 spike near 80-85% utilisation?",
  },
];

type SyllabusPreset = {
  id: string;
  title: string;
  description: string;
  items: string[];
};

const SYLLABUS_PRESETS: SyllabusPreset[] = [
  {
    id: "week-1",
    title: "Module 1: Queueing, Latency & Caching Fundamentals",
    description:
      "Little's Law, tail latency math, cache-aside mechanics, and the cold-cache recovery challenge.",
    items: [
      "lesson:foundations/performance-metrics-littles-law",
      "lesson:foundations/queueing-tail-latency",
      "lesson:building-blocks/caching",
      "challenge:cache-aside-recovery",
    ],
  },
  {
    id: "week-2",
    title: "Module 2: Concurrency, Idempotency & Queues",
    description:
      "Atomic conditional updates, idempotency keys under lost acks, and partitioned queue visibility timeouts.",
    items: [
      "lesson:building-blocks/queues-streams",
      "challenge:flash-sale-no-oversell",
      "challenge:idempotent-payment-retry",
      "challenge:ordered-queue-visibility",
    ],
  },
  {
    id: "week-3",
    title: "Module 3: Replication, Quorums & Split-Brain",
    description:
      "Leader–follower failover, fencing tokens, and Dynamo quorum intersection.",
    items: [
      "lesson:distributed-systems/replication",
      "lesson:distributed-systems/consistency-quorums",
      "challenge:fenced-leader-failover",
      "challenge:quorum-fresh-reads",
    ],
  },
  {
    id: "week-4",
    title: "Module 4: Production Case Studies & Mock Interview",
    description:
      "Analyze Stripe Ledger, Ticketmaster Virtual Waiting Room, and Uber Geo-Dispatch.",
    items: [
      "case-study:stripe-ledger",
      "case-study:ticketmaster-waiting-room",
      "case-study:uber-dispatch",
    ],
  },
];

type StudentReceiptItem = {
  key: string;
  title: string;
  kind: string;
  completed: boolean;
  mastery: number | null;
  stars: number | null;
};

type StudentReceipt = {
  schema: "sds-assignment-receipt-v1";
  assignmentTitle: string;
  studentName: string;
  studentId: string;
  exportedAt: string;
  items: StudentReceiptItem[];
  summary: {
    totalItems: number;
    completedItems: number;
    meanMastery: number;
    totalStars: number;
  };
  fingerprint: string;
};

function computeReceiptFingerprint(
  assignmentTitle: string,
  studentId: string,
  items: StudentReceiptItem[],
): string {
  const payload = `${assignmentTitle}|${studentId}|${items
    .map(
      (i) =>
        `${i.key}:${i.completed ? 1 : 0}:${i.mastery ?? -1}:${i.stars ?? 0}`,
    )
    .join(",")}`;
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h = Math.imul(h ^ payload.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function subscribeProjector(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-projector"],
  });
  return () => mo.disconnect();
}

export function TeachStudio({ catalog }: { catalog: AssignableItem[] }) {
  const searchParams = useSearchParams();
  const progress = useProgress();

  const urlTitle = searchParams.get("title");
  const urlItemsParam = searchParams.get("items");

  const [assignmentTitle, setAssignmentTitle] = useState<string>(
    () => urlTitle || SYLLABUS_PRESETS[0].title,
  );
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => {
    if (urlItemsParam) {
      const parsed = urlItemsParam.split(",").filter(Boolean);
      if (parsed.length > 0) return parsed;
    }
    return SYLLABUS_PRESETS[0].items;
  });
  const [filterKind, setFilterKind] = useState<
    "all" | "lesson" | "challenge" | "case-study"
  >("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);

  // Student receipt export state
  const [studentName, setStudentName] = useState("");
  const [studentId, setStudentId] = useState("");

  // Instructor receipt verifier state
  const [verifiedReceipts, setVerifiedReceipts] = useState<
    Array<{ receipt: StudentReceipt; valid: boolean; fileName: string }>
  >([]);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const projectorOn = useSyncExternalStore(
    subscribeProjector,
    () => document.documentElement.getAttribute("data-projector") === "true",
    () => false,
  );

  function toggleProjector() {
    const next = !projectorOn;
    try {
      localStorage.setItem("projector", String(next));
    } catch {
      /* ignore */
    }
    if (next) document.documentElement.setAttribute("data-projector", "true");
    else document.documentElement.removeAttribute("data-projector");
  }

  function applyPreset(preset: SyllabusPreset) {
    setAssignmentTitle(preset.title);
    setSelectedKeys(preset.items);
    setCopiedLink(false);
  }

  function toggleKey(key: string) {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
    setCopiedLink(false);
  }

  const catalogByKey = new Map(catalog.map((item) => [item.key, item]));
  const assignedItems = selectedKeys
    .map((k) => catalogByKey.get(k))
    .filter((x): x is AssignableItem => x !== undefined);

  const assignmentRelativeUrl = `/teach?title=${encodeURIComponent(assignmentTitle)}&items=${encodeURIComponent(
    selectedKeys.join(","),
  )}`;

  async function copyAssignmentLink() {
    const fullUrl = `${window.location.origin}${assignmentRelativeUrl}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopiedLink(true);
    } catch {
      /* fallback */
    }
  }

  function getItemStatus(item: AssignableItem): {
    completed: boolean;
    mastery: number | null;
    stars: number | null;
    badge: string;
    tone: string;
  } {
    if (!progress) {
      return {
        completed: false,
        mastery: null,
        stars: null,
        badge: "Loading…",
        tone: "text-muted",
      };
    }
    const rec = progress.get(item.key);
    if (item.kind === "challenge") {
      const stars = rec?.stars ?? 0;
      return {
        completed: stars > 0,
        mastery: null,
        stars,
        badge: stars > 0 ? `${"★".repeat(stars)} Passed` : "○ Not passed",
        tone: stars > 0 ? "text-success" : "text-muted",
      };
    }
    const completed = rec?.completedAt !== undefined;
    const mastery = rec?.mastery ?? null;
    const mastered = (mastery ?? 0) >= 0.8;
    return {
      completed,
      mastery,
      stars: null,
      badge: mastered ? "★ Mastered" : completed ? "✓ Completed" : "○ To do",
      tone: mastered
        ? "text-success"
        : completed
          ? "text-accent-2"
          : "text-muted",
    };
  }

  function downloadStudentReceipt() {
    const items: StudentReceiptItem[] = assignedItems.map((item) => {
      const st = getItemStatus(item);
      return {
        key: item.key,
        title: item.title,
        kind: item.kind,
        completed: st.completed,
        mastery: st.mastery,
        stars: st.stars,
      };
    });
    const completedItems = items.filter((i) => i.completed).length;
    const masteries = items
      .map((i) => i.mastery)
      .filter((m): m is number => m !== null);
    const meanMastery =
      masteries.length > 0
        ? masteries.reduce((a, b) => a + b, 0) / masteries.length
        : 0;
    const totalStars = items.reduce((sum, i) => sum + (i.stars ?? 0), 0);
    const cleanName = studentName.trim() || "Anonymous Student";
    const cleanId = studentId.trim() || "unassigned";
    const receipt: StudentReceipt = {
      schema: "sds-assignment-receipt-v1",
      assignmentTitle,
      studentName: cleanName,
      studentId: cleanId,
      exportedAt: new Date().toISOString(),
      items,
      summary: {
        totalItems: items.length,
        completedItems,
        meanMastery,
        totalStars,
      },
      fingerprint: computeReceiptFingerprint(assignmentTitle, cleanId, items),
    };
    const blob = new Blob([JSON.stringify(receipt, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const slug = cleanId.replace(/[^a-zA-Z0-9_-]/g, "-") || "student";
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `sds-receipt-${slug}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleReceiptFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setVerifyError(null);
    const loaded: Array<{
      receipt: StudentReceipt;
      valid: boolean;
      fileName: string;
    }> = [];
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as StudentReceipt;
        if (
          parsed.schema !== "sds-assignment-receipt-v1" ||
          !Array.isArray(parsed.items)
        ) {
          setVerifyError(
            `"${file.name}" is not a valid System Design Simulator assignment receipt.`,
          );
          continue;
        }
        const expected = computeReceiptFingerprint(
          parsed.assignmentTitle,
          parsed.studentId,
          parsed.items,
        );
        loaded.push({
          receipt: parsed,
          valid: parsed.fingerprint === expected,
          fileName: file.name,
        });
      } catch {
        setVerifyError(`Could not parse "${file.name}" as JSON.`);
      }
    }
    if (loaded.length > 0) {
      setVerifiedReceipts((prev) => [...prev, ...loaded]);
    }
  }

  function exportGradebookCsv() {
    if (verifiedReceipts.length === 0) return;
    const header =
      "Student Name,Student ID,Assignment,Completed,Total,Mean Mastery %,Challenge Stars,Verified,Exported At\n";
    const rows = verifiedReceipts
      .map(({ receipt, valid }) => {
        const cols = [
          `"${receipt.studentName.replaceAll('"', '""')}"`,
          `"${receipt.studentId.replaceAll('"', '""')}"`,
          `"${receipt.assignmentTitle.replaceAll('"', '""')}"`,
          receipt.summary.completedItems,
          receipt.summary.totalItems,
          Math.round(receipt.summary.meanMastery * 100),
          receipt.summary.totalStars,
          valid ? "PASS" : "MISMATCH",
          receipt.exportedAt,
        ];
        return cols.join(",");
      })
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `sds-gradebook-${new Date().toISOString().slice(0, 10)}.csv`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  const filteredCatalog = catalog.filter((item) => {
    if (filterKind !== "all" && item.kind !== filterKind) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q)
    );
  });

  const completedAssignedCount = assignedItems.filter(
    (item) => getItemStatus(item).completed,
  ).length;

  return (
    <div className="mt-10 grid gap-14">
      {/* 1. Lecture Hall Projector Mode bar */}
      <section
        aria-labelledby="projector-heading"
        className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-rule bg-surface p-5"
      >
        <div className="max-w-2xl">
          <div className="flex items-center gap-2.5">
            <h2 id="projector-heading" className="font-display text-xl text-fg">
              Projector mode
            </h2>
            <span className="rounded border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted">
              {projectorOn ? "ACTIVE (112.5%)" : "STANDARD (100%)"}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-2">
            <span aria-hidden className="mr-1.5">▭</span>Bigger type for the back row.
          </p>
        </div>
        <button
          type="button"
          aria-pressed={projectorOn}
          onClick={toggleProjector}
          className="btn"
        >
          {projectorOn ? "Disable Projector Mode" : "Enable Projector Mode"}
        </button>
      </section>

      {/* 2. Active Assignment / Student Checklist */}
      <section
        aria-labelledby="assignment-checklist"
        className="rounded-lg border border-rule bg-surface p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              {urlItemsParam
                ? "Shared Course Assignment"
                : "Active Assignment Preview"}
            </p>
            <h2
              id="assignment-checklist"
              className="mt-1 font-display text-2xl text-fg"
            >
              {assignmentTitle}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <Ring value={assignedItems.length ? completedAssignedCount / assignedItems.length : 0} size={56} stroke={6}>
              <RingText size={56} fontSize={13}>
                {completedAssignedCount}/{assignedItems.length}
              </RingText>
            </Ring>
            <p className="text-xs text-muted">done on this device</p>
          </div>
        </div>

        {assignedItems.length === 0 ? (
          <p className="flex items-center gap-3 py-6 text-sm text-muted">
            <svg aria-hidden viewBox="0 0 48 48" className="size-10 shrink-0 text-rule" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3">
              <path d="M10 6h28v36H10zM16 16h16M16 24h16M16 32h8" />
            </svg>
            Nothing assigned. Pick a preset below.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {assignedItems.map((item, idx) => {
              const st = getItemStatus(item);
              return (
                <li
                  key={item.key}
                  className="flex flex-wrap items-center justify-between gap-3 py-3.5"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted num">
                        {idx + 1}.
                      </span>
                      <Link
                        href={item.href}
                        className="font-medium text-fg underline-offset-4 hover:underline"
                      >
                        {item.title}
                      </Link>
                    </div>
                    <p className="mt-0.5 pl-5 text-xs text-muted">
                      {item.subtitle}
                      {st.mastery !== null && (
                        <>
                          {" "}
                          · Mastery check:{" "}
                          <span className="num">
                            {formatPercent(st.mastery, 0)}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {item.interviewHref && (
                      <Link href={item.interviewHref} className="btn text-xs">
                        Timed interview
                      </Link>
                    )}
                    <Link href={item.href} className="btn text-xs">
                      Open
                    </Link>
                    <span
                      className={`min-w-28 text-right text-sm font-medium ${st.tone}`}
                    >
                      {st.badge}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-5 flex flex-wrap items-end justify-between gap-4 border-t border-border pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs text-muted">
              <span>Student name</span>
              <input
                type="text"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                placeholder="e.g. Ada Lovelace"
                className="field text-sm"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted">
              <span>Student ID or email</span>
              <input
                type="text"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                placeholder="e.g. alovelace@university.edu"
                className="field text-sm"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={downloadStudentReceipt}
            disabled={assignedItems.length === 0}
            className="btn btn-primary"
          >
            Download receipt
          </button>
        </div>
      </section>

      {/* 3. Curated Live Classroom Demos */}
      <section aria-labelledby="live-demos">
        <div className="max-w-3xl">
          <h2 id="live-demos" className="font-display text-3xl text-fg">
            Six live demos
          </h2>
        </div>
        <div className="mt-6 grid gap-5 md:grid-cols-2">
          {CLASSROOM_DEMOS.map((demo) => (
            <article
              key={demo.id}
              className="flex flex-col justify-between rounded-lg border border-border bg-surface p-5"
            >
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span className="font-mono text-accent">{demo.concept}</span>
                  <span className="font-mono">{demo.duration}</span>
                </div>
                <h3 className="mt-1.5 font-display text-xl text-fg">
                  {demo.title}
                </h3>
                <ol className="mt-3 grid gap-2 text-sm text-ink-2">
                  {demo.steps.map((step, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="font-mono text-xs text-muted num mt-0.5">
                        {i + 1}.
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 rounded border border-border bg-surface-2 px-3 py-2 text-xs text-ink-2">
                  <strong className="text-fg"><span aria-hidden>? </span>Ask:</strong>{" "}
                  {demo.question}
                </p>
              </div>
              <div className="mt-4 flex justify-end border-t border-border pt-3">
                <Link href={demo.launchHref} className="btn text-xs">
                  {demo.launchLabel} →
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* 4. Zero-Backend Syllabus & Homework Link Builder */}
      <section
        aria-labelledby="syllabus-builder"
        className="rounded-lg border border-border bg-surface p-6"
      >
        <div className="max-w-3xl">
          <h2 id="syllabus-builder" className="font-display text-3xl text-fg">
            Assignment builder
          </h2>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {SYLLABUS_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              onClick={() => applyPreset(preset)}
              className="flex flex-col items-start rounded-md border border-border bg-surface-2 p-3.5 text-left transition-colors hover:border-fg"
            >
              <span className="font-medium text-fg text-sm">
                {preset.title}
              </span>
              <span className="num mt-1 text-xs text-muted">
                {preset.items.length} items
              </span>
            </button>
          ))}
        </div>

        <div className="mt-6 grid gap-4 border-t border-border pt-5 sm:grid-cols-[1fr_auto]">
          <label className="grid gap-1 text-xs text-muted">
            <span>Title</span>
            <input
              type="text"
              value={assignmentTitle}
              onChange={(e) => {
                setAssignmentTitle(e.target.value);
                setCopiedLink(false);
              }}
              className="field text-sm"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => void copyAssignmentLink()}
              className="btn btn-primary"
            >
              {copiedLink
                ? "✓ Link copied"
                : "Copy assignment link"}
            </button>
          </div>
        </div>

        <div className="mt-3 rounded border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-muted break-all">
          {assignmentRelativeUrl}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label="Filter catalog by type"
          >
            {(["all", "lesson", "challenge", "case-study"] as const).map(
              (k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={filterKind === k}
                  onClick={() => setFilterKind(k)}
                  className="btn text-xs"
                >
                  {k === "all"
                    ? `All (${catalog.length})`
                    : k === "lesson"
                      ? "Lessons"
                      : k === "challenge"
                        ? "Challenges"
                        : "Case studies"}
                </button>
              ),
            )}
          </div>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by title or topic…"
            aria-label="Filter catalog by title or topic"
            className="field text-sm"
          />
        </div>

        <div className="mt-4 max-h-80 overflow-y-auto rounded border border-border divide-y divide-border">
          {filteredCatalog.map((item) => {
            const checked = selectedKeys.includes(item.key);
            return (
              <label
                key={item.key}
                className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm hover:bg-surface-2"
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleKey(item.key)}
                  />
                  <div>
                    <span className="font-medium text-fg">{item.title}</span>
                    <span className="ml-2 text-xs text-muted">
                      {item.subtitle}
                    </span>
                  </div>
                </div>
                <span className="font-mono text-xs text-muted uppercase">
                  {item.kind}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* 5. Instructor Receipt Verifier & Gradebook Export */}
      <section
        aria-labelledby="receipt-verifier"
        className="rounded-lg border border-border bg-surface p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 id="receipt-verifier" className="font-display text-3xl text-fg">
              Gradebook
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn cursor-pointer text-xs">
              <span>Upload receipts</span>
              <input
                type="file"
                accept="application/json,.json"
                multiple
                onChange={(e) => void handleReceiptFiles(e.target.files)}
                className="sr-only"
              />
            </label>
            {verifiedReceipts.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={exportGradebookCsv}
                  className="btn text-xs"
                >
                  Export CSV gradebook
                </button>
                <button
                  type="button"
                  onClick={() => setVerifiedReceipts([])}
                  className="btn text-xs"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>

        {verifyError && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {verifyError}
          </p>
        )}

        {verifiedReceipts.length === 0 ? (
          <p className="mt-6 flex items-center justify-center gap-3 rounded border border-dashed border-border py-8 text-sm text-muted">
            <svg aria-hidden viewBox="0 0 48 48" className="size-10 shrink-0 text-rule" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M24 34V12M14 22l10-10 10 10M8 40h32" />
            </svg>
            No receipts loaded.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-rule text-xs uppercase text-muted font-mono">
                  <th className="py-2 pr-4">Student</th>
                  <th className="py-2 pr-4">ID / Email</th>
                  <th className="py-2 pr-4">Assignment</th>
                  <th className="py-2 pr-4">Completed</th>
                  <th className="py-2 pr-4">Mean Mastery</th>
                  <th className="py-2 pr-4">Challenge Stars</th>
                  <th className="py-2">Integrity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {verifiedReceipts.map(({ receipt, valid, fileName }, i) => (
                  <tr key={`${fileName}-${i}`}>
                    <td className="py-2.5 pr-4 font-medium text-fg">
                      {receipt.studentName}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-muted">
                      {receipt.studentId}
                    </td>
                    <td className="py-2.5 pr-4 text-ink-2">
                      {receipt.assignmentTitle}
                    </td>
                    <td className="py-2.5 pr-4 font-mono num">
                      {receipt.summary.completedItems} /{" "}
                      {receipt.summary.totalItems}
                    </td>
                    <td className="py-2.5 pr-4 font-mono num">
                      {formatPercent(receipt.summary.meanMastery, 0)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono num">
                      ★ {receipt.summary.totalStars}
                    </td>
                    <td className="py-2.5">
                      <span
                        className={`font-mono text-xs font-medium ${
                          valid ? "text-success" : "text-danger"
                        }`}
                      >
                        {valid
                          ? `✓ Verified (${receipt.fingerprint})`
                          : "✗ Fingerprint mismatch"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
