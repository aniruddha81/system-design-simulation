import { expect, test } from "@playwright/test";

test("account changes reload into a separate workspace and never upload the previous account's data", async ({ page }) => {
  let account: string | null = "A";
  const uploads: { owner: string | undefined; keys: string[] }[] = [];
  await page.route("**/api/auth/get-session**", route => route.fulfill({ json: account ? { user: { id: account, name: `Learner ${account}`, email: `${account}@example.test`, emailVerified: true }, session: { id: `session-${account}`, userId: account, expiresAt: "2099-01-01T00:00:00.000Z" } } : null }));
  await page.route("**/api/auth/sign-out", async route => { account = null; await route.fulfill({ json: { success: true } }); });
  await page.route("**/api/sync**", async route => {
    const request = route.request();
    if (request.method() === "POST") {
      const records = request.postDataJSON().records as { key: string }[];
      uploads.push({ owner: request.headers()["x-sds-user"], keys: records.map(r => r.key) });
      await route.fulfill({ json: { accepted: records.length, rejected: [] } });
    } else await route.fulfill({ json: { records: [], cursor: 0, hasMore: false } });
  });
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Learner A", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))).toContain("sds-account:A");
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open("sds-account:A");
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction("progress", "readwrite");
        tx.objectStore("progress").put({ schemaVersion: 1, revision: 1, itemId: "private-A", kind: "lesson", mastery: 1 });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect.poll(() => uploads.some(u => u.owner === "A" && u.keys.includes("private-A"))).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sds-workspace-user"))).toBe("");
  account = "B";
  await page.reload();
  await expect(page.getByRole("heading", { name: "Learner B", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))).toContain("sds-account:B");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled();
  expect(uploads.filter(u => u.owner === "B").flatMap(u => u.keys)).not.toContain("private-A");
  const count = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const opening = indexedDB.open("sds-account:B");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("progress", "readonly");
      const count = tx.objectStore("progress").count();
      count.onsuccess = () => { resolve(count.result); db.close(); };
    };
  }));
  expect(count).toBe(0);
});
