import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { widgetSchemas } from "@/lib/content/schema";
import PreviewPage, { generateStaticParams } from "./page";
import { Preview } from "./preview";

afterEach(() => vi.unstubAllEnvs());

describe("development author preview", () => {
  it("lists and renders every registered widget and the Scale panel", () => {
    const ids = generateStaticParams().map(({ id }) => id);
    expect(ids).toEqual([...Object.keys(widgetSchemas), "ScalePanel"]);
    for (const id of ids) {
      const html = renderToStaticMarkup(createElement(Preview, { id, ids }));
      expect(html).toContain('aria-label="Widgets"');
      expect(html).not.toContain("Invalid props");
      expect(html).toContain(`href="/dev/preview/${id}"`);
      if (["HashRingPlayer", "IsolationPlayer", "ModelQuestion"].includes(id)) expect(html).toContain("New seed");
    }
  });

  it("returns a development page only for known IDs", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(await PreviewPage({ params: Promise.resolve({ id: "HashRingPlayer" }) })).toBeTruthy();
    await expect(PreviewPage({ params: Promise.resolve({ id: "unknown" }) })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("returns 404 in production, including known widget IDs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(PreviewPage({ params: Promise.resolve({ id: "HashRingPlayer" }) })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});
