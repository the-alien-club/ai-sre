# Playbook: Playwright Recipes

Common patterns for the QA agent. We run headless Chromium by default; set
`PLAYWRIGHT_HEADLESS=false` and `--headed` only for local debugging.

## Project conventions

- Tests live under `tests/<service>/...` or `tests/regression/<service>/...`
- File naming: `<feature>.spec.ts`. One feature per file when possible.
- Always use `test.describe` to group; one top-level describe per file.
- Use `getByRole`, `getByLabel`, `getByTestId` — never raw CSS selectors unless
  there's no semantic alternative.
- Set `baseURL` via env var `PLAYWRIGHT_BASE_URL`; never hardcode hosts.

## Skeleton

```ts
import { test, expect } from "@playwright/test";

test.describe("checkout flow", () => {
  test("user can complete a purchase", async ({ page }) => {
    await page.goto("/products/example");
    await page.getByRole("button", { name: /add to cart/i }).click();
    await page.getByRole("link", { name: /cart/i }).click();
    await expect(page.getByText(/example product/i)).toBeVisible();

    await page.getByRole("button", { name: /checkout/i }).click();
    await page.getByLabel(/email/i).fill("test@example.com");
    await page.getByRole("button", { name: /place order/i }).click();

    await expect(page.getByText(/thank you/i)).toBeVisible({ timeout: 10_000 });
  });
});
```

## Auth

For flows that need a logged-in user, use Playwright's `storageState`:

```ts
// global-setup.ts (if needed)
import { chromium, expect } from "@playwright/test";

export default async function globalSetup() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL });
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(process.env.QA_TEST_EMAIL!);
  await page.getByLabel(/password/i).fill(process.env.QA_TEST_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.context().storageState({ path: "data/storage-state.json" });
  await browser.close();
}
```

Then in tests:
```ts
test.use({ storageState: "data/storage-state.json" });
```

## API testing without a browser

```ts
import { test, expect } from "@playwright/test";

test("backend health endpoint returns ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ status: "ok" });
});
```

## Waiting for things

- `expect(locator).toBeVisible({ timeout: N })` — preferred over `page.waitForSelector`
- `page.waitForResponse(url)` — when you need to assert on a network call
- Avoid `page.waitForTimeout(N)` — it's flake fuel. Wait on a real condition.

## Capturing artifacts on failure

Already configured in `playwright.config.ts`:
- `screenshot: "on"` — every test step gets a screenshot
- `video: "retain-on-failure"`
- `trace: "retain-on-failure"`

Artifacts land in `data/artifacts/test-results/<test-name>/`. The path of the
final failure screenshot is what you upload to Slack.

## Running selectively from a sub-agent

```bash
# Run a single spec
PLAYWRIGHT_BASE_URL="$DEV_BASE_URL" \
  npx playwright test tests/regression/checkout.spec.ts --reporter=json,list \
  --output=data/artifacts/run-$(date +%s) > /tmp/run.json

# Parse the JSON for failures
jq '.suites[].specs[] | select(.tests[].results[].status != "passed") | {title, file, error: .tests[0].results[0].error}' /tmp/run.json
```

## Common gotchas

- **Timezone-dependent assertions**: pin via `page.emulateTimezone("UTC")` or
  by mocking `Date`.
- **Animations**: set `reducedMotion: "reduce"` in `test.use({...})` or globally.
- **Toast/notifications race**: assert on the visible state AFTER the toast
  disappears, not on the toast itself, unless the toast IS the assertion.
- **Tenant isolation**: never share `storageState` across tenant tests; each
  tenant must use its own login.
