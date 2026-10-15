import { expect, test } from "@playwright/test";

const departmentName =
  "Computer Science and Engineering, School of Science and Technology";
const title = "Campus workshop on artificial intelligence and engineering";
const dean = { id: "dean-layout", name: "Dean", email: "dean@example.test", role: "dean" };
const baseEvent = {
  event_date: "2026-10-02",
  end_date: "2026-10-02",
  event_type: "Workshop",
  status: "completed",
  teacher_name: "Test Teacher",
  teacher_email: "teacher@example.test",
  location: "Seminar Hall",
  start_time: "10:00",
  end_time: "11:00",
  organizer: "Faculty Coordinator",
  participant_count: 125,
  created_at: "2026-10-02T09:00:00Z",
  submitted_at: "2026-10-02T09:00:00Z",
};
const events = [
  { ...baseEvent, id: "explicit", event_name: title, department: "SST", description: "Workshop overview" },
  {
    ...baseEvent,
    id: "legacy",
    event_name: "Legacy metadata workshop",
    status: "recorded",
    description: 'Workshop overview\n<!--CC_METADATA:{"department":"SST","expectedParticipants":"125"}-->',
  },
  { ...baseEvent, id: "default", event_name: "Default department workshop", status: "pending", description: "Workshop overview" },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript((user) => {
    const now = Date.now();
    const profile = window.location.pathname.startsWith("/event_manager/")
      ? { ...user, id: "manager-layout", role: "event_manager" }
      : user;
    sessionStorage.setItem("cc_auth_session", JSON.stringify({
      access_token: "department-layout-test-token",
      issued_at: now,
      expires_at: now + 3_600_000,
      user: profile,
    }));
  }, dean);

  // Exercise the real screens with API-shaped fixtures, without reading or
  // writing a shared database. Unknown fetches fail so missing fixtures surface.
  await page.route("**/*", async (route) => {
    if (!["fetch", "xhr"].includes(route.request().resourceType())) return route.continue();
    const path = new URL(route.request().url()).pathname;
    let json;
    if (path === "/auth/me") json = { user: dean };
    else if (path === "/event-types") json = { event_types: ["Workshop"] };
    else if (path === "/notifications") json = { notifications: [] };
    else if (path === "/dean/dashboard/stats") {
      json = { total_events: 3, pending_events: 1, approved_events: 2, rejected_events: 0 };
    } else if (path === "/dean/events") {
      json = { events, total: events.length, counts: { all: 3, pending: 1, approved: 2, rejected: 0 } };
    } else if (path === "/dean/archive/events") {
      json = { events: [events[0]], total: 1 };
    } else if (path.endsWith("/report-status")) json = { report_generated: false };
    else if (path.endsWith("/media")) json = { media: [] };
    else if (path.endsWith("/documents")) json = { documents: [] };
    else if (path.endsWith("/report/download")) {
      return route.fulfill({
        contentType: "application/pdf",
        headers: { "Content-Disposition": 'attachment; filename="workshop.pdf"' },
        body: "%PDF-1.4\n%%EOF",
      });
    } else if (/^\/dean\/events\/[^/]+$/.test(path)) {
      const event = events.find((item) => item.id === path.split("/").pop());
      json = { event };
    } else return route.abort();
    return route.fulfill({ json });
  });
});

async function readableWithinViewport(locator, page) {
  await expect(locator).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const box = await locator.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  expect(await locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

async function separated(first, second) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 ||
    a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1).toBe(true);
}

