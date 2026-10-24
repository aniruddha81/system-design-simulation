"use client";
// ⌘K / Ctrl+K: add a component by name, or jump to one already on the board.
import { useEffect, useId, useRef, useState } from "react";
import type { ComponentKind, Design } from "@/engine/types";
import { KIND_LABEL } from "./design-ops";
import { KIND_BLURB, KINDS, KindSwatch } from "./kinds";

type Item = { id: string; kind: ComponentKind; title: string; sub: string; run: () => void };

export function CommandPalette({ open, onClose, design, allowed, onAdd, onGo }: {
  open: boolean; onClose: () => void; design: Design; allowed?: ComponentKind[];
  onAdd: (k: ComponentKind) => void; onGo: (nodeId: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  }, [open]);

  const query = q.trim().toLowerCase();
  const items: Item[] = [
    ...KINDS.filter((k) => !allowed || allowed.includes(k)).map((k) => ({ id: `add-${k}`, kind: k, title: `Add ${KIND_LABEL[k].toLowerCase()}`, sub: KIND_BLURB[k], run: () => onAdd(k) })),
    ...design.nodes.map((n) => ({ id: `go-${n.id}`, kind: n.kind, title: `Go to ${n.label}`, sub: `${KIND_LABEL[n.kind]} · ${n.id}`, run: () => onGo(n.id) })),
  ].filter((i) => `${i.title} ${i.sub}`.toLowerCase().includes(query));
  const cur = Math.min(active, Math.max(0, items.length - 1));

  function pick(i: Item | undefined) {
    if (!i) return;
    onClose();
    i.run();
  }

  return (
    <dialog
      ref={ref}
      onClose={() => { setQ(""); setActive(0); onClose(); }}
      aria-label="Find or add a component"
      className="mx-auto mt-[12vh] w-[min(34rem,calc(100vw-2rem))] rounded-(--radius-lg) border border-(--border) bg-(--surface) p-0 text-(--text) shadow-(--elev-3) backdrop:bg-[color-mix(in_oklab,var(--bg)_50%,transparent)]"
    >
      <div className="flex flex-col">
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={items[cur] ? `${id}-${items[cur].id}` : undefined}
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((cur + 1) % Math.max(1, items.length));
            else if (e.key === "ArrowUp") setActive((cur - 1 + items.length) % Math.max(1, items.length));
            else if (e.key === "Enter") pick(items[cur]);
            else return;
            e.preventDefault();
          }}
          placeholder="Add a component or find one on the board…"
          className="h-12 border-b border-(--border) bg-transparent px-4 text-base outline-none placeholder:text-(--text-muted)"
        />
        <ul id={`${id}-list`} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.map((i, n) => (
            <li
              key={i.id}
              id={`${id}-${i.id}`}
              role="option"
              aria-selected={n === cur}
              onMouseEnter={() => setActive(n)}
              onClick={() => pick(i)}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-(--radius-sm) px-2.5 py-1.5 aria-selected:bg-(--surface-2)"
            >
              <KindSwatch kind={i.kind} size={28} />
              <span className="min-w-0">
                <span className="block text-sm">{i.title}</span>
                <span className="block truncate text-xs text-(--text-muted)">{i.sub}</span>
              </span>
            </li>
          ))}
          {items.length === 0 && <li className="px-3 py-4 text-sm text-(--text-muted)">Nothing matches “{q}”.</li>}
        </ul>
        <p className="border-t border-(--border) px-4 py-2 text-[11px] text-(--text-muted)">↑ ↓ to move, Enter to choose, Esc to close</p>
      </div>
    </dialog>
  );
}
