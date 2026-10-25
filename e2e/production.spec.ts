import { expect, test } from "@playwright/test";

test("health reports database reachability as JSON", async ({ request }) => {
  const response = await request.get("/api/health");
  expect([200, 503]).toContain(response.status());
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toEqual(response.status() === 200
    ? { ok: true, db: "up" }
    : { ok: false, db: "down" });
});

test("manifest describes an installable standalone app", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.name).toEqual(expect.any(String));
  expect(manifest.name.trim()).not.toBe("");
  expect(manifest.display).toBe("standalone");
  expect(Array.isArray(manifest.icons)).toBe(true);
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    expect(icon).toEqual(expect.objectContaining({ src: expect.any(String), sizes: expect.any(String), type: expect.any(String) }));
    expect(icon.src).not.toBe("");
  }
});

test("robots permits legal pages and advertises their sitemap", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  const text = await robots.text();
  expect(text).toMatch(/^Allow: \/\s*$/m);
  expect(text).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml\s*$/m);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBe(true);
  const xml = await sitemap.text();
  for (const path of ["/privacy", "/terms"]) {
    expect(text).not.toMatch(new RegExp(`^Disallow: ${path}(?:[/\\s*]|$)`, "m"));
    expect(xml).toContain(`${path}</loc>`);
  }
});

test("home sends security headers", async ({ request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBe(true);
  const headers = response.headers();
  expect(headers["content-security-policy"]).toMatch(/default-src\s/);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBeTruthy();
});

test("signed-out sync is unauthorized", async ({ request }) => {
  const response = await request.get("/api/sync");
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("same-origin error reports accept a tiny valid body", async ({ request, baseURL }) => {
  const response = await request.post("/api/errors", {
    headers: { Origin: new URL(baseURL!).origin },
    data: { message: "e2e smoke report", url: "/" },
  });
  expect(response.ok()).toBe(true);
});

test("same-origin error reports reject a 100 KB body", async ({ request, baseURL }) => {
  const response = await request.post("/api/errors", {
    headers: { Origin: new URL(baseURL!).origin, "Content-Type": "application/json" },
    data: JSON.stringify({ message: "x".repeat(100 * 1024 - 24), url: "/" }),
  });
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(response.status()).toBeLessThan(500);
});

test("missing route renders the notebook 404", async ({ page }) => {
  await page.goto("/missing-production-e2e-route");
  await expect(page.getByRole("heading", { level: 1, name: "A page missing from the notebook.", exact: true })).toBeVisible();
  await expect(page.getByText("404", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Curriculum", exact: true })).toHaveAttribute("href", "/learn");
});
