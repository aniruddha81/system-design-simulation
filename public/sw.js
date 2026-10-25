const CACHE = "design-notebook-v1";
const PREFIX = "design-notebook-";
const SHELL = ["/offline", "/learn", "/icons/icon-192.png", "/icons/icon-512.png"];

// Only public documents and immutable assets enter the offline cache.
function cacheRoute(request, origin) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== origin) return "network";
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) return "asset";
  if (request.mode !== "navigate" || url.search) return "network";
  if (["/offline", "/learn", "/privacy", "/terms", "/case-studies"].includes(url.pathname) ||
      /^\/(learn|case-studies)\/[^.]+$/.test(url.pathname)) return "page";
  return "network";
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok || response.redirected) throw new Error("Offline shell unavailable");
      await cache.put(url, response);
    }));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const route = cacheRoute(event.request, self.location.origin);
  if (route === "network") return;
  const key = event.request.url;
  const refresh = (async () => {
    // Fetch anonymous HTML so shared-device caches never retain signed-in UI.
    const response = await fetch(route === "page" ? new Request(key, { credentials: "omit", headers: { Accept: "text/html" } }) : event.request);
    const type = response.headers.get("content-type") || "";
    if (response.ok && !response.redirected && (route === "asset" || type.includes("text/html")) &&
        !/no-store|private/i.test(response.headers.get("cache-control") || "")) {
      const cache = await caches.open(CACHE);
      await cache.put(key, response.clone());
    }
    return response;
  })();
  event.waitUntil(refresh.catch(() => {}));
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    if (cached) return cached;
    try { return await refresh; }
    catch {
      if (route === "page") {
        const fallback = await cache.match("/offline");
        if (fallback) return fallback;
      }
      return Response.error();
    }
  })());
});
