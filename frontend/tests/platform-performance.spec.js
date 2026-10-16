import fs from "node:fs";
import { expect, test } from "@playwright/test";

const file = process.env.PLATFORM_SESSION_FILE;
const fixture = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
test.skip(!fixture, "Start platform_performance_browser_server and the latency simulation");

async function enter(page, role, screen) {
  await page.addInitScript((session) => sessionStorage.setItem("cc_auth_session", JSON.stringify({
    ...session, issued_at: Date.now(), expires_at: Date.now() + 3600000,
  })), fixture.sessions[role]);
  await page.goto(`/${role}/${screen}`);
  await expect(page.locator("main h1")).toBeVisible();
}

for (const role of ["teacher", "event_manager"]) {
  test(`${role} dashboard returns six rows with complete KPI counts`, async ({ page }, testInfo) => {
    const urls = [];
    page.on("request", (request) => { if (request.url().includes("/events")) urls.push(request.url()); });
    const pending = page.waitForResponse((response) => response.url().includes("dashboard=true") && response.ok());
    await enter(page, role, "dashboard");
    const response = await pending;
    const body = await response.json();
    expect(body.events).toHaveLength(6);
    expect(body.dashboard.all).toBeGreaterThanOrEqual(120);
    expect(urls.every((url) => url.includes("dashboard=true") || url.includes("reminders=true"))).toBe(true);
    await testInfo.attach("dashboard-payload", { body: JSON.stringify({ bytes: (await response.body()).length, total: body.total, rows: body.count, urls }), contentType: "application/json" });
  });
  for (const width of [1440, 390]) {
    test(`${role} My Events pages merged rows and retains cross-page selection at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await enter(page, role, "my-events");
      await expect(page.getByLabel("Rows per page")).toBeEnabled();
      await expect(page.getByRole("checkbox", { name: /^Select Platform/ })).toHaveCount(25);
      await page.getByRole("checkbox", { name: /^Select Platform/ }).first().check();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.getByText(/^2 of \d+$/, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: /^Select Platform/ }).first()).toBeChecked();
      await page.getByLabel("Rows per page").selectOption("50");
      await expect(page.getByRole("checkbox", { name: /^Select Platform/ })).toHaveCount(50);
      await page.getByRole("textbox", { name: "Search events", exact: true }).fill("Platform");
      await expect(page.getByText(/^1 of \d+$/, { exact: true })).toBeVisible();
      await page.getByRole("checkbox", { name: "Select all matching events", exact: true }).check();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: /^Select Platform/ }).first()).toBeChecked();
    });
  }
}

test("Dean grouped events load bounded pages without the former 1000-row ceiling", async ({ page }) => {
  const pages = [];
  let failedAppend = false;
  await page.route("**/dean/events?*", (route) => {
    if (new URL(route.request().url()).searchParams.get("skip") === "100" && !failedAppend) {
      failedAppend = true;
      return route.fulfill({ status: 503, json: { detail: "Temporary page failure" } });
    }
    return route.continue();
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/dean/events" && response.request().resourceType() === "fetch" && response.request().method() === "GET" && response.ok()) pages.push({ limit: url.searchParams.get("limit"), skip: url.searchParams.get("skip") });
  });
  await enter(page, "dean", "events");
  await expect(page.getByText(/^Showing 100 of \d+$/)).toBeVisible();
  await page.getByRole("button", { name: "Load more events", exact: true }).click();
  await expect(page.getByText("Temporary page failure", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Showing 100 of \d+$/)).toBeVisible();
  await page.getByRole("button", { name: "Load more events", exact: true }).click();
  await expect(page.getByText(/^Showing 200 of \d+$/)).toBeVisible();
  await page.getByRole("button", { name: "Load more events", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load more events", exact: true })).toHaveCount(0);
  await expect.poll(() => pages.map((page) => page.limit)).toEqual(["100", "100", "100"]);
  expect(pages.map((page) => page.skip)).toEqual(["0", "100", "200"]);
  await page.getByRole("textbox", { name: "Search events by name, venue, type or teacher" }).fill("Platform teacher");
  await expect(page).toHaveURL(/q=Platform/);
  await expect.poll(() => pages.at(-1).skip).toBe("0");
});

for (const [screen, path, placeholder] of [
  ["users", "/superadmin/users", "Search by name or email"],
  ["audit-logs", "/superadmin/audit-logs", "Search actor, action, or the person or event affected"],
  ["events", "/dean/events", "Search event, venue, type or teacher"],
]) {
  test(`Super Admin ${screen} cancels slow old searches and keeps the latest result`, async ({ page }) => {
    await page.route(`**${path}?*`, (route) => route.continue({ url: `http://127.0.0.1:4909/latency${path}${new URL(route.request().url()).search}` }));
    await enter(page, "superadmin", screen);
    await expect(page.getByText("Fresh result", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    const slow = page.waitForRequest((req) => new URL(req.url()).searchParams.get("q") === "slow");
    await page.getByPlaceholder(placeholder).fill("slow");
    await slow;
    await page.getByPlaceholder(placeholder).fill("fresh");
    await expect(page).toHaveURL(/q=fresh/);
    await expect(page.getByText("Fresh result", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await page.waitForTimeout(1700);
    await expect(page.getByText("Old result", { exact: true })).toHaveCount(0);
  });
}

test("Bulk Onboard module loads only when requested", async ({ page }) => {
  const chunks = [];
  page.on("request", (request) => { if (request.url().includes("BulkTeacherOnboardModal")) chunks.push(request.url()); });
  await enter(page, "superadmin", "users");
  await expect(page.getByRole("button", { name: "Bulk Onboard", exact: true })).toBeVisible();
  expect(chunks).toHaveLength(0);
  await page.getByRole("button", { name: "Bulk Onboard", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => chunks.length).toBe(1);
});

test("off-screen video previews defer requests while the active viewer loads immediately", async ({ page }) => {
  await enter(page, "event_manager", `events/${fixture.video_event}`);
  const last = page.locator("main video").last();
  await expect(page.locator("main video")).toHaveCount(100);
  await expect(last).not.toHaveAttribute("src");
  await last.scrollIntoViewIfNeeded();
  await expect(last).toHaveAttribute("src", /clip\.mp4/);
  await page.getByRole("button", { name: /^Play video 100 of 100/ }).click();
  await expect(page.getByRole("dialog").locator("video[controls]")).toHaveAttribute("src", /clip\.mp4/);
});
