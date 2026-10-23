/** Editor height = viewport minus the app header (W4's layout can set --app-header-h). Pages wrap the editor in it. */
export const EDITOR_FRAME = "h-[calc(100dvh-var(--app-header-h,0px))] min-h-[560px]";

export function EditorSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading editor">
      <div className="h-12 shrink-0 border-b border-(--border) bg-(--surface)" />
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(420px,60dvh)_auto] md:grid-cols-[minmax(0,1fr)_400px] md:grid-rows-1">
        <div className="animate-pulse bg-(--bg) motion-reduce:animate-none" />
        <div className="border-t border-(--border) bg-(--surface) md:border-l md:border-t-0" />
      </div>
    </div>
  );
}
