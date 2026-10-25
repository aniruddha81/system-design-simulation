import { devices, expect, test } from "@playwright/test";

test.use({ ...devices["Pixel 5"] });

for (const route of ["/", "/learn", "/learn/building-blocks/caching", "/progress", "/account", "/sandbox", "/case-studies/url-shortener"]) {
  test(`no horizontal overflow on mobile: ${route}`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.ok()).toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (route === "/progress") await expect(page.getByRole("status").filter({ hasText: "Loading progress" })).toHaveCount(0);
    if (route === "/sandbox") await expect(page.getByText("No drafts yet.", { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  });
}
