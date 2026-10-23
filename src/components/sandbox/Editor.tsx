"use client";
// The sandbox editor: client-only (loaded with ssr:false by EditorLoader).
import { ReactFlowProvider } from "@xyflow/react";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Challenge } from "@/content/challenges";
import { designHash, validateDesign } from "@/engine";
import type { Design, Scenario, ValidationIssue } from "@/engine/types";
import { autosave, decodeShareLink, encodeShareLink, openStore, type SaveStatus } from "@/lib/persistence";
import * as runs from "@/lib/run-manager";
import { type Look } from "./board-elements";
import { ChallengePanel } from "./ChallengePanel";
import { EditorSkeleton } from "./EditorSkeleton";
import { affectedBy, describeStep, removeElements, type StepRef } from "./design-ops";
import {
  AnnotationCtx, createAnnotationStore, createDesignStore, DesignCtx, useDesign, useDesignApi,
} from "./design-store";
import { Inspector } from "./Inspector";
import { ListEditor } from "./ListEditor";
import { ResultsPanel } from "./ResultsPanel";
import { RunBanner, RunControls } from "./RunControls";
import { TracePanel } from "./TracePanel";
import { ValidationPanel } from "./ValidationPanel";
import { Whiteboard, type DeleteRequest } from "./Whiteboard";

export type EditorProps = {
  designId: string;
  scenario: Scenario;
  /** Used when nothing is stored under designId yet (challenge start). */
  fallback?: Design;
  challenge?: Challenge;
};

/** Loads the stored draft (or a #d= share link), then mounts the editor. */
export default function Editor(props: EditorProps) {
  const [state, setState] = useState<{ design: Design; unsaved?: boolean } | { missing: string } | null>(null);

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
      if (rec) setState({ design: rec.design });
      else if (props.fallback) setState({ design: { ...structuredClone(props.fallback), id: props.designId } });
      else setState({ missing: "This draft isn't in this browser. Drafts are stored locally — start a new one or open a share link." });
    })().catch((e) => alive && setState({ missing: `Couldn't open local storage: ${e instanceof Error ? e.message : e}` }));
    return () => { alive = false; };
  }, [props.designId, props.fallback]);

  if (!state) return <EditorSkeleton />;
  if ("missing" in state) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm">
          <p className="mb-4 text-sm text-(--text-muted)">{state.missing}</p>
          <Link href="/sandbox" className="inline-flex h-9 items-center rounded-(--radius-sm) bg-(--accent) px-4 text-sm font-semibold text-(--bg)">Start a new design</Link>
        </div>
      </div>
    );
  }
  return <Workspace {...props} designId={state.design.id} initial={state.design} unsaved={state.unsaved} />;
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

function Workspace(props: EditorProps & { initial: Design; unsaved?: boolean }) {
  const [store] = useState(() => createDesignStore(props.initial));
  const [annotations] = useState(() => createAnnotationStore(props.designId));
  return (
    <DesignCtx value={store}>
      <AnnotationCtx value={annotations}>
        <ReactFlowProvider>
          <WorkspaceInner {...props} />
        </ReactFlowProvider>
      </AnnotationCtx>
    </DesignCtx>
  );
}

function persist(saver: ReturnType<typeof autosave>, d: Design) {
  saver.schedule(d);
  // A shared copy (/sandbox/shared#d=…) becomes a real local draft with its own URL.
  if (location.pathname.startsWith("/sandbox/") && location.pathname !== `/sandbox/${d.id}`) history.replaceState(null, "", `/sandbox/${d.id}`);
}

type Tab = "inspect" | "checks" | "results" | "trace" | "challenge";

