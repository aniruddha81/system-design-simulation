import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8");
const layout = readFileSync("src/app/layout.tsx", "utf8");
const bootstrap = layout.match(/const PREFS_SCRIPT = `([^`]+)`/)![1];
const kinds = [...readFileSync("src/engine/types.ts", "utf8")
  .match(/export type ComponentKind =([\s\S]+?);/)![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map((c) => parseInt(c, 16) / 255)
    .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function contrast(a: string, b: string) {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}

describe("field notebook contrast contract", () => {
  const themes = [...css.matchAll(/color-scheme: (light|dark);([\s\S]+?)\n}/g)];
  it("defines both themes and every component kind", () => {
    expect(themes.map((t) => t[1])).toEqual(["light", "dark"]);
    expect(kinds).toHaveLength(17);
    for (const name of ["highlight", "ink-2", "font-display", "paper-grid", "brand", "brand-angle", "grid-line"]) {
      expect(css).toContain(`--${name}:`);
    }
  });
  for (const [, theme, block] of themes) {
    it(`${theme}: AA text, controls, component strokes and heat marks on all surfaces`, () => {
      const t = Object.fromEntries([...block.matchAll(/--([\w-]+): (#[\da-f]{6});/g)].map((m) => [m[1], m[2]]));
      for (const bg of ["bg", "surface", "surface-2"]) {
        for (const fg of ["text", "ink-2", "text-muted", "accent", "accent-2", "danger", "warning", "success"]) {
          expect(contrast(t[fg], t[bg]), `${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
        for (const fg of ["rule", ...kinds.map((k) => `kind-${k}`), ...[0, 1, 2, 3, 4].map((i) => `heat-${i}`)]) {
          expect(contrast(t[fg], t[bg]), `${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
        }
      }
      for (const bg of ["accent", "accent-hover"]) {
        expect(contrast(t["accent-ink"], t[bg]), `${theme}: primary button`).toBeGreaterThanOrEqual(4.5);
      }
      // Sodium is a marker background, never a small-text foreground.
      expect(contrast(t[theme === "light" ? "text" : "bg"], t.highlight)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("theme before first paint", () => {
  it.each([
    [null, true, "light"],
    ["dark", false, "dark"],
    ["light", true, "light"],
    ["system", true, "dark"],
    ["system", false, "light"],
  ])("preference %s, OS dark %s resolves to %s", (preference, osDark, expected) => {
    const attrs: Record<string, string> = { "data-theme": "light" };
    runInNewContext(bootstrap, {
      document: { documentElement: { setAttribute: (key: string, value: string) => { attrs[key] = value; } } },
      localStorage: { getItem: (key: string) => key === "theme" ? preference : "off" },
      matchMedia: () => ({ matches: osDark }),
    });
    expect(attrs["data-theme"]).toBe(expected);
    expect(attrs["data-motion"]).toBe("off");
  });
  it("keeps Paper usable if storage is blocked", () => {
    const attrs = { "data-theme": "light" };
    expect(() => runInNewContext(bootstrap, {
      document: { documentElement: { setAttribute: (key: "data-theme", value: string) => { attrs[key] = value; } } },
      localStorage: { getItem: () => { throw new Error("Storage blocked"); } },
    })).not.toThrow();
    expect(attrs["data-theme"]).toBe("light");
  });
});
