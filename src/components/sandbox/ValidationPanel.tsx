"use client";
import type { Design, ValidationIssue } from "@/engine/types";
import { brokenRefs, describeStep, removeBrokenSteps } from "./design-ops";
import { useDesignApi } from "./design-store";

export function ValidationPanel({ issues, design, onShow }: { issues: ValidationIssue[]; design: Design; onShow: () => void }) {
  const { commit, select } = useDesignApi().getState();
  const broken = brokenRefs(design);
  const name = (id?: string) => design.nodes.find((n) => n.id === id)?.label ?? id;
  const epName = (id: string) => design.endpoints.find((e) => e.id === id)?.name ?? id;

  if (issues.length === 0 && broken.length === 0) {
    return <p className="flex items-center gap-2 text-sm text-(--success)"><span aria-hidden="true">✓</span> Design is valid — ready to run.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {broken.length > 0 && (
        <section className="rounded-(--radius-sm) border border-(--warning) p-3">
          <h3 className="mb-1 text-sm font-medium text-(--warning)">⚠ {broken.length} route step{broken.length === 1 ? "" : "s"} lost a connection</h3>
          <p className="mb-2 text-xs text-(--text-muted)">Nothing was rewritten. Reconnect the components, undo, or remove these steps.</p>
          <ul className="mb-3 flex flex-col gap-1 text-xs">
            {broken.map((r, i) => (
              <li key={i}>
                <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-(--accent)" onClick={() => { select({ kind: "node", id: r.owner }); onShow(); }}>
                  {name(r.owner)} · <span className="font-mono">{epName(r.endpointId)}</span> · step {r.path.filter((_, j) => j % 2 === 0).map((x) => x + 1).join(".")}: {describeStep(design, r.step)}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => commit(removeBrokenSteps)} className="h-8 rounded-(--radius-sm) border border-(--border) px-3 text-sm hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)">
            Remove these steps
          </button>
        </section>
      )}
      {issues.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-(--danger)">✕ {issues.length} issue{issues.length === 1 ? "" : "s"} block running</h3>
          <ul className="flex flex-col gap-2">
            {issues.map((iss, i) => (
              <li key={i} className="rounded-(--radius-sm) bg-(--bg) p-2 text-sm">
                <p>{iss.message}</p>
                <p className="mt-0.5 flex items-center gap-2 text-xs text-(--text-muted)">
                  <span className="font-mono">{iss.code}</span>
                  {(iss.nodeId || iss.edgeId) && (
                    <button
                      type="button"
                      className="text-(--accent) underline-offset-2 hover:underline"
                      onClick={() => {
                        select(iss.nodeId ? { kind: "node", id: iss.nodeId } : { kind: "edge", id: iss.edgeId! });
                        onShow();
                      }}
                    >
                      Show {iss.nodeId ? name(iss.nodeId) : "connection"}
                    </button>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
