import { expect, test, type Locator, type Page } from "@playwright/test";

// Solve the visible exercise independently of the app's solver and random seeds.
async function answerNumeric(group: Locator) {
  const prompt = await group.locator("form > p").innerText();
  const values = [...prompt.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(([n]) => Number(n.replaceAll(",", "")));
  let answer: number;
  if (prompt.startsWith("A service receives")) answer = values[0] * (1 - values[1] / 100);
  else if (prompt.startsWith("Peak load")) answer = (1 - values[1] / values[0]) * 100;
  else if (prompt.startsWith("Key popularity")) answer = (Math.log(values[2]) + 0.577) / (Math.log(values[1]) + 0.577) * 100;
  else if (prompt.startsWith("A hot key")) answer = Math.max(1, values[0] * values[1] / 1000);
  else throw new Error(`Unknown caching exercise: ${prompt}`);
  await group.getByRole("textbox", { name: /Your answer in/ }).fill(String(answer));
  await group.getByRole("button", { name: "Check", exact: true }).click();
  await expect(group.getByText("Correct", { exact: true })).toBeVisible();
}

test("complete every caching lesson step and retain completion after reload", async ({ page }) => {
  await page.goto("/learn/building-blocks/caching");
  const next = () => page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("slider", { name: "Cache hit rate", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await next();
  await answerNumeric(page.getByRole("group", { name: "Numeric question", exact: true }));
  await next();

  const ordering = page.getByRole("group", { name: "Ordering question" });
  const order = [
    "Service sends GET user:42 to the cache",
    "Cache replies that the key is missing",
    "Service reads user:42 from the database",
    "Service writes the row to the cache with a TTL",
    "Service returns the response to the caller",
  ];
  for (const [index, text] of order.entries()) {
    const row = ordering.getByRole("listitem").filter({ hasText: text });
    const position = await row.evaluate((el) => Array.from(el.parentElement!.children).indexOf(el));
    for (let i = position; i > index; i--) await row.getByRole("button", { name: `Move "${text}" up`, exact: true }).click();
  }
  await ordering.getByRole("button", { name: "Check order" }).click();
  await expect(ordering.getByText("Correct", { exact: true })).toBeVisible();
  await next();
  await answerNumeric(page.getByRole("group", { name: "Numeric question", exact: true }));
  await next();
  await answerNumeric(page.getByRole("group", { name: "Numeric question", exact: true }));
  await next();
  await page.getByRole("radio", { name: "Delete the key in the pricing service after each database write, and keep a TTL as a safety net" }).check();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await next();
  await answerNumeric(page.getByRole("group", { name: "Numeric question", exact: true }));
  await next();
  for (const name of ["Coalesce concurrent misses", "Add random jitter", "Pre-warm the hottest keys"]) {
    await page.getByRole("checkbox", { name: new RegExp(name) }).check();
  }
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await next();
  await page.getByRole("button", { name: "Start the check" }).click();
  const mastery = page.getByRole("group", { name: "Mastery check", exact: true });
  for (let i = 0; i < 5; i++) {
    await answerNumeric(mastery);
    await mastery.getByRole("button", { name: i === 4 ? "See result" : "Next question" }).click();
  }
  await expect(page.getByRole("group", { name: "Mastery check result" })).toContainText("Lesson mastered");
  await expect(page.getByText("Lesson complete. Progress saved on this device.", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Progress", exact: true }).click();
  await page.reload();
  const lesson = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Caching: cache-aside, eviction, stampede", exact: true }) });
  await expect(lesson).toContainText("9 of 9 steps");
  await expect(lesson).toContainText("Mastered");
});

async function dropCache(page: Page, service: string) {
  // HTML5 DnD needs DataTransfer; mouse-only dragTo does not populate the kind MIME.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const library = page.getByRole("region", { name: "Component library" });
  const cache = library.getByRole("button", { name: /^Cache\b/ });
  await cache.dispatchEvent("dragstart", { dataTransfer: transfer });
  const source = page.locator(`.react-flow__node[data-id="${service}"]`);
  const target = page.locator('.react-flow__node[data-id="db"]');
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  // The board hit-tests the straight segment between source-right and target-left.
  const point = { clientX: (a!.x + a!.width + b!.x) / 2, clientY: (a!.y + a!.height / 2 + b!.y + b!.height / 2) / 2 };
  const board = page.locator("[data-board]");
  await board.dispatchEvent("dragover", { dataTransfer: transfer, ...point });
  await board.dispatchEvent("drop", { dataTransfer: transfer, ...point });
  await cache.dispatchEvent("dragend", { dataTransfer: transfer });
  await transfer.dispose();
  await expect(page.getByRole("status").filter({ hasText: /2 routes rewritten/ })).toBeVisible();
  // Cache-aside retains the direct DB connection for misses and writes.
  await expect(page.locator(`.react-flow__edge[data-id="${service}-db"]`)).toHaveCount(1);
  await expect(page.locator(`.react-flow__edge[data-id="${service}-cache"]`)).toHaveCount(1);
}

test("insert caches on both service–DB edges, pass the challenge, and reload the stars", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/challenges/cache-aside-recovery");
  await expect(page.getByRole("textbox", { name: "Design name" })).toBeVisible();
  await dropCache(page, "svc1");
  await dropCache(page, "svc2");
  await page.getByRole("tab", { name: "Challenge", exact: true }).click();
  await page.getByRole("button", { name: "Submit for grading" }).click();
  const verdict = page.getByRole("region", { name: "Verdict" });
  await expect(verdict).toContainText("Passed", { timeout: 120_000 });
  const starLabel = await verdict.getByLabel(/\d of 3 stars/).getAttribute("aria-label");
  const stars = Number(starLabel?.[0]);
  expect(stars).toBeGreaterThan(0);
  await expect(verdict).toContainText("Progress saved.");
  await page.getByRole("link", { name: "Progress", exact: true }).click();
  await page.reload();
  const challenge = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Keep reads fast through a cache restart", exact: true }) });
  await expect(challenge).toContainText(`${"★".repeat(stars)} Passed`);
});
