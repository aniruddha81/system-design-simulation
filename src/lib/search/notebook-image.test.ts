import { describe, expect, it } from "vitest";
import SiteImage from "@/app/opengraph-image";
import LessonImage from "@/app/learn/[track]/[lesson]/opengraph-image";
import CaseStudyImage from "@/app/case-studies/[id]/opengraph-image";
import { caseStudies } from "@/content/case-studies";
import { loadLessons } from "@/lib/content/loader";

describe("notebook OG images", () => {
  it("renders site, longest lesson and longest case-study copy as 1200 × 630 PNGs", async () => {
    const lesson = loadLessons().reduce((a, b) => a.title.length > b.title.length ? a : b);
    const study = caseStudies.reduce((a, b) => a.summary.length > b.summary.length ? a : b);
    for (const response of [
      await SiteImage(),
      await LessonImage({ params: Promise.resolve({ track: lesson.track, lesson: lesson.slug }) }),
      await CaseStudyImage({ params: Promise.resolve({ id: study.id }) }),
    ]) {
      expect(response.headers.get("content-type")).toBe("image/png");
      const png = Buffer.from(await response.arrayBuffer());
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(630);
    }
  }, 30_000);

  it("returns not-found for unknown content", async () => {
    await expect(LessonImage({ params: Promise.resolve({ track: "foundations", lesson: "missing" }) })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(CaseStudyImage({ params: Promise.resolve({ id: "missing" }) })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});
