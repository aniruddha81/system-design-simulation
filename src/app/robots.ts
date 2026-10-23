import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/content/schema";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/sandbox", "/dev"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
