import type { MetadataRoute } from "next";
import { SITE_NAME } from "@/lib/content/schema";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME, short_name: "Design Notebook",
    description: "Learn system design by drawing, running and breaking it.",
    id: "/", start_url: "/learn", scope: "/", display: "standalone", lang: "en",
    // Metadata and standalone icon files cannot resolve the CSS canvas tokens.
    background_color: "#f2efe6", theme_color: "#f2efe6",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
