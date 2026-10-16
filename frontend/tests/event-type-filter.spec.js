import fs from "node:fs";
import { expect, test } from "@playwright/test";

// Real role handlers with disposable collections: platform_performance_browser_server.
const sessionFile = process.env.PLATFORM_SESSION_FILE;
const fixture = sessionFile ? JSON.parse(fs.readFileSync(sessionFile, "utf8")) : null;
test.skip(!fixture, "Start the isolated platform browser fixture first");

async function enter(page, role = "event_manager", query = "") {
  await page.addInitScript((session) => {
    sessionStorage.setItem("cc_auth_session", JSON.stringify({
      ...session, issued_at: Date.now(), expires_at: Date.now() + 3600000,
    }));
    localStorage.setItem(`cc_teacher_drafts_${session.user.id}`, JSON.stringify([
      { id: "draft_custom", event_name: "Local field visit", event_type: "R&D / Field Visit", event_date: "2026-10-01" },
      { id: "draft_legacy", eventName: "Legacy browser workshop", eventType: "Workshop", eventDate: "2026-10-01" },
      { id: "draft_untyped", event_name: "Draft without a type" },
    ]));
  }, fixture.sessions[role]);
  const reads = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/event-manager/events") reads.push(request.url());
  });
  await page.goto(`/${role}/my-events${query}`);
  await expect(page.getByText(new RegExp(`^\\d+ matching of ${role === "event_manager" ? 124 : 123} events$`))).toBeVisible();
  return reads;
}

for (const width of [1440, 390]) {
  test(`event type filters all pages and retains matching selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    const reads = await enter(page);
    const type = page.getByLabel("Filter by event type");
    await type.selectOption("Seminar");
    await expect(page.getByText("42 matching of 124 events", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^Select Platform/ })).toHaveCount(25);
    await page.getByRole("checkbox", { name: "Select all matching events", exact: true }).check();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();
    const rows = page.getByRole("checkbox", { name: /^Select Platform/ });
    await expect(rows).toHaveCount(17);
    for (const row of await rows.all()) await expect(row).toBeChecked();
    await type.selectOption("Community Outreach");
    await expect(page.getByText("1 of 2", { exact: true })).toBeVisible();
    await expect(page.getByText("36 matching of 124 events", { exact: true })).toBeVisible();
    const bounds = await type.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    expect(reads).toHaveLength(1);
  });

  test(`event type combines with status, date and search and clears at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    const reads = await enter(page);
    const type = page.getByLabel("Filter by event type");
    await type.selectOption("Seminar");
    await expect(page.getByText("42 matching of 124 events", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /^Approved/ }).click();
    await expect(type).toHaveValue("Seminar");
    await expect(page.getByText("14 matching of 124 events", { exact: true })).toBeVisible();
    await page.getByLabel("Filter by date range").selectOption("custom");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByLabel("From date", { exact: true }).fill("2026-10-01");
    await page.getByLabel("To date", { exact: true }).fill("2026-10-02");
    await expect(page.getByText("3 matching of 124 events", { exact: true })).toBeVisible();
    await page.getByLabel("Search events", { exact: true }).fill("Platform event_manager 008");
    await expect(page.getByText("1 matching of 124 events", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(type).toHaveValue("");
    await expect(page.getByText("124 matching of 124 events", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Filter by date range")).toHaveValue("all_time");
    expect(reads).toHaveLength(1);
  });
}

test("custom types and legacy drafts filter correctly and survive reload", async ({ page }) => {
  await enter(page, "event_manager", "?filter=draft&type=" + encodeURIComponent("R&D / Field Visit"));
  const type = page.getByLabel("Filter by event type");
  await expect(type).toHaveValue("R&D / Field Visit");
  await expect(page.getByText("1 matching of 124 events", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Local field visit", exact: true })).toBeVisible();
  await page.reload();
  await expect(type).toHaveValue("R&D / Field Visit");
  await expect(page.getByText("1 matching of 124 events", { exact: true })).toBeVisible();
  await type.selectOption("Workshop");
  await expect(page).toHaveURL(/filter=draft/);
  await expect(page.getByText("8 matching of 124 events", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Legacy browser workshop", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^All\s/ }).click();
  await expect(type).toHaveValue("Workshop");
  await expect(page.getByText("44 matching of 124 events", { exact: true })).toBeVisible();
});

test("an unavailable linked type has a clearable empty result", async ({ page }) => {
  await enter(page, "event_manager", "?type=Removed%20type");
  await expect(page.getByLabel("Filter by event type")).toHaveValue("Removed type");
  await expect(page.getByText("0 matching of 124 events", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).first().click();
  await expect(page.getByText("124 matching of 124 events", { exact: true })).toBeVisible();
});

test("Teacher My Events keeps its existing controls and ignores manager-only type links", async ({ page }) => {
  await enter(page, "teacher", "?type=Seminar");
  await expect(page.getByLabel("Filter by event type")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /^Select / }).filter({ visible: true })).toHaveCount(26);
});
