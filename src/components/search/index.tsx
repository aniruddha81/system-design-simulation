"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type MiniSearch from "minisearch";
import { resultLabels, resultTypes, searchDocuments, type SearchDocument } from "@/lib/search";
import { searchOptions } from "@/lib/search/options.mjs";

let pendingIndex: Promise<MiniSearch<SearchDocument>> | undefined;
function loadIndex() {
  return pendingIndex ??= Promise.all([import("minisearch"), fetch("/search-index.json")]).then(async ([{ default: Search }, response]) => {
    if (!response.ok) throw new Error("Search index could not be loaded");
    return Search.loadJSON<SearchDocument>(await response.text(), searchOptions);
  }).catch((error) => { pendingIndex = undefined; throw error; });
}

export function CommandPalette() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [index, setIndex] = useState<MiniSearch<SearchDocument>>();
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const results = index ? searchDocuments(index, query) : [];
  const selected = results[active];

  async function prepareIndex() {
    setError(false);
    try { setIndex(await loadIndex()); }
    catch { setError(true); }
  }

  function open() {
    if (dialog.current?.open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    dialog.current?.showModal();
    input.current?.focus();
    void prepareIndex();
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      // The sandbox owns this shortcut while its editor handles the bubbling event.
      if (document.querySelector("dialog[open]") && !dialog.current?.open) return;
      event.preventDefault();
      if (dialog.current?.open) dialog.current.close();
      else open();
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  useEffect(() => {
    if (selected) document.getElementById(`${id}-result-${active}`)?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [active, id, selected]);

  function choose(result: SearchDocument | undefined) {
    if (!result || !result.href.startsWith("/") || result.href.startsWith("//")) return;
    dialog.current?.close();
    router.push(result.href);
  }

  return (
    <>
      <button type="button" onClick={open} aria-haspopup="dialog" className="flex min-h-10 items-center gap-3 rounded-(--radius-sm) px-3 text-sm text-(--text) hover:bg-(--surface-2)">
        Search <kbd className="hidden rounded-(--radius-sm) border border-(--rule) px-1.5 font-mono text-xs sm:inline">⌘K / Ctrl K</kbd>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-help`}
        onClose={() => previousFocus.current?.focus()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = dialog.current?.querySelectorAll<HTMLElement>("input, button");
          if (!controls?.length) return;
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
        className="mx-auto mt-[10dvh] max-h-[80dvh] w-[min(40rem,calc(100%-2rem))] overflow-y-auto rounded-(--radius) border border-(--rule) bg-(--surface) p-0 text-(--text) shadow-(--elev-3) backdrop:bg-[color-mix(in_oklab,var(--bg)_80%,transparent)]"
      >
        <div className="flex items-center justify-between gap-4 px-4 pb-3 pt-4">
          <h2 id={`${id}-title`} className="font-display text-2xl">Search the notebook</h2>
          <button type="button" onClick={() => dialog.current?.close()} className="min-h-8 px-2 text-sm text-(--accent) underline underline-offset-4">Close <span className="font-mono text-xs">Esc</span></button>
        </div>
        <label htmlFor={`${id}-input`} className="sr-only">Search lessons, glossary, case studies and components</label>
        <input
          ref={input}
          id={`${id}-input`}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${id}-results`}
          aria-activedescendant={selected ? `${id}-result-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") setActive((active + 1) % Math.max(1, results.length));
            else if (event.key === "ArrowUp") setActive((active - 1 + results.length) % Math.max(1, results.length));
            else if (event.key === "Enter") choose(selected);
            else return;
            event.preventDefault();
          }}
          placeholder="Try cache, quorum or load balancer…"
          className="mx-4 mb-3 min-h-12 w-[calc(100%-2rem)] rounded-(--radius-sm) border border-(--rule) bg-(--bg) px-3 text-base text-(--text) caret-(--accent) placeholder:text-(--text-muted)"
        />
        <p role="status" className="px-4 pb-3 text-sm text-(--text-muted)">
          {error ? "Search could not load. Check your connection and retry." : !index ? "Loading search…" : !query.trim() ? "Search lessons, glossary, case studies and simulator components." : results.length ? `${results.length} results. Up to 6 per section.` : `No results for “${query}”. Try a shorter term.`}
        </p>
        {error && <button type="button" onClick={() => void prepareIndex()} className="mb-3 ml-4 min-h-8 px-2 text-(--accent) underline underline-offset-4">Retry search</button>}
        <div id={`${id}-results`} role="listbox" aria-label="Search results" aria-busy={!index && !error} className="max-h-[45dvh] overflow-y-auto border-t border-(--rule)">
          {resultTypes.map((type) => {
            const group = results.filter((result) => result.type === type);
            if (!group.length) return null;
            return (
              <div role="group" aria-labelledby={`${id}-${type}`} key={type} className="pb-3">
                <div id={`${id}-${type}`} className="px-4 pb-2 pt-4 font-display text-lg">{resultLabels[type]}</div>
                {group.map((result) => {
                  const position = results.indexOf(result);
                  return <div key={result.id} id={`${id}-result-${position}`} role="option" aria-selected={position === active} onPointerMove={() => setActive(position)} onClick={() => choose(result)} className="cursor-pointer border-y border-transparent px-4 py-3 hover:bg-(--surface-2) aria-selected:border-(--rule) aria-selected:bg-(--surface-2)">
                    <span className="block font-medium">{position === active && <span aria-hidden className="mr-2 text-(--accent)">→</span>}{result.title}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-(--text-muted)">{result.description}</span>
                  </div>;
                })}
              </div>
            );
          })}
        </div>
        <p id={`${id}-help`} className="border-t border-(--rule) px-4 py-3 text-xs text-(--text-muted)">↑ ↓ to move · Enter to open · Esc to close</p>
      </dialog>
    </>
  );
}
