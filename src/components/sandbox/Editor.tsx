"use client";
// The sandbox editor: client-only (loaded with ssr:false by EditorLoader).
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Challenge } from "@/content/challenges";
import type { ReferenceDesign } from "@/content/reference-designs";
import { designHash, validateDesign } from "@/engine";
import type { Design, NodeId, Scenario, ValidationIssue } from "@/engine/types";
import { autosave, decodeShareLink, encodeShareLink, importDesign, openStore, type SaveStatus } from "@/lib/persistence";
import * as runs from "@/lib/run-manager";
import { NODE_H, NODE_W, type Look } from "./board-elements";
import { ChallengePanel } from "./ChallengePanel";
import { CommandPalette } from "./CommandPalette";
import { EditorSkeleton } from "./EditorSkeleton";
import { addNode, affectedBy, describeStep, diffPaths, elementName, KIND_LABEL, liveDiff, removeElements, type StepRef } from "./design-ops";
import { createDesignStore, DesignCtx, dropLegacyAnnotations, legacyAnnotations, useDesign, useDesignApi } from "./design-store";
import { exportSds, exportSvgOrPng } from "./export";
import { Inspector } from "./Inspector";
import { ListEditor } from "./ListEditor";
import { ResultsPanel } from "./ResultsPanel";
import { RunBanner, RunControls } from "./RunControls";
import { ScenarioEditor } from "./ScenarioEditor";
import { chaosProblems, loadScenario, saveScenario } from "./scenario-ops";
import { Tour, tourDone } from "./Tour";
import { TracePanel } from "./TracePanel";
import { fmtMs } from "./units";
import { ValidationPanel } from "./ValidationPanel";
import { Whiteboard, type DeleteRequest } from "./Whiteboard";

// C2's Scale panel runs Scale mode in its own worker; loaded only when the tab opens.
const ScalePanel = dynamic(() => import("@/components/scale").then((m) => m.ScalePanel), {
  ssr: false,
  loading: () => <p className="text-sm text-(--text-muted)">Loading Scale mode…</p>,
});

export type EditorProps = {
  designId: string;
  scenario: Scenario;
  /** Used when nothing is stored under designId yet (challenge start). */
  fallback?: Design;
  challenge?: Challenge;
  initialTab?: "scale" | "inspect";
  reference?: ReferenceDesign;
};

/** Loads the stored draft (or a #d= share link), then mounts the editor. */
export default function Editor(props: EditorProps) {
  const [state, setState] = useState<{ design: Design; unsaved?: boolean; migrated?: boolean } | { missing: string; notFound?: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const store = await openStore();
      if (location.hash.startsWith("#d=")) {
        const shared = decodeShareLink(location.hash);
        // A share link opens as an unsaved copy; it is persisted on the first edit or Save (§11).
        return alive && setState("error" in shared ? { missing: `This share link can't be opened: ${shared.error}` } : { design: shared, unsaved: true });
      }
      const rec = await store.designs.get(props.designId);
      if (!alive) return;
      const design = rec ? rec.design : props.fallback ? { ...structuredClone(props.fallback), id: props.designId } : null;
      if (!design) return setState({ missing: "This draft isn't in this browser. Drafts are stored locally — start a new one or open a share link.", notFound: true });
      // P1 kept annotations in localStorage; move them into the design once.
      const legacy = design.annotations ? null : legacyAnnotations(props.designId);
      setState(legacy ? { design: { ...design, annotations: legacy }, migrated: true } : { design });
    })().catch((e) => alive && setState({ missing: `Couldn't open local storage: ${e instanceof Error ? e.message : e}` }));
    return () => { alive = false; };
  }, [props.designId, props.fallback]);

  if (!state) return <EditorSkeleton />;
  if ("missing" in state) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm">
          {state.notFound && <><p className="font-mono text-sm text-accent">404</p><h1 className="my-3 font-display text-3xl">A page missing from the notebook.</h1></>}
          <p className="mb-4 text-sm text-(--text-muted)">{state.missing}</p>
          <Link href="/sandbox" className="inline-flex h-9 items-center rounded-(--radius-sm) bg-(--accent) px-4 text-sm font-semibold text-(--accent-ink)">Start a new design</Link>
        </div>
      </div>
    );
  }
  return <Workspace {...props} designId={state.design.id} initial={state.design} unsaved={state.unsaved} migrated={state.migrated} />;
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia("(prefers-reduced-motion: reduce)");
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