function WorkspaceInner({ designId, scenario: baseScenario, challenge, unsaved: openedUnsaved }: EditorProps & { unsaved?: boolean }) {
  const design = useDesign((s) => s.design);
  const canUndo = useDesign((s) => s.past.length > 0);
  const canRedo = useDesign((s) => s.future.length > 0);
  const api = useDesignApi();
  const run = runs.useRun(designId);
  const reducedMotion = usePrefersReducedMotion();
  const [view, setView] = useState<"board" | "list">(() => (matchMedia("(max-width: 767px)").matches ? "list" : "board"));
  const [look, setLook] = useState<Look>("sketch");
  const [tab, setTab] = useState<Tab>(challenge ? "challenge" : "inspect");
  const [toast, setToast] = useState<string | null>(null);
  const [save, setSave] = useState<{ status: SaveStatus; persistent: boolean }>({ status: "saved", persistent: true });
  const saverRef = useRef<ReturnType<typeof autosave> | null>(null);
  const [unsaved, setUnsaved] = useState(!!openedUnsaved);
  const [pendingDelete, setPendingDelete] = useState<{ req: DeleteRequest; refs: StepRef[] } | null>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Chaos may only target nodes that exist in this design.
  const scenario: Scenario = { ...baseScenario, chaos: baseScenario.chaos.filter((c) => design.nodes.some((n) => n.id === c.target)) };
  let issues: ValidationIssue[];
  try {
    issues = validateDesign(design, scenario);
  } catch (e) {
    issues = [{ code: "VALIDATOR_ERROR", message: e instanceof Error ? e.message : String(e) }];
  }
  const hash = designHash(design);
  const blocked = issues.length ? `Fix ${issues.length} validation issue${issues.length === 1 ? "" : "s"} first (see Checks).` : null;

  function notify(msg: string) {
    setToast(msg);
  }
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // Structural/param edits after a run make its results stale (§5.7).
  useEffect(() => {
    if (run.runKey && run.runKey.designHash !== hash) runs.markStale(designId);
  }, [hash, run.runKey, designId]);

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
    return () => {
      unsub();
      void saver.flush().finally(() => saver.dispose());
    };
  }, [api, designId]);

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
    runs.start(designId, { design, scenario: input?.scenario ?? scenario, seed: input?.seed ?? 1 });
    setTab("results");
  }


  async function share() {
    const hashPart = encodeShareLink(design);
    if (!hashPart) return notify("Too large to share as a link — use export instead.");
    const url = `${location.origin}/sandbox/shared${hashPart}`;
    try {
      await navigator.clipboard.writeText(url);
      notify("Share link copied. Opening it creates a copy in the recipient's browser.");
    } catch {
      prompt("Copy this share link:", url);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (!(e.metaKey || e.ctrlKey) || t.closest("input, textarea, select")) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) api.getState().undo();
    else if ((k === "z" && e.shiftKey) || k === "y") api.getState().redo();
    else return;
    e.preventDefault();
  }

  const tabs: { id: Tab; label: string; badge?: string }[] = [
    ...(challenge ? [{ id: "challenge" as Tab, label: "Challenge" }] : []),
    { id: "inspect", label: "Inspect" },
    { id: "checks", label: "Checks", badge: issues.length ? String(issues.length) : undefined },
    { id: "results", label: "Results" },
    { id: "trace", label: "Trace" },
  ];
  const SAVE_TEXT: Record<SaveStatus, string> = { saved: save.persistent ? "Saved" : "Saved in memory only", saving: "Saving…", error: "Not saved" };
  const tbtn = "h-8 rounded-(--radius-sm) px-2.5 text-sm text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-35 disabled:hover:bg-transparent";

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--bg) text-(--text)" onKeyDown={onKeyDown}>
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-(--border) bg-(--surface) px-3 py-2">
        <input
          aria-label="Design name"
          value={design.name}
          onChange={(e) => api.getState().commit((d) => ({ ...d, name: e.target.value }), "name")}
          onBlur={() => api.getState().endGesture()}
          className="h-8 w-44 min-w-0 rounded-(--radius-sm) border border-transparent bg-transparent px-2 text-sm font-medium hover:border-(--border) focus-visible:border-(--border) focus-visible:outline-2 focus-visible:outline-(--accent)"
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
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RunControls runKey={designId} onRun={() => startRun()} blockedReason={blocked} />
          <button type="button" className={`${tbtn} border border-(--border)`} onClick={() => void share()}>Share</button>
        </div>
      </div>
      <RunBanner runKey={designId} />

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(420px,60dvh)_auto] md:grid-cols-[minmax(0,1fr)_400px] md:grid-rows-1">
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
            />
          ) : (
            <ListEditor runKey={designId} allowedKinds={challenge?.spec.allowedKinds} notify={notify} openInspector={openInspector} requestDelete={requestDelete} />
          )}
          {toast && (
            <p role="status" className="absolute bottom-4 left-1/2 z-30 max-w-[90%] -translate-x-1/2 rounded-(--radius) border border-(--border) bg-(--surface-2) px-3.5 py-2 text-sm shadow-xl">
              {toast}
            </p>
          )}
        </main>

        <aside className="flex min-h-0 flex-col border-t border-(--border) bg-(--surface) md:border-l md:border-t-0">
          <div role="tablist" aria-label="Panels" className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-(--border) px-2"
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
                role="tab"
                type="button"
                aria-selected={tab === t.id}
                aria-controls={`panel-${designId}`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                className="relative flex h-10 items-center gap-1.5 px-2.5 text-sm text-(--text-muted) hover:text-(--text) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent) aria-selected:text-(--text) aria-selected:after:absolute aria-selected:after:inset-x-2 aria-selected:after:bottom-0 aria-selected:after:h-0.5 aria-selected:after:bg-(--accent)"
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
            {tab === "checks" && <ValidationPanel issues={issues} design={design} onShow={openInspector} />}
            {tab === "results" && <ResultsPanel runKey={designId} design={design} />}
            {tab === "trace" && <TracePanel key={hash} design={design} issues={issues.length} />}
            {tab === "challenge" && challenge && <ChallengePanel challenge={challenge} design={design} blocked={blocked} onReplay={startRun} />}
          </div>
        </aside>
      </div>

      <dialog
        ref={confirmRef}
        onClose={() => setPendingDelete(null)}
        aria-labelledby={`del-${designId}`}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-(--radius) border border-(--border) bg-(--surface) p-0 text-(--text) backdrop:bg-black/60"
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
