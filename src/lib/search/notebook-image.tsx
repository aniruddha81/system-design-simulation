import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { SITE_NAME } from "@/lib/content/schema";

export const imageSize = { width: 1200, height: 630 };

export async function notebookImage(title: string, description: string, section: string) {
  // ImageResponse cannot resolve CSS variables; read the paper tokens instead of duplicating colours.
  const css = await readFile(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  function token(name: string) {
    const value = css.match(new RegExp(`--${name}:\\s*(#[a-fA-F0-9]+)\\s*;`))?.[1];
    if (!value) throw new Error(`Missing paper colour token: ${name}`);
    return value;
  }
  const paper = token("bg"), sheet = token("surface"), ink = token("text"), pencil = token("text-muted"), accent = token("accent"), rule = token("border");

  return new ImageResponse(
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: paper, color: ink, padding: "44px 56px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, borderBottom: `2px solid ${ink}`, paddingBottom: 20 }}>
        <span>{SITE_NAME}</span>
        <span style={{ color: accent }}>{section}</span>
      </div>
      <div style={{ display: "flex", flex: 1, alignItems: "center", gap: 40 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 820 }}>
          <div style={{ fontSize: title.length > 65 ? 52 : 64, lineHeight: 1.08, letterSpacing: "-0.03em" }}>{title}</div>
          <div style={{ fontSize: 24, lineHeight: 1.4, marginTop: 24, color: pencil }}>{description}</div>
        </div>
        <svg width="180" height="270" viewBox="0 0 180 270" aria-hidden="true">
          <path d="M0 30H180M0 60H180M0 90H180M0 120H180M0 150H180M0 180H180M0 210H180M0 240H180M30 0V270M60 0V270M90 0V270M120 0V270M150 0V270" stroke={rule} strokeWidth="1" />
          <path d="M40 135H80V60H120M80 135V210H120" fill="none" stroke={ink} strokeWidth="3" />
          <circle cx="35" cy="135" r="15" fill={accent} />
          <rect x="112" y="42" width="48" height="36" rx="2" fill={sheet} stroke={ink} strokeWidth="3" />
          <path d="M112 196Q136 184 160 196V228Q136 240 112 228ZM112 196Q136 208 160 196" fill={sheet} stroke={ink} strokeWidth="3" />
        </svg>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, borderTop: `1px solid ${ink}`, paddingTop: 20 }}>
        <span>Draw it. Run it. Break it. Explain it.</span>
        <span style={{ color: accent }}>An engineer’s field notebook</span>
      </div>
    </div>,
    imageSize,
  );
}
