import fs from "node:fs";
import { expect, test } from "@playwright/test";

const fixtureFile = process.env.BUGFIX_SESSION_FILE;
const fixture = fixtureFile ? JSON.parse(fs.readFileSync(fixtureFile, "utf8")) : null;
const api = "http://127.0.0.1:8767";
test.skip(!fixture, "Start the isolated report_bugfix_browser_server first");

async function enter(page, role, path) {
  const session = fixture.sessions[role];
  const requests = [];
  const errors = [];
  page.on("request", (req) => requests.push(new URL(req.url()).pathname));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((session) => {
    sessionStorage.setItem("cc_auth_session", JSON.stringify({ ...session, issued_at: Date.now(), expires_at: Date.now() + 3600000 }));
  }, session);
  await page.goto(path);
  await expect(page.locator("main h1")).toBeVisible();
  return { requests, errors, headers: { Authorization: `Bearer ${session.access_token}` } };
}

async function openReport(page) {
  await page.getByRole("button", { name: /^Download Report$/i }).last().click();
  const modal = page.getByRole("dialog", { name: /^Customize (Event|Consolidated) Report/ });
  await expect(modal.getByRole("button", { name: "Generate PDF Report", exact: true })).toBeEnabled();
  return modal;
}

async function download(page, modal) {
  const finished = page.waitForEvent("download");
  await modal.getByRole("button", { name: "Generate PDF Report", exact: true }).click();
  const file = await finished;
  const buffer = fs.readFileSync(await file.path());
  expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  expect(buffer.subarray(-100).toString()).toContain("%%EOF");
  await expect(modal).toHaveCount(0);
}

test("teacher list, detail and uploads use registered authorized routes", async ({ page, request }) => {
  const key = fixture.events.teacher;
  const { requests, errors, headers } = await enter(page, "teacher", "/teacher/my-events");
  await expect(page.getByText("Bugfix teacher workshop", { exact: true }).last()).toBeVisible();
  for (const suffix of ["", `/${key}`, `/${key}/media`, `/${key}/documents`]) {
    const response = await request.get(`${api}/teacher/events${suffix}`, { headers });
    expect(response.status()).toBe(200);
  }
  await page.goto(`/teacher/events/${key}`);
  await expect(page.locator("main h1")).toContainText("Bugfix teacher workshop");
  expect(requests).toContain("/teacher/events");
  expect(errors).toEqual([]);
});

test("Event Manager bell never requests teacher-only events and backend still denies it", async ({ page, request }) => {
  const { requests, errors, headers } = await enter(page, "event_manager", "/event_manager/dashboard");
  await expect(page.getByText("Bugfix manager workshop", { exact: true }).last()).toBeVisible();
  expect(requests).toContain("/event-manager/events");
  expect(requests).not.toContain("/teacher/events");
  expect((await request.get(`${api}/teacher/events`, { headers })).status()).toBe(403);
  expect(errors).toEqual([]);
});

for (const [role, key] of [["event_manager", "manager"], ["dean", "teacher"], ["event_manager", "r2"]]) {
  test(`${role} ${key} downloads a real customized PDF with selected photographs`, async ({ page }) => {
    const panel = role === "dean" ? "dean" : "event_manager";
    const { errors } = await enter(page, role, `/${panel}/events/${fixture.events[key]}`);
    const modal = await openReport(page);
    await expect(modal.getByRole("checkbox", { name: "Photographs & Images", exact: true })).toBeChecked();
    await download(page, modal);
    await expect(page.getByRole("button", { name: /^Download Report$/i })).toBeEnabled();
    expect(errors).toEqual([]);
  });
}

for (const key of ["timeout", "drip"]) {
  test(`R2 ${key} fails with feedback, clears loading, and permits a real PDF retry`, async ({ page }) => {
    test.setTimeout(45000);
    await enter(page, "event_manager", `/event_manager/events/${fixture.events[key]}`);
    const modal = await openReport(page);
    await modal.getByRole("button", { name: "Generate PDF Report", exact: true }).click();
    await expect(modal.getByRole("alert")).toHaveText("Could not load report photos. Please try again.", { timeout: 35000 });
    await expect(modal.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
    await expect(modal.getByRole("button", { name: "Generate PDF Report", exact: true })).toBeEnabled();
    await modal.getByRole("checkbox", { name: "Photographs & Images", exact: true }).uncheck();
    await download(page, modal);
  });
}

test("large camera originals download successfully after the old photo deadline", async ({ page }) => {
  test.setTimeout(90000);
  await enter(page, "event_manager", `/event_manager/events/${fixture.events.large}`);
  const modal = await openReport(page);
  const started = Date.now();
  await download(page, modal);
  expect(Date.now() - started).toBeGreaterThan(20000);
  await expect(page.getByRole("button", { name: /^Download Report$/i })).toBeEnabled();
});

for (const [role, key] of [["event_manager", "manager"], ["dean", "teacher"]]) {
for (const fault of ["headers-hang", "body-hang", "proxy-error", "invalid"]) {
  test(`${role} ${fault} resets loading and retries through the real API`, async ({ page }, testInfo) => {
    const { errors } = await enter(page, role, `/${role}/events/${fixture.events[key]}`);
    if (fault.includes("hang")) await page.clock.install();
    const modal = await openReport(page);
    const pattern = role === "dean" ? "**/dean/events/*/report/download" : "**/event-manager/events/*/report";
    await page.route(pattern, (route) => route.continue({ url: `http://127.0.0.1:4907/storage/${fault}` }));
    const response = fault === "body-hang" ? page.waitForResponse((res) => res.url().includes("/body-hang") && res.status() === 200) : null;
    await modal.getByRole("button", { name: "Generate PDF Report", exact: true }).click();
    if (response) await response;
    if (fault.includes("hang")) {
      await expect(modal.getByRole("button", { name: /Generating PDF/ })).toBeVisible();
      await page.clock.fastForward(300100);
    }
    await expect(modal.getByRole("alert")).toContainText(fault.includes("hang") ? "Report download timed out" : fault === "invalid" ? "did not return a PDF" : "Could not generate the report");
    await expect(modal.getByRole("button", { name: "Generate PDF Report", exact: true })).toBeEnabled();
    await expect(modal.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("error-reset.png"), animations: "disabled" });
    await page.unroute(pattern);
    await download(page, modal);
    expect(errors).toEqual([]);
  });
}
}
