import type { MetadataRoute } from "next";
import { caseStudies } from "@/content/case-studies";
import { loadLessons, matrix } from "@/lib/content/loader";
import { SITE_URL } from "@/lib/content/schema";

// /sandbox, /progress, /settings and /dev are deliberately absent (PLAN §16).
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, priority: 1 },
    { url: `${SITE_URL}/privacy`, priority: 0.3 },
    { url: `${SITE_URL}/terms`, priority: 0.3 },
    { url: `${SITE_URL}/learn`, priority: 0.9 },
    { url: `${SITE_URL}/reference`, priority: 0.7 },
    { url: `${SITE_URL}/challenges`, priority: 0.7 },
    { url: `${SITE_URL}/case-studies`, priority: 0.8 },
    { url: `${SITE_URL}/interview`, priority: 0.7 },
    ...loadLessons().filter((lesson) => matrix.lessons.some((entry) => entry.id === lesson.id && entry.status === "live"))
      .map((l) => ({ url: `${SITE_URL}/learn/${l.track}/${l.slug}`, lastModified: l.lastReviewed, priority: 0.8 })),
    ...caseStudies.map((study) => ({ url: `${SITE_URL}/case-studies/${study.id}`, priority: 0.8 })),
  ];
}
