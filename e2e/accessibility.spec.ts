import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// One representative for every production page template, including missing routes
// and the development-only preview's production 404. Metadata endpoints have no UI.
const routes = [
  "/", "/learn", "/learn/building-blocks/caching", "/challenges",
  "/challenges/cache-aside-recovery", "/sandbox", "/sandbox?template=cache-aside",
  "/progress", "/reference", "/settings", "/missing-e2e-route", "/dev/preview/Choice",
];

for (const route of routes) {
  for (const theme of ["light", "dark"]) {
    test(`axe ${route} (${theme})`, async ({ page }, testInfo) => {
      await page.goto(route);
      if (route.includes("template=") || route.startsWith("/challenges/")) {
        await expect(page.getByRole("textbox", { name: "Design name" })).toBeVisible();
        await expect(page.locator(".react-flow")).toBeVisible();
        await expect(page.locator(".react-flow__node")).toHaveCount(6);
      } else {
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      }
      if (route === "/progress") await expect(page.getByRole("status").filter({ hasText: "Loading progress" })).toHaveCount(0);
      const toggle = page.getByRole("button", { name: /^Switch to .* theme$/ });
      await expect(toggle).toBeVisible();
      if (await page.locator("html").getAttribute("data-theme") !== theme) await toggle.click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.evaluate(() => document.fonts.ready);
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      await testInfo.attach("axe", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
      expect(result.violations).toEqual([]);
    });
  }
}
