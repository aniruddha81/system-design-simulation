import { expect, test } from "@playwright/test";

for (const invalid of ["email", "password"] as const) {
  test(`sign-in blocks invalid ${invalid} before sending credentials`, async ({ page }) => {
    let submissions = 0;
    await page.route("**/api/auth/sign-in/email", async (route) => {
      submissions++;
      await route.fulfill({ status: 500, json: { message: "Unexpected submission" } });
    });
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    const email = page.getByLabel("Email", { exact: true });
    const password = page.getByLabel("Password", { exact: true });
    await email.fill(invalid === "email" ? "bad-email" : "learner@example.test");
    await password.fill(invalid === "password" ? "short" : "long-enough-password");
    await page.locator("form").getByRole("button", { name: "Sign in", exact: true }).click();
    const input = invalid === "email" ? email : password;
    expect(await input.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(false);
    expect(await input.evaluate((element: HTMLInputElement) => element.validationMessage)).not.toBe("");
    await expect(input).toBeFocused();
    expect(submissions).toBe(0);
  });
}

test("forgot-password keeps confirmation neutral when the service is unavailable", async ({ page }) => {
  await page.route("**/api/auth/request-password-reset", (route) => route.fulfill({
    status: 503, json: { code: "UNAVAILABLE", message: "Service unavailable" },
  }));
  await page.goto("/account/forgot");
  await page.getByLabel("Email", { exact: true }).fill("learner@example.test");
  await page.getByRole("button", { name: "Send reset link", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "If an account matches that email, you will receive a reset link." })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
});