for (const width of [1440, 1024, 390, 320]) {
  test(`monthly event departments and controls remain readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/dean/events");
    await page.getByRole("button", { name: "2026", exact: true }).click();

    for (const event of events) {
      const row = page.getByRole("checkbox", { name: `Select submission ${event.event_name}`, exact: true }).locator("..");
      const department = row.getByText(`Workshop · ${departmentName}`, { exact: true });
      const eventTitle = row.getByRole("button", { name: event.event_name, exact: true });
      const participants = row.getByText("No. of Participants: 125", { exact: true });
      const report = row.getByRole("button", { name: `Download report for ${event.event_name}`, exact: true });
      const menu = row.getByRole("button", { name: `More actions for ${event.event_name}`, exact: true });
      await expect(eventTitle).toBeVisible();
      const titleBox = await eventTitle.boundingBox();
      expect(titleBox.width).toBeGreaterThan(80);
      expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(width);
      for (const control of [department, participants, report, menu]) {
        await readableWithinViewport(control, page);
      }
      for (const control of [eventTitle, participants, report, menu]) await separated(department, control);
      await separated(participants, report);
      await separated(report, menu);
    }
    await expect(page.locator("main")).not.toContainText(/\bSST\b/);
    await page.screenshot({ path: testInfo.outputPath(`monthly-${width}.png`), fullPage: true });

    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(page.getByText(departmentName, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`expanded-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: `More actions for ${title}`, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "View details" })).toBeVisible();
    await page.keyboard.press("Escape");

    const download = page.waitForEvent("download");
    const row = page.getByRole("checkbox", { name: `Select submission ${title}`, exact: true }).locator("..");
    await row.getByRole("button", { name: `Download report for ${title}`, exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);

    await page.getByRole("button", { name: "Status", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: `Select submission ${title}`, exact: true })
      .locator("..").getByText(`Workshop · ${departmentName}`, { exact: true })).toBeVisible();
  });
}

for (const width of [1440, 390]) {
  test(`full event information and archive show the resolved department at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/dean/events/default");
    await expect(page.getByRole("heading", { name: "Default department workshop", exact: true })).toBeVisible();
    const department = page.locator("dl > div").filter({ has: page.locator("dt", { hasText: /^Department$/ }) }).locator("dd");
    await expect(department).toHaveText(departmentName);
    await expect(page.getByText(departmentName, { exact: true })).toHaveCount(1);
    await expect(page.locator("dl > div").filter({ has: page.locator("dt", { hasText: /^(Dates?|Time)$/ }) })
      .filter({ hasText: departmentName })).toHaveCount(0);
    await readableWithinViewport(department, page);
    await expect(page.locator("main")).not.toContainText(/\bSST\b/);
    await page.screenshot({ path: testInfo.outputPath(`details-${width}.png`), fullPage: true });

    await page.goto("/dean/archive");
    const archiveDepartment = page.getByText(departmentName, { exact: true }).filter({ visible: true });
    await readableWithinViewport(archiveDepartment, page);
    await expect(page.getByRole("button", { name: "Restore", exact: true }).filter({ visible: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`archive-${width}.png`), fullPage: true });
  });

  test(`dashboard review queue resolves legacy department metadata at ${width}px`, async ({ page }, testInfo) => {
    await page.route("**/dean/events", (route) => route.fulfill({ json: {
      events: [{ ...events[1], status: "pending" }], total: 1,
    } }));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/dean/dashboard");
    await page.getByRole("tab", { name: /Submissions/ }).click();
    const department = page.getByText(`Workshop · ${departmentName}`, { exact: true });
    await readableWithinViewport(department, page);
    await expect(page.locator("main")).not.toContainText(/\bSST\b/);
    await page.screenshot({ path: testInfo.outputPath(`dashboard-${width}.png`), fullPage: true });
  });

  test(`event manager shows a dedicated Department item at ${width}px`, async ({ page }, testInfo) => {
    const manager = { ...dean, id: "manager-layout", role: "event_manager" };
    await page.route("**/auth/me", (route) => route.fulfill({ json: { user: manager } }));
    await page.route("**/event-manager/events/legacy", (route) => route.fulfill({ json: {
      event: events[1], media: [], documents: [],
    } }));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/event_manager/events/legacy");
    const department = page.locator("dl > div")
      .filter({ has: page.locator("dt", { hasText: /^Department$/ }) }).locator("dd");
    await expect(department).toHaveText(departmentName);
    await readableWithinViewport(department, page);
    await expect(page.getByText(departmentName, { exact: true })).toHaveCount(1);
    await expect(page.locator("dl > div").filter({ has: page.locator("dt", { hasText: /^(Dates?|Timings)$/ }) })
      .filter({ hasText: departmentName })).toHaveCount(0);
    const label = await department.locator("..").locator("dt").boundingBox();
    const value = await department.boundingBox();
    expect(value.y).toBeGreaterThanOrEqual(label.y + label.height);
    await expect(page.getByRole("button", { name: "Download Report", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`event-manager-details-${width}.png`), fullPage: true });
  });
}