type WorkspaceProps = EditorProps & { initial: Design; unsaved?: boolean; migrated?: boolean };

function Workspace(props: WorkspaceProps) {
  const [store] = useState(() => createDesignStore(props.initial));
  return (
    <DesignCtx value={store}>
      <ReactFlowProvider>
        <WorkspaceInner {...props} />
      </ReactFlowProvider>
    </DesignCtx>
  );
}

function persist(saver: ReturnType<typeof autosave>, d: Design) {
  saver.schedule(d);
  // A shared copy (/sandbox/shared#d=…) becomes a real local draft with its own URL.
  if (location.pathname.startsWith("/sandbox/") && location.pathname !== `/sandbox/${d.id}`) history.replaceState(null, "", `/sandbox/${d.id}`);
}

type Tab = "inspect" | "scenario" | "checks" | "results" | "trace" | "scale" | "challenge";

function WorkspaceInner({ designId, scenario: baseScenario, challenge, initialTab, reference, unsaved: openedUnsaved, migrated }: WorkspaceProps) {
  const design = useDesign((s) => s.design);
  const canUndo = useDesign((s) => s.past.length > 0);
  const canRedo = useDesign((s) => s.future.length > 0);
  const api = useDesignApi();
  const rf = useReactFlow();
  const router = useRouter();
  const run = runs.useRun(designId);
  const reducedMotion = usePrefersReducedMotion();
  const [view, setView] = useState<"board" | "list">(() => (matchMedia("(max-width: 767px)").matches ? "list" : "board"));
  const [look, setLook] = useState<Look>("sketch");
  const [tab, setTabState] = useState<Tab>(challenge ? "challenge" : initialTab ?? "inspect");
  const [toast, setToast] = useState<string | null>(null);
  const [save, setSave] = useState<{ status: SaveStatus; persistent: boolean }>({ status: "saved", persistent: true });
  const saverRef = useRef<ReturnType<typeof autosave> | null>(null);
  const [unsaved, setUnsaved] = useState(!!openedUnsaved);
  const [pendingDelete, setPendingDelete] = useState<{ req: DeleteRequest; refs: StepRef[] } | null>(null);
  const [palette, setPalette] = useState(false);
  const [tourOpen, setTourOpen] = useState(() => !tourDone());
  const rootRef = useRef<HTMLDivElement>(null);
  const [heat, setHeat] = useState<Record<NodeId, number> | null>(null);
  const [overlay, setOverlay] = useState(false);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const exportRef = useRef<HTMLDetailsElement>(null);

  // The sandbox scenario is editable and saved beside the draft; challenges keep theirs fixed (graded runs freeze it).
  const [scenario, setScenarioState] = useState<Scenario>(() => (challenge ? baseScenario : loadScenario(designId, baseScenario)));
  const live = run.status === "running" || run.status === "paused";

  function setTab(t: Tab) {
    if (t !== "scale") setHeat(null);
    setTabState(t);
  }

  function setScenario(next: Scenario) {
    if (runs.isLive(designId)) {
      // §5.7: arrival/mix edits apply at the next arrival; chaos edits only for events that start after the cursor.
      const edits = [
        ...diffPaths(scenario.workload, next.workload).map((e) => ({ nodeId: "@workload", ...e })),
        ...next.chaos.filter((c) => JSON.stringify(c) !== JSON.stringify(scenario.chaos.find((o) => o.id === c.id))).map((c) => ({ nodeId: "@chaos", path: c.id, value: c })),
        ...scenario.chaos.filter((o) => !next.chaos.some((c) => c.id === o.id)).map((o) => ({ nodeId: "@chaos", path: o.id, value: null })),
      ];
      runs.liveEdit(designId, edits, run.designHash ?? designHash(design));
    }
    setScenarioState(next);
    saveScenario(designId, next);
  }

  // Chaos may only target what exists; events with timeline problems are left out until fixed.
  const problems = chaosProblems(design, scenario.chaos);
  const runScenario: Scenario = { ...scenario, chaos: scenario.chaos.filter((c) => !problems[c.id]) };
  let issues: ValidationIssue[];
  try {
    issues = validateDesign(design, runScenario);
  } catch (e) {
    issues = [{ code: "VALIDATOR_ERROR", message: e instanceof Error ? e.message : String(e) }];
  }
  const hash = designHash(design);
  // Name the first problem in words; the Run controls offer a jump to it.
  const blocked = issues.length ? `${issues[0].message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ""}` : null;

  const notify = (msg: string) => setToast(msg);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // After a run stops, any difference from the design it reflects makes its results stale (§5.7).
  useEffect(() => {
    if (!live && run.designHash && run.designHash !== hash) runs.markStale(designId);
  }, [hash, live, run.designHash, designId]);

  // During a run: parameter edits go live; structural edits stop the run. Undo works the same way.
  useEffect(() => api.subscribe((s, prev) => {
    if (s.design === prev.design || !runs.isLive(designId)) return;
    const edits = liveDiff(prev.design, s.design);
    if (edits === null) runs.markStale(designId);
    else runs.liveEdit(designId, edits, designHash(s.design));
  }), [api, designId]);

  // Activity hides this route: pause the run (the manager owns the worker, we only subscribe).
  useEffect(() => () => runs.pause(designId), [designId]);

  // Autosave every design change.
  useEffect(() => {
    const saver = autosave(designId, { onStatusChange: (status) => setSave((s) => ({ ...s, status })) });
    saverRef.current = saver;
    openStore().then((st) => setSave((s) => ({ ...s, persistent: st.persistent }))).catch(() => {});
    const unsub = api.subscribe((s, prev) => {
      if (s.design !== prev.design) {
        persist(saver, s.design);
        setUnsaved(false);
      }
    });
    if (migrated) {
      // Save the migrated annotations, and drop the old copy only once the stored record really has them.
      saver.schedule(api.getState().design);
      void saver.flush()
        .then(() => openStore())
        .then((st) => st.designs.get(designId))
        .then((rec) => { if (rec?.design.annotations?.length) dropLegacyAnnotations(designId); })
        .catch(() => {});
    }
    return () => {
      unsub();
      void saver.flush().finally(() => saver.dispose());
    };
  }, [api, designId, migrated]);

  function openInspector() {
    setTab("inspect");
    requestAnimationFrame(() => panelRef.current?.focus());
  }

  function requestDelete(req: DeleteRequest) {
    const d = api.getState().design;
    const refs = affectedBy(d, req);
    if (refs.length === 0) {
      api.getState().commit((x) => removeElements(x, req));
      api.getState().select(null);
      return;
    }
    setPendingDelete({ req, refs });
    requestAnimationFrame(() => confirmRef.current?.showModal());
  }

  function startRun(input?: { scenario: Scenario; seed: number }) {
    runs.start(designId, { design, scenario: input?.scenario ?? runScenario, seed: input?.seed ?? 1 });
    setTab("results");
  }

  async function share() {
    const hashPart = encodeShareLink(design);
    if (!hashPart) return notify("Too large to share as a link — use Export instead.");
    const url = `${location.origin}/sandbox/shared${hashPart}`;
    try {
      await navigator.clipboard.writeText(url);
      notify("Share link copied. Opening it creates a copy in the recipient's browser.");
    } catch {
      prompt("Copy this share link:", url);
    }
  }

  const metricOverlay = (): Record<string, number> | undefined => {
    if (heat) return heat;
    if (live && run.snapshot) return run.snapshot.nodeUtil;
    return run.result ? Object.fromEntries(run.result.nodes.map((n) => [n.nodeId, n.utilisation])) : undefined;
  };

  async function doExport(kind: "sds" | "svg" | "png") {
    exportRef.current?.removeAttribute("open");
    try {
      if (kind === "sds") await exportSds(design);
      else {
        const host = document.querySelector(`[data-board="${designId}"]`) ?? document.body;
        const values = overlay ? metricOverlay() : undefined;
        if (overlay && !values) notify("No run results yet — exported without the metric overlay.");
        await exportSvgOrPng(design, kind, { look, overlay: values, host });
      }
    } catch (e) {
      notify(`Export failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function doImport(file: File) {
    try {
      const rec = await importDesign(file);
      notify(`Imported “${rec.design.name}” as a new draft.`);
      router.push(`/sandbox/${rec.id}`);
    } catch (e) {
      notify(`Import failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  function addFromPalette(kind: Parameters<typeof addNode>[1]) {
    const d = api.getState().design;
    const el = document.querySelector(`[data-board="${designId}"]`)?.getBoundingClientRect();
    const c = el && view === "board" ? rf.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }) : { x: 120 + d.nodes.length * 40, y: 120 };
    const r = addNode(d, kind, { x: Math.round((c.x - NODE_W / 2) / 16) * 16, y: Math.round((c.y - NODE_H / 2) / 16) * 16 });
    api.getState().commit(() => r.design);
    api.getState().select({ kind: "node", id: r.id });
    notify(`Added ${KIND_LABEL[kind].toLowerCase()}. Press Enter to edit it, or C to connect it.`);
  }

  function goTo(id: string) {
    const n = api.getState().design.nodes.find((x) => x.id === id);
    if (!n) return;
    api.getState().select({ kind: "node", id });
    if (view === "board") rf.setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { zoom: 1, duration: reducedMotion ? 0 : 350 });
    openInspector();
  }

  /** One click from the disabled Run button to whatever blocks it. */
  function fixFirst() {
    const first = issues[0];
    if (!first) return;
    if (first.nodeId) return goTo(first.nodeId);
    if (first.code === "NO_TRAFFIC_SOURCE") {
      const entry = document.querySelector<HTMLElement>(`[data-board="${designId}"] [data-kind="client"]`);
      if (entry) return entry.focus();
    }
    if (first.edgeId) api.getState().select({ kind: "edge", id: first.edgeId });
    setTab("checks");
    requestAnimationFrame(() => panelRef.current?.focus());
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "k") {
      e.preventDefault();
      setPalette(true);
      return;
    }
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    if (k === "z" && !e.shiftKey) api.getState().undo();
    else if ((k === "z" && e.shiftKey) || k === "y") api.getState().redo();
    else return;
    e.preventDefault();
  }

  const tabs: { id: Tab; label: string; badge?: string }[] = [
    ...(challenge ? [{ id: "challenge" as Tab, label: "Challenge" }] : []),
    { id: "inspect", label: "Inspect" },
    ...(challenge ? [] : [{ id: "scenario" as Tab, label: "Scenario", badge: Object.keys(problems).length ? String(Object.keys(problems).length) : undefined }]),
    { id: "checks", label: "Checks", badge: issues.length ? String(issues.length) : undefined },
    { id: "results", label: "Results" },
    { id: "trace", label: "Trace" },
    { id: "scale", label: "Scale" },
  ];
  const SAVE_TEXT: Record<SaveStatus, string> = { saved: save.persistent ? "Saved" : "Saved in memory only", saving: "Saving…", error: "Not saved" };
  const tbtn = "h-8 rounded-(--radius-sm) px-2.5 text-sm text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-35 disabled:hover:bg-transparent";
  const menuItem = "flex min-h-9 w-full items-center rounded-(--radius-sm) px-2.5 text-left text-sm hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)";

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col bg-(--bg) text-(--text)" onKeyDown={onKeyDown}>
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-(--border) bg-(--surface) px-3 py-2">
        <input
          aria-label="Design name"
          value={design.name}
          onChange={(e) => api.getState().commit((d) => ({ ...d, name: e.target.value }), "name")}
          onBlur={() => api.getState().endGesture()}
          className="h-8 w-44 min-w-0 rounded-(--radius-sm) border border-transparent bg-transparent px-2 font-(family-name:--font-display,var(--font-sans)) text-base font-medium hover:border-(--border) focus-visible:border-(--border) focus-visible:outline-2 focus-visible:outline-(--accent)"
        />
        <span role="status" className="flex items-center gap-1 text-xs" style={{ color: save.status === "error" ? "var(--danger)" : "var(--text-muted)" }}>
          <span aria-hidden="true">{save.status === "saved" ? "✓" : save.status === "saving" ? "…" : "!"}</span>
          {unsaved ? "Shared copy — not saved" : SAVE_TEXT[save.status]}
          {unsaved && (
            <button type="button" onClick={() => {
                if (saverRef.current) persist(saverRef.current, api.getState().design);
                setUnsaved(false);
              }} className="ml-1 rounded-(--radius-sm) border border-(--border) px-2 py-0.5 text-(--text) hover:bg-(--surface-2)">
              Save
            </button>
          )}
          {save.status === "error" && <button type="button" onClick={() => void saverRef.current?.retry()} className="underline">Retry</button>}
        </span>
        <span className="flex items-center">
          <button type="button" className={tbtn} disabled={!canUndo} onClick={() => api.getState().undo()} aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
          <button type="button" className={tbtn} disabled={!canRedo} onClick={() => api.getState().redo()} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">↷</button>
        </span>
        <div role="group" aria-label="Editor view" className="flex rounded-(--radius-sm) border border-(--border) p-0.5">
          {(["board", "list"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className="h-7 rounded-[calc(var(--radius-sm)-2px)] px-2.5 text-xs text-(--text-muted) focus-visible:outline-2 focus-visible:outline-(--accent) aria-pressed:bg-(--surface-2) aria-pressed:text-(--text)">
              {v === "board" ? "Board" : "List"}
            </button>
          ))}
        </div>
        <button type="button" className={`${tbtn} border border-(--border)`} onClick={() => setPalette(true)} title="Find or add a component (Ctrl+K)">
          Search <kbd className="ml-1 rounded border border-(--border) px-1 font-mono text-[10px]">Ctrl K</kbd>
        </button>
        <button type="button" className={tbtn} onClick={() => setTourOpen(true)} aria-pressed={tourOpen} title="Replay the four-step getting-started tour">
          <span aria-hidden="true" className="font-(family-name:--font-display) italic">?</span> Guide
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RunControls runKey={designId} onRun={() => startRun()} blockedReason={blocked} onFix={fixFirst} />
          <details ref={exportRef} className="relative">
            <summary className={`${tbtn} flex cursor-pointer list-none items-center border border-(--border)`}>Export ▾</summary>
            <div className="absolute right-0 z-40 mt-1 flex w-60 flex-col gap-0.5 rounded-(--radius) border border-(--border) bg-(--surface) p-1.5 shadow-(--elev-3)">
              <button type="button" className={menuItem} onClick={() => void doExport("sds")}>Design file (.sds.json)</button>
              <button type="button" className={menuItem} onClick={() => void doExport("png")}>Image (PNG)</button>
              <button type="button" className={menuItem} onClick={() => void doExport("svg")}>Vector (SVG)</button>
              <label className="flex min-h-9 items-center gap-2 px-2.5 text-sm">
                <input type="checkbox" className="size-4 accent-(--accent)" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
                Include the metric overlay
              </label>
              <hr className="my-1 border-(--border)" />
              <button type="button" className={menuItem} onClick={() => { exportRef.current?.removeAttribute("open"); importRef.current?.click(); }}>Import a design file…</button>
            </div>
          </details>
          <input ref={importRef} type="file" accept=".json,.sds.json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void doImport(f); }} />
          <button type="button" className={`${tbtn} border border-(--border)`} onClick={() => void share()}>Share</button>
        </div>
      </div>
      <RunBanner runKey={designId} />
      <LiveEdits runKey={designId} design={design} />

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(420px,60dvh)_auto] md:grid-cols-[minmax(0,1fr)_400px] md:grid-rows-1 lg:grid-cols-[minmax(0,1fr)_440px]">
        <main className="relative min-h-0 overflow-hidden" aria-label={view === "board" ? "Whiteboard" : "Component list"}>
          {view === "board" ? (
            <Whiteboard
              runKey={designId}
              allowedKinds={challenge?.spec.allowedKinds}
              look={look}
              setLook={setLook}
              reducedMotion={reducedMotion}
              notify={notify}
              openInspector={openInspector}
              requestDelete={requestDelete}
              heat={heat}
            />
          ) : (
            <ListEditor runKey={designId} allowedKinds={challenge?.spec.allowedKinds} notify={notify} openInspector={openInspector} requestDelete={requestDelete} />
          )}
          {toast && (
            <p role="status" className="absolute bottom-4 left-1/2 z-30 max-w-[90%] -translate-x-1/2 rounded-(--radius) border border-(--border) bg-(--surface-2) px-3.5 py-2 text-sm shadow-(--elev-3)">
              {toast}
            </p>
          )}
        </main>

        <aside className="flex min-h-0 flex-col border-t border-(--border) bg-(--surface) md:border-l md:border-t-0">
          <div role="tablist" aria-label="Panels" className="flex shrink-0 flex-wrap gap-0.5 border-b border-(--border) px-2"
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const i = tabs.findIndex((t) => t.id === tab);
              const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
              setTab(next.id);
              (e.currentTarget.querySelector(`#tab-${designId}-${next.id}`) as HTMLElement | null)?.focus();
            }}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                id={`tab-${designId}-${t.id}`}
                data-tour={t.id === "results" ? "results" : undefined}
                role="tab"
                type="button"
                aria-selected={tab === t.id}
                aria-controls={`panel-${designId}`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                className="relative flex h-10 shrink-0 items-center gap-1.5 px-2 text-sm text-(--text-muted) hover:text-(--text) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent) aria-selected:text-(--text) aria-selected:after:absolute aria-selected:after:inset-x-2 aria-selected:after:bottom-0 aria-selected:after:h-0.5 aria-selected:after:bg-(--accent)"
              >
                {t.label}
                {t.badge && <span className="rounded-full bg-(--danger) px-1.5 text-[10px] font-semibold leading-4 text-(--bg)" aria-label={`${t.badge} issues`}>{t.badge}</span>}
              </button>
            ))}
          </div>
          <div
            ref={panelRef}
            id={`panel-${designId}`}
            role="tabpanel"
            aria-labelledby={`tab-${designId}-${tab}`}
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-y-auto p-4 outline-none"
          >
            {tab === "inspect" && <Inspector requestDelete={requestDelete} />}
            {tab === "scenario" && <ScenarioEditor scenario={scenario} design={design} onChange={setScenario} live={live} />}
            {tab === "checks" && <ValidationPanel issues={issues} design={design} onShow={openInspector} />}
            {tab === "results" && <ResultsPanel runKey={designId} design={design} />}
            {tab === "trace" && <TracePanel key={hash} design={design} issues={issues.length} />}
            {tab === "scale" && <>
              {reference && <details className="mb-4 border-y border-rule py-3">
                <summary className="min-h-6 cursor-pointer">{reference.title}: illustrative assumptions</summary>
                <p className="mt-2 text-sm text-muted">Editable illustrative model. These capacities are assumptions, not a production configuration.</p>
                <ul className="mt-2 grid gap-2 text-sm">{reference.assumptions.map((a) => <li key={a.claim}>{a.claim}: {a.value}{a.source && <> — <a href={a.source.url} className="underline">{a.source.title}</a></>}</li>)}</ul>
              </details>}
              <ScalePanel design={design} scenario={runScenario} onHeat={setHeat} />
            </>}
            {tab === "challenge" && challenge && <ChallengePanel challenge={challenge} design={design} blocked={blocked} onReplay={startRun} />}
          </div>
        </aside>
      </div>

      <Tour open={tourOpen} onClose={() => setTourOpen(false)} rootRef={rootRef} nodes={design.nodes.length} edges={design.edges.length} runStatus={run.status} />

      <CommandPalette open={palette} onClose={() => setPalette(false)} design={design} allowed={challenge?.spec.allowedKinds} onAdd={addFromPalette} onGo={goTo} />

      <dialog
        ref={confirmRef}
        onClose={() => setPendingDelete(null)}
        aria-labelledby={`del-${designId}`}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-(--radius) border border-(--border) bg-(--surface) p-0 text-(--text) backdrop:bg-[color-mix(in_oklab,var(--bg)_60%,transparent)]"
      >
        {pendingDelete && (
          <form method="dialog" className="flex flex-col gap-3 p-4">
            <h2 id={`del-${designId}`} className="text-base font-semibold">Delete and break {pendingDelete.refs.length} route step{pendingDelete.refs.length === 1 ? "" : "s"}?</h2>
            <p className="text-sm text-(--text-muted)">These steps use what you are deleting. They won&apos;t be rewritten: the design becomes invalid until you reconnect, undo, or remove them.</p>
            <ul className="max-h-48 overflow-y-auto rounded-(--radius-sm) bg-(--bg) p-2 text-xs leading-6">
              {pendingDelete.refs.map((r, i) => (
                <li key={i}>
                  {design.nodes.find((n) => n.id === r.owner)?.label} · <span className="font-mono">{design.endpoints.find((e) => e.id === r.endpointId)?.name ?? r.endpointId}</span> · {describeStep(design, r.step)}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button value="cancel" autoFocus className="h-9 rounded-(--radius-sm) border border-(--border) px-3 text-sm hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)">Cancel</button>
              <button
                value="delete"
                onClick={() => {
                  api.getState().commit((d) => removeElements(d, pendingDelete.req));
                  api.getState().select(null);
                  setTab("checks");
                }}
                className="h-9 rounded-(--radius-sm) bg-(--danger) px-3 text-sm font-semibold text-(--bg) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--danger)"
              >
                Delete
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}

/** Acked / rejected state of live edits made during the current run (§5.7). */
function LiveEdits({ runKey, design }: { runKey: string; design: Design }) {
  const run = runs.useRun(runKey);
  const shown = run.edits.slice(-4).reverse();
  if (!shown.length || run.status === "idle") return null;
  const latest = run.edits.at(-1)!;
  const what = (e: runs.LiveEditState) => `${e.nodeId.startsWith("@") ? e.nodeId.slice(1) : elementName(design, e.nodeId)} ${e.path}`;
  const text = (e: runs.LiveEditState) =>
    e.state === "acked" ? `applied at t = ${fmtMs(e.atUs)}` : e.state === "rejected" ? `rejected: ${e.reason}` : "waiting for the next event…";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-(--border) bg-(--surface) px-4 py-1.5 text-xs">
      <span className="font-medium text-(--text)">Live edits</span>
      {shown.map((e) => (
        <span key={e.seq} className="flex items-center gap-1" style={{ color: e.state === "acked" ? "var(--success)" : e.state === "rejected" ? "var(--danger)" : "var(--text-muted)" }}>
          <span aria-hidden="true">{e.state === "acked" ? "✓" : e.state === "rejected" ? "✕" : "…"}</span>
          <span className="text-(--text)">{what(e)}</span> {text(e)}
        </span>
      ))}
      <span className="sr-only" aria-live="polite">{`${what(latest)} ${text(latest)}`}</span>
      {run.status === "stale" && <span className="text-(--warning)">Run stopped; undo restores the earlier values.</span>}
    </div>
  );
}
