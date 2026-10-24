import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { widgetSchemas } from "@/lib/content/schema";
import PreviewIndex from "./page";

afterEach(() => vi.unstubAllEnvs());

it("links every widget from the development preview index", () => {
  vi.stubEnv("NODE_ENV", "development");
  const html = renderToStaticMarkup(PreviewIndex());
  for (const id of [...Object.keys(widgetSchemas), "ScalePanel"]) expect(html).toContain(`href="/dev/preview/${id}"`);
});

it("hides the preview index in production", () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(() => PreviewIndex()).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});
