"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { useProgress } from "@/components/lesson/progress";
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
      "Run the starter design first and point students to Database utilisation (100%) and p99 latency spiking above 250 ms.",
      "Drag a Cache node onto both Service → Database edges (auto-wires cache-aside) and re-run with coalesce OFF vs ON through the 7s cache kill.",
      "Inspect the time-series chart at t = 7s: show how singleflight coalescing prevents the cold-cache stampede from saturating the 5 DB workers.",
    ],
    question: "Ask the class: Why does adding a cache without request coalescing still fail when a hot key expires or a cache node restarts?",
  },
  {
    id: "oversell",
    title: "2. Flash-Sale Concurrency Race (Oversell)",
    concept: "Track 2 · Transactions & Atomic Conditional Writes",
    duration: "5 min live demo",
    launchHref: "/challenges/flash-sale-no-oversell",
    launchLabel: "Open Flash-Sale Challenge",
    steps: [
      "Run the starter booking service under 1,000 RPS for 100 concert seats and open the Invariants panel to reveal the oversell violation.",
      "Step through the Request Trace debugger to show two concurrent buyers reading remaining = 1 before either writes remaining = 0.",
      "Replace the separate get + update steps with a single atomic decrementIfPositive step and show clean 409 Conflict responses once 100 seats sell.",
    ],
    question: "Ask the class: Would increasing database worker concurrency make the read-then-write race better or worse?",
  },
  {
    id: "lost-ack",
    title: "3. Lost Payment Ack & Idempotency Keys",
    concept: "Track 2 · Retries, Network Partitions & Deduplication",
    duration: "6 min live demo",
    launchHref: "/challenges/idempotent-payment-retry",
    launchLabel: "Open Idempotent Payment Challenge",
    steps: [
      "Show the directional network partition (payments → gateway) at 10.6 ms: the ledger increment commits, but the 200 OK response packet drops.",
      "Point out the duplicateEffect violation when the gateway's timeout retry increments the customer's ledger a second time.",
      "Wire the Payment Service PUT handler to check the atomic, durable Dedup Store first and branch on dedupHit → 200 OK.",
    ],
    question: "Ask the class: What happens if the idempotency store is non-atomic or loses state on restart before the client retry arrives?",
  },
  {
    id: "failover",
    title: "4. Unfenced Primary Failover & Split-Brain",
    concept: "Track 2 · Replication Lag, Promotion & Fencing Tokens",
    duration: "7 min live demo",
    launchHref: "/challenges/fenced-leader-failover",
    launchLabel: "Open Fenced Failover Challenge",
    steps: [
      "Run the starter async-replicated database through the primary crash and highlight both ackedWriteLost and splitBrainWrite violations.",
      "Explain why async writes acknowledged before the crash vanish when a lagging follower is promoted, and why the recovering old leader accepts stale-term writes.",
      "Switch replication to sync/semiSync and enable failover fencing (fencing: true) so stale-term writes are rejected and committed writes survive promotion.",
    ],
    question: "Ask the class: In a 3-node cluster where 1 node crashes, what is the availability trade-off between full sync (all 3) and semi-sync (quorum of 2)?",
  },
  {
    id: "quorum",
    title: "5. Sloppy vs. Intersecting Dynamo Quorums",
    concept: "Track 2 · Leaderless Replication & Read/Write Quorums",
    duration: "5 min live demo",
    launchHref: "/challenges/quorum-fresh-reads",
    launchLabel: "Open Quorum Fresh Reads Challenge",
    steps: [
      "Run the 3-replica KV ring with R = 1, W = 1 under 50% reads / 50% writes and inspect the staleRead violation in the Results tab.",
      "Use the Pigeonhole Principle on the board: with N = 3, R = 1, W = 1, R + W = 2 ≤ 3, so a reader can contact a replica outside the write set.",
      "Raise readQuorum to 2 and writeQuorum to 2 (R + W = 4 > 3) and verify that every read intersects at least one replica with the latest version.",
    ],
    question: "Ask the class: If latency-sensitive reads require R = 1 on N = 3, what must W be to preserve strict quorum intersection?",
  },
  {
    id: "breaking-point",
    title: "6. Planet-Scale Breaking-Point Load Sweep",
    concept: "Track 3 · Capacity Planning & Saturation Cliffs",
    duration: "6 min live demo",
    launchHref: "/sandbox?ref=global-cdn",
    launchLabel: "Open Global CDN in Sandbox",
    steps: [
      "Open the Global CDN & Edge Compute architecture in the Sandbox and click 'Find breaking point' in the top bar.",
      "Watch the binary-search load multiplier sweep offered RPS until goodput or p99 crosses the SLO cliff.",
      "Identify the bottleneck component in the breakdown table, double its concurrency or enable Origin Shield, and re-run the sweep to measure the new ceiling.",
    ],
    question: "Ask the class: Why does p99 latency spike sharply around 80–85% utilisation even before throughput completely flattens?",
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
    description: "Little's Law, tail latency math, cache-aside mechanics, and the cold-cache recovery challenge.",
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
    description: "Atomic conditional updates, idempotency keys under lost acks, and partitioned queue visibility timeouts.",
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
    description: "Leader–follower failover, fencing tokens, and Dynamo quorum intersection.",
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
    description: "Analyze Stripe Ledger, Ticketmaster Virtual Waiting Room, and Uber Geo-Dispatch.",
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
    .map((i) => `${i.key}:${i.completed ? 1 : 0}:${i.mastery ?? -1}:${i.stars ?? 0}`)
    .join(",")}`;
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h = Math.imul(h ^ payload.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function subscribeProjector(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-projector"] });
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
  const [filterKind, setFilterKind] = useState<"all" | "lesson" | "challenge" | "case-study">("all");
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
      return { completed: false, mastery: null, stars: null, badge: "Loading…", tone: "text-muted" };
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
      tone: mastered ? "text-success" : completed ? "text-accent-2" : "text-muted",
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
    const masteries = items.map((i) => i.mastery).filter((m): m is number => m !== null);
    const meanMastery =
      masteries.length > 0 ? masteries.reduce((a, b) => a + b, 0) / masteries.length : 0;
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
    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
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
    const loaded: Array<{ receipt: StudentReceipt; valid: boolean; fileName: string }> = [];
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as StudentReceipt;
        if (parsed.schema !== "sds-assignment-receipt-v1" || !Array.isArray(parsed.items)) {
          setVerifyError(`"${file.name}" is not a valid System Design Simulator assignment receipt.`);
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
    const header = "Student Name,Student ID,Assignment,Completed,Total,Mean Mastery %,Challenge Stars,Verified,Exported At\n";
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
    return item.title.toLowerCase().includes(q) || item.subtitle.toLowerCase().includes(q);
  });

  const completedAssignedCount = assignedItems.filter((item) => getItemStatus(item).completed).length;

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
              Lecture Hall &amp; Projector Display Mode
            </h2>
            <span className="rounded border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted">
              {projectorOn ? "ACTIVE (112.5%)" : "STANDARD (100%)"}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-2">
            Scales typography and diagram rules across the Sandbox, Challenges, and Lessons so back-row students can read queue depths, p99 numbers, and invariant traces clearly.
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
      <section aria-labelledby="assignment-checklist" className="rounded-lg border border-rule bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              {urlItemsParam ? "Shared Course Assignment" : "Active Assignment Preview"}
            </p>
            <h2 id="assignment-checklist" className="mt-1 font-display text-2xl text-fg">
              {assignmentTitle}
            </h2>
            <p className="mt-1 text-sm text-muted">
              Complete each assigned module below. Progress is tracked automatically in your browser; export a signed JSON receipt when finished to submit to your instructor.
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-2xl text-fg num">
              {completedAssignedCount} / {assignedItems.length}
            </p>
            <p className="text-xs text-muted">items completed on this device</p>
          </div>
        </div>

        {assignedItems.length === 0 ? (
          <p className="py-6 text-sm text-muted">No items selected yet. Choose a module preset or check items in the syllabus builder below.</p>
        ) : (
          <ul className="divide-y divide-border">
            {assignedItems.map((item, idx) => {
              const st = getItemStatus(item);
              return (
                <li key={item.key} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted num">{idx + 1}.</span>
                      <Link href={item.href} className="font-medium text-fg underline-offset-4 hover:underline">
                        {item.title}
                      </Link>
                    </div>
                    <p className="mt-0.5 pl-5 text-xs text-muted">
                      {item.subtitle}
                      {st.mastery !== null && (
                        <>
                          {" "}· Mastery check: <span className="num">{formatPercent(st.mastery, 0)}</span>
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
                    <span className={`min-w-28 text-right text-sm font-medium ${st.tone}`}>
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
              <span>Student Name (for receipt)</span>
              <input
                type="text"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                placeholder="e.g. Ada Lovelace"
                className="field text-sm"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted">
              <span>Student ID / Email</span>
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
            Download completion receipt (.json)
          </button>
        </div>
      </section>

      {/* 3. Curated Live Classroom Demos */}
      <section aria-labelledby="live-demos">
        <div className="max-w-3xl">
          <h2 id="live-demos" className="font-display text-3xl text-fg">
            6 Live Classroom Demonstrations
          </h2>
          <p className="mt-2 text-sm text-ink-2">
            Each demo pairs a concrete distributed systems failure mode with step-by-step lecture choreography and a Socratic question to pose to your students before revealing the fix.
          </p>
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
                <h3 className="mt-1.5 font-display text-xl text-fg">{demo.title}</h3>
                <ol className="mt-3 grid gap-2 text-sm text-ink-2">
                  {demo.steps.map((step, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="font-mono text-xs text-muted num mt-0.5">{i + 1}.</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 rounded border border-border bg-surface-2 px-3 py-2 text-xs text-ink-2">
                  <strong className="text-fg">Discussion prompt:</strong> {demo.question}
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
      <section aria-labelledby="syllabus-builder" className="rounded-lg border border-border bg-surface p-6">
        <div className="max-w-3xl">
          <h2 id="syllabus-builder" className="font-display text-3xl text-fg">
            Syllabus &amp; Homework Link Builder
          </h2>
          <p className="mt-2 text-sm text-ink-2">
            Start from a ready-made weekly module or pick any combination of lessons, graded challenges, and case studies. The generated URL encodes the assignment with zero backend setup.
          </p>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {SYLLABUS_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              className="flex flex-col items-start rounded-md border border-border bg-surface-2 p-3.5 text-left transition-colors hover:border-fg"
            >
              <span className="font-medium text-fg text-sm">{preset.title}</span>
              <span className="mt-1 text-xs text-muted">{preset.description}</span>
            </button>
          ))}
        </div>

        <div className="mt-6 grid gap-4 border-t border-border pt-5 sm:grid-cols-[1fr_auto]">
          <label className="grid gap-1 text-xs text-muted">
            <span>Assignment Title</span>
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
            <button type="button" onClick={() => void copyAssignmentLink()} className="btn btn-primary">
              {copiedLink ? "✓ Link copied to clipboard" : "Copy shareable assignment URL"}
            </button>
          </div>
        </div>

        <div className="mt-3 rounded border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-muted break-all">
          {assignmentRelativeUrl}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter catalog by type">
            {(["all", "lesson", "challenge", "case-study"] as const).map((k) => (
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
            ))}
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
                    <span className="ml-2 text-xs text-muted">{item.subtitle}</span>
                  </div>
                </div>
                <span className="font-mono text-xs text-muted uppercase">{item.kind}</span>
              </label>
            );
          })}
        </div>
      </section>

      {/* 5. Instructor Receipt Verifier & Gradebook Export */}
      <section aria-labelledby="receipt-verifier" className="rounded-lg border border-border bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 id="receipt-verifier" className="font-display text-3xl text-fg">
              Instructor Receipt Verifier &amp; Gradebook
            </h2>
            <p className="mt-2 text-sm text-ink-2">
              Upload one or more student <code className="font-mono text-xs">.json</code> completion receipts to verify their FNV-1a integrity fingerprint, inspect per-student mastery and challenge stars, and export a CSV gradebook.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn cursor-pointer text-xs">
              <span>Upload student receipts (.json)</span>
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
                <button type="button" onClick={exportGradebookCsv} className="btn text-xs">
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
          <p className="mt-6 rounded border border-dashed border-border py-8 text-center text-sm text-muted">
            No student receipts loaded yet. Select one or more <code>sds-receipt-*.json</code> files above to grade.
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
                    <td className="py-2.5 pr-4 font-medium text-fg">{receipt.studentName}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-muted">{receipt.studentId}</td>
                    <td className="py-2.5 pr-4 text-ink-2">{receipt.assignmentTitle}</td>
                    <td className="py-2.5 pr-4 font-mono num">
                      {receipt.summary.completedItems} / {receipt.summary.totalItems}
                    </td>
                    <td className="py-2.5 pr-4 font-mono num">
                      {formatPercent(receipt.summary.meanMastery, 0)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono num">★ {receipt.summary.totalStars}</td>
                    <td className="py-2.5">
                      <span
                        className={`font-mono text-xs font-medium ${
                          valid ? "text-success" : "text-danger"
                        }`}
                      >
                        {valid ? `✓ Verified (${receipt.fingerprint})` : "✗ Fingerprint mismatch"}
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
