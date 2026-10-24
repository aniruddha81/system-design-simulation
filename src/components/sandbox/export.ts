// Board export (§8, §11): standalone SVG/PNG of the design, with or without a metric overlay, and .sds.json.
import type { Design } from "@/engine/types";
import { exportDesign } from "@/lib/persistence";
import { strokePath } from "./Annotations";
import { heatColor, NODE_H, NODE_W, nodeShape, type Look } from "./board-elements";
import { KIND_LABEL } from "./design-ops";
import type { Annotation } from "./design-store";
import { KIND_COLOR, KIND_SHAPE, shapePath } from "./kinds";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Resolve a CSS colour expression (tokens, color-mix) against the live theme, so the file stands alone. */
function resolver(host: Element) {
  const probe = document.createElement("span");
  host.appendChild(probe);
  const cache = new Map<string, string>();
  return {
    color: (expr: string) => {
      if (!cache.has(expr)) {
        probe.style.color = "";
        probe.style.color = expr;
        cache.set(expr, getComputedStyle(probe).color);
      }
      return cache.get(expr)!;
    },
    font: getComputedStyle(host).fontFamily,
    done: () => probe.remove(),
  };
}

export function designToSvg(d: Design, opts: { look: Look; overlay?: Record<string, number>; host: Element }): string {
  const r = resolver(opts.host);
  const c = r.color;
  const groups = d.groups ?? [];
  const boxes = [
    ...d.nodes.map((n) => ({ x: n.position.x, y: n.position.y, w: NODE_W, h: NODE_H })),
    ...groups.map((g) => ({ x: g.position.x, y: g.position.y, w: g.size.w, h: g.size.h })),
    ...((d.annotations ?? []) as Annotation[]).flatMap((a) => (a.type === "stroke" ? a.points.map(([x, y]) => ({ x, y, w: 1, h: 1 })) : [{ x: a.x, y: a.y, w: 200, h: 60 }])),
  ];
  const pad = 40;
  const minX = Math.min(0, ...boxes.map((b) => b.x)) - pad, minY = Math.min(0, ...boxes.map((b) => b.y)) - pad;
  const W = Math.max(...boxes.map((b) => b.x + b.w), 200) + pad - minX, H = Math.max(...boxes.map((b) => b.y + b.h), 100) + pad - minY;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${Math.ceil(H)}" viewBox="${minX} ${minY} ${W} ${H}" font-family="${esc(r.font)}">`);
  out.push(`<title>${esc(d.name)}</title><rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="${c("var(--bg)")}"/>`);
  for (const g of groups) {
    const col = c(g.kind === "zone" ? "var(--accent-2)" : "var(--text-muted)");
    out.push(`<rect x="${g.position.x}" y="${g.position.y}" width="${g.size.w}" height="${g.size.h}" rx="16" fill="none" stroke="${col}" stroke-dasharray="${g.kind === "zone" ? "6 6" : "12 6"}"/>`);
    out.push(`<text x="${g.position.x + 14}" y="${g.position.y + 22}" font-size="12" fill="${col}">${g.kind === "zone" ? "Zone" : "Region"} ${esc(g.name)}</text>`);
  }
  const muted = c("var(--text-muted)");
  for (const e of d.edges) {
    const a = d.nodes.find((n) => n.id === e.from), b = d.nodes.find((n) => n.id === e.to);
    if (!a || !b) continue;
    const [x1, y1, x2, y2] = [a.position.x + NODE_W, a.position.y + NODE_H / 2, b.position.x, b.position.y + NODE_H / 2];
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = [ang - 0.45, ang + 0.45].map((t) => `${x2 - 10 * Math.cos(t)},${y2 - 10 * Math.sin(t)}`);
    out.push(`<path d="M${x1},${y1} L${x2},${y2} M${head[0]} L${x2},${y2} L${head[1]}" fill="none" stroke="${muted}" stroke-width="1.5" stroke-linecap="round"/>`);
  }
  const text = c("var(--text)"), surface = c("var(--surface)");
  for (const n of d.nodes) {
    const col = c(KIND_COLOR[n.kind]);
    const shape = shapePath(KIND_SHAPE[n.kind], NODE_W, NODE_H, 3);
    out.push(`<g transform="translate(${n.position.x},${n.position.y})">`);
    out.push(`<path d="${shape}" fill="${c(`color-mix(in oklab, ${KIND_COLOR[n.kind]} 10%, var(--surface))`) || surface}" stroke="${opts.look === "sketch" ? "none" : col}" stroke-width="1.25"/>`);
    if (opts.look === "sketch") for (const p of nodeShape(n.id, shape).outline) out.push(`<path d="${p}" fill="none" stroke="${col}" stroke-width="1.5"/>`);
    out.push(`<text x="16" y="32" font-size="13" font-weight="600" fill="${text}">${esc(n.label)}</text>`);
    out.push(`<text x="16" y="48" font-size="11" fill="${muted}">${esc(KIND_LABEL[n.kind])}</text>`);
    const v = opts.overlay?.[n.id];
    if (v != null) {
      out.push(`<rect x="16" y="58" width="${NODE_W - 64}" height="4" rx="2" fill="${c("var(--surface-2)")}"/><rect x="16" y="58" width="${(NODE_W - 64) * Math.min(1, v)}" height="4" rx="2" fill="${c(heatColor(v))}"/>`);
      out.push(`<text x="${NODE_W - 16}" y="63" font-size="10" text-anchor="end" fill="${muted}">${Math.round(v * 100)}%</text>`);
    }
    out.push(`</g>`);
  }
  for (const a of (d.annotations ?? []) as Annotation[]) {
    if (a.type === "stroke") out.push(`<path d="${strokePath(a.points)}" fill="${c(a.color)}"/>`);
    else {
      const lines = a.text.split("\n");
      if (a.type === "note") out.push(`<rect x="${a.x}" y="${a.y}" width="192" height="${24 + lines.length * 18}" rx="3" fill="${c("var(--highlight, var(--warning))")}"/>`);
      lines.forEach((l, i) => out.push(`<text x="${a.x + (a.type === "note" ? 12 : 0)}" y="${a.y + 22 + i * 18}" font-size="14" fill="${a.type === "note" ? c("var(--ink-2, var(--bg))") : text}">${esc(l)}</text>`));
    }
  }
  out.push("</svg>");
  r.done();
  return out.join("");
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = (d: Design) => (d.name.trim() || "design").replace(/[^\w.-]+/g, "-").slice(0, 60);

export async function exportSvgOrPng(d: Design, format: "svg" | "png", opts: { look: Look; overlay?: Record<string, number>; host: Element }) {
  const svg = designToSvg(d, opts);
  const suffix = opts.overlay ? "-metrics" : "";
  if (format === "svg") return download(new Blob([svg], { type: "image/svg+xml" }), `${fileBase(d)}${suffix}.svg`);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("Could not render the SVG")); img.src = url; });
    const scale = 2;
    const canvas = Object.assign(document.createElement("canvas"), { width: img.width * scale, height: img.height * scale });
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("Could not encode the PNG");
    download(blob, `${fileBase(d)}${suffix}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** `.sds.json` via the persistence exporter (validated, ≤ 2 MB). */
export async function exportSds(d: Design) {
  download(await exportDesign(d), `${fileBase(d)}.sds.json`);
}
