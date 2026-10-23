import type { MetadataRoute } from "next";
import { loadLessons } from "@/lib/content/loader";
import { SITE_URL } from "@/lib/content/schema";

// /sandbox, /progress, /settings and /dev are deliberately absent (PLAN §16).
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, priority: 1 },
    { url: `${SITE_URL}/learn`, priority: 0.9 },
    { url: `${SITE_URL}/reference`, priority: 0.7 },
    { url: `${SITE_URL}/challenges`, priority: 0.7 },
    ...loadLessons().map((l) => ({ url: `${SITE_URL}/learn/${l.track}/${l.slug}`, lastModified: l.lastReviewed, priority: 0.8 })),
  ];
}
