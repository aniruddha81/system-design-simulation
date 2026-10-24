import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { caseStudies } from "@/content/case-studies";
import { getChallenge } from "@/content/challenges";
import { getLesson, loadLessons } from "@/lib/content/loader";
import { CaseStudyView } from "@/components/CaseStudyView";
import { diffComponentKinds, InterviewSession, secondsRemaining } from "@/components/interview/InterviewSession";
import { resolveDesignRequest } from "@/components/sandbox/open-design";
import { NavList } from "@/components/ui/shell";
import CaseStudiesPage from "./case-studies/page";
import CaseStudyPage from "./case-studies/[id]/page";
import InterviewPage from "./interview/page";
import InterviewCasePage from "./interview/[caseId]/page";
import LessonPage from "./learn/[track]/[lesson]/page";
import ChallengePage from "./challenges/[id]/page";
import NotFound from "./not-found";

function checkLink(href: string) {
  const url = new URL(href.replaceAll("&amp;", "&"), "https://example.test");
  if (url.origin !== "https://example.test") return;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "learn" && parts.length === 3) expect(getLesson(parts[1], parts[2]), href).toBeDefined();
  else if (parts[0] === "challenges" && parts.length === 2) expect(getChallenge(parts[1]), href).toBeDefined();
  else if (["case-studies", "interview"].includes(parts[0]) && parts.length === 2) expect(caseStudies.some((c) => c.id === parts[1]), href).toBe(true);
  else if (parts[0] === "sandbox" && (url.searchParams.has("ref") || url.searchParams.has("case"))) expect(resolveDesignRequest(url.searchParams), href).not.toBeNull();
  else expect(fs.existsSync(path.join("src/app", ...parts, "page.tsx")), href).toBe(true);
}

describe("application integration", () => {
  it("has every PLAN §4 route", () => {
    for (const route of ["", "learn", "learn/[track]/[lesson]", "sandbox", "sandbox/[designId]", "challenges", "challenges/[id]", "case-studies/[id]", "interview/[caseId]", "reference", "progress", "settings"]) {
      expect(fs.existsSync(path.join("src/app", route, "page.tsx")), route).toBe(true);
    }
  });

  it("resolves navigation, case-study, interview and lesson links", () => {
    const html = [renderToStaticMarkup(createElement(NavList)), renderToStaticMarkup(CaseStudiesPage()), renderToStaticMarkup(InterviewPage()),
      ...caseStudies.flatMap((c) => [renderToStaticMarkup(createElement(CaseStudyView, { study: c })), renderToStaticMarkup(createElement(InterviewSession, { study: c }))])];
    for (const source of [...html, ...loadLessons().map((l) => l.source)]) {
      for (const match of source.matchAll(/href="([^"]+)"/g)) checkLink(match[1]);
    }
  });

  it("uses branded not-found handling for unknown content slugs", async () => {
    expect(renderToStaticMarkup(NotFound())).toContain("A page missing from the notebook.");
    for (const promise of [
      CaseStudyPage({ params: Promise.resolve({ id: "missing" }) }),
      InterviewCasePage({ params: Promise.resolve({ caseId: "missing" }) }),
      LessonPage({ params: Promise.resolve({ track: "missing", lesson: "missing" }), searchParams: Promise.resolve({}) }),
      ChallengePage({ params: Promise.resolve({ id: "missing" }), searchParams: Promise.resolve({}) }),
    ]) await expect(promise).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("keeps component and page colours in tokens", () => {
    for (const dir of ["src/app", "src/components"]) for (const name of fs.readdirSync(dir, { recursive: true })) {
      const file = path.join(dir, String(name));
      if (!/\.(tsx|css)$/.test(file) || /(?:globals\.css|opengraph-image\.tsx)$/.test(file)) continue;
      // Browser metadata cannot resolve CSS variables (DESIGN.md); it repeats the two canvas tokens.
      const source = fs.readFileSync(file, "utf8").replace(/export const viewport: Viewport = \{[\s\S]*?\n\};/, "");
      expect(source, file).not.toMatch(/#[\da-f]{3,8}\b|\brgba?\(|\boklch\(/i);
    }
  });

  it("handles timer rounding, pausing at the deadline and overtime", () => {
    expect(secondsRemaining(60_000, 0)).toBe(60);
    expect(secondsRemaining(60_000, 59_001)).toBe(1);
    expect(secondsRemaining(60_000, 60_000)).toBe(0);
    expect(secondsRemaining(60_000, 65_000)).toBe(0);
  });

  it("computes learner vs reference component-kind diffs", () => {
    const diff = diffComponentKinds(
      { nodes: [{ id: "c", kind: "client", label: "C", position: { x: 0, y: 0 }, params: { entry: "s" } }] },
      caseStudies[0].design,
    );
    expect(diff.find((r) => r.kind === "client")).toEqual({ kind: "client", learner: 1, reference: 1, delta: 0 });
    expect(diff.some((r) => r.reference > r.learner)).toBe(true);
  });
});
