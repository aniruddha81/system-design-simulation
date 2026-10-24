import { expect, test } from "@playwright/test";

test("share link opens an identical, unsaved copy in a clean browser", async ({ page, browser }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/sandbox?template=cache-aside");
  await expect(page.getByRole("textbox", { name: "Design name" })).toBeVisible();
  await page.getByRole("textbox", { name: "Design name" }).fill("Share round trip");
  await expect(page.getByRole("status").filter({ hasText: /^\s*✓?\s*Saved$/ })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  const topology = await page.locator(".react-flow__node").allTextContents();
  const edges = await page.locator(".react-flow__edge").count();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:3100\/sandbox\/shared#d=.+/);
  const recipient = await browser.newContext();
  try {
    const copy = await recipient.newPage();
    await copy.goto(link);
    await expect(copy.getByRole("textbox", { name: "Design name" })).toHaveValue("Share round trip");
    await expect(copy.getByRole("status").filter({ hasText: "Shared copy" })).toContainText("not saved");
    await expect(copy.locator(".react-flow__node")).toHaveText(topology);
    await expect(copy.locator(".react-flow__edge")).toHaveCount(edges);
    await copy.getByRole("button", { name: "Save", exact: true }).click();
    await expect(copy).toHaveURL(/\/sandbox\/(?!shared)[^/#]+$/);
    await expect(copy.getByRole("status").filter({ hasText: /^\s*✓?\s*Saved$/ })).toBeVisible();
    await copy.reload();
    await expect(copy.getByRole("textbox", { name: "Design name" })).toHaveValue("Share round trip");
    await expect(copy.locator(".react-flow__node")).toHaveText(topology);
  } finally {
    await recipient.close();
  }
});

for (const hostile of [
  { name: "oversized", body: " ".repeat(2 * 1024 * 1024 + 1), error: /2 MB import limit/ },
  { name: "wrong types", body: JSON.stringify({ schemaVersion: 1, id: "hostile", name: "Hostile", nodes: "<script>alert(1)</script>", edges: [], endpoints: [] }), error: /Invalid design/ },
  { name: "newer version", body: JSON.stringify({ schemaVersion: 999 }), error: /newer schemaVersion.*Update the app/ },
]) {
  test(`reject a hostile import: ${hostile.name}`, async ({ page }) => {
    await page.goto("/sandbox");
    await expect(page.getByText("No drafts yet.", { exact: true })).toBeVisible();
    await page.getByLabel("Import a design file (.sds.json)", { exact: true }).setInputFiles({
      name: "hostile.sds.json", mimeType: "application/json", buffer: Buffer.from(hostile.body),
    });
    await expect(page.getByRole("alert")).toContainText(hostile.error);
    await expect(page).toHaveURL("/sandbox");
    await page.reload();
    await expect(page.getByText("No drafts yet.", { exact: true })).toBeVisible();
  });
}

test("blocked storage shows a persistent in-memory warning with export", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("Storage blocked", "SecurityError"); } });
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage blocked", "SecurityError"); } });
  });
  await page.goto("/sandbox?template=cache-aside");
  await expect(page.getByRole("textbox", { name: "Design name" })).toBeVisible();
  const warning = page.getByRole("alert").filter({ hasText: /progress will not be saved/i });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole("button", { name: /Export/i })).toBeVisible();
  await page.getByRole("link", { name: "Progress", exact: true }).click();
  await expect(warning).toBeVisible();
});

test("ten client navigations do not accumulate simulation workers", async ({ page }) => {
  await page.goto("/sandbox?template=cache-aside");
  await expect(page.getByRole("textbox", { name: "Design name" })).toBeVisible();
  const draftURL = page.url();
  await page.getByLabel("Speed", { exact: true }).selectOption("0.1");
  await page.getByRole("button", { name: /Run$/, exact: false }).click();
  await expect.poll(() => page.workers().length).toBe(1);
  // Playwright observes real worker creation/closure, without a production debug hook.
  let documentLoads = 0;
  page.on("load", () => documentLoads++);
  for (let i = 0; i < 10; i++) {
    await page.getByRole("link", { name: "Progress", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Progress", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(draftURL);
    await expect(page.getByRole("textbox", { name: "Design name" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Resume$/ })).toBeVisible();
    await page.getByRole("button", { name: /Resume$/ }).click();
    await expect.poll(() => page.workers().length).toBe(1);
  }
  expect(documentLoads, "Exercise Next Activity navigation, without document reloads").toBe(0);
});
