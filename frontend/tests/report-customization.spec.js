import { expect, test } from "@playwright/test";

const title = "Report customization workshop";
const baseEvent = { id: "report-one", event_name: title, event_type: "Workshop", status: "approved", event_date: "2026-10-01", location: "University auditorium", owner_id: "manager-test", owner_name: "Event Manager", teacher_id: "manager-test", teacher_name: "Event Manager", submitted_by_role: "event_manager", description: '<!--CC_METADATA:{"department":"SST"}-->', created_at: "2026-10-01T10:00:00Z", report_generated_at: "2026-10-01T11:00:00Z", report_photo_ids: [], history: [] };
const sectionNames = ["Event Details & Organization", "Date, Time & Venue", "Event Description & Objectives", "Participation & Social Links", "Photographs & Images", "Uploaded Notices", "Uploaded Attachments"];

async function setup(page, role, { status = "approved", secondStatus = status, requireApproval = true, uploads = false, photos = false, fail = false, complete = false, draft = false, mixed = false, theme = "light" } = {}) {
  const calls = [];
  const user = { id: role === "dean" ? "dean-test" : "manager-test", name: "Test Staff", role, email: "test@example.test", is_active: true, email_verified: true, must_change_password: false };
  const event = { ...baseEvent, status, ...(requireApproval ? { report_approval_required: true } : {}), ...(complete ? { description: 'Supplied description<!--CC_METADATA:{"expectedParticipants":"150"}-->', social_network_url: "https://example.test/post" } : {}), ...(draft ? { status: "draft" } : {}) };
  const second = { ...event, status: secondStatus, id: "report-two", event_name: "Second workshop", description: "Supplied description" };
  const events = mixed ? [event, second] : [event];
  const documents = uploads ? [{ id: "notice", file_name: "agenda.pdf", category: "notice", file_url: "/fixture.pdf", file_type: "application/pdf" }, { id: "report", file_name: "summary.pdf", category: "report", file_url: "/fixture.pdf", file_type: "application/pdf" }] : [];
  const media = photos ? [{ id: "photo", media_type: "image", file_name: "photo.svg", media_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3C/svg%3E" }] : [];
  if (photos) event.report_photo_ids = ["photo"];
  await page.addInitScript(({ user, theme }) => {
    sessionStorage.setItem("cc_auth_session", JSON.stringify({ access_token: "report-fixture", user, issued_at: Date.now(), expires_at: Date.now() + 3600000 }));
    localStorage.setItem("campus-capture-theme", theme);
  }, { user, theme });
  await page.route("**/*", async (route) => {
    if (!["fetch", "xhr"].includes(route.request().resourceType())) return route.continue();
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let json;
    if (/\/(report\/download|report|reports|generate-report)$/.test(path)) {
      calls.push({ path, method: req.method(), body: req.postDataJSON() });
      if (path.endsWith("/generate-report")) return route.fulfill({ json: { success: true, generated_at: "2026-10-01T12:00:00Z" } });
      return route.fulfill({ contentType: "application/pdf", headers: { "content-disposition": 'attachment; filename="customized.pdf"' }, body: "%PDF-1.4\n% selected report\n%%EOF" });
    }
    if (path === "/auth/me" || path === "/users/me") json = { user };
    else if (path === "/notifications") json = { notifications: [], unread: 0 };
    else if (path === "/event-types") json = { event_types: ["Workshop"] };
    else if (path.endsWith("/events")) json = { events, total: events.length, counts: { all: events.length, approved: events.length, recorded: events.length }, years: ["2026"] };
    else if (path.endsWith("/media")) json = { media };
    else if (path.endsWith("/documents")) json = { documents };
    else if (path.endsWith("/report-status")) json = { report_generated: true };
    else if (/\/events\/report-(one|two)$/.test(path)) {
      if (fail) return route.fulfill({ status: 503, json: { detail: "Report sections are temporarily unavailable" } });
      json = { event: path.endsWith("two") ? second : event, media, documents };
    }
    else return route.fulfill({ status: 404, json: { detail: `Missing fixture: ${path}` } });
    return route.fulfill({ json });
  });
  return calls;
}

async function openReport(page, role, screen, { bulk = false, drawer = false } = {}) {
  await page.goto(`/${role}/${screen}`);
  await expect(page.locator("main h1")).toBeVisible();
  if (role === "dean" && screen === "events") {
    await page.getByRole("button", { name: "2026", exact: true }).click();
    const month = page.getByRole("button", { name: /October 2026/i });
    if (await month.getAttribute("aria-expanded") === "false") await month.click();
    if (bulk) {
      await page.getByRole("checkbox", { name: "Select all submissions in year 2026", exact: true }).check();
      await page.getByRole("button", { name: /Download report$/, exact: false }).click();
    } else {
      if (drawer) await page.getByRole("button", { name: `Toggle full details for ${title}`, exact: true }).click();
      await page.getByRole("button", { name: `Download report for ${title}`, exact: true }).last().click();
    }
  } else if (role === "event_manager" && screen === "my-events") {
    if (bulk) {
      await page.getByRole("checkbox", { name: `Select ${title}`, exact: true }).check();
      await page.getByRole("button", { name: "Download Report", exact: true }).first().click();
    } else await page.getByRole("button", { name: "Download Report", exact: true }).last().click();
  } else await page.getByRole("button", { name: /^Download report$/i }).first().click();
  const modal = page.getByRole("dialog", { name: /^Customize (Event|Consolidated) Report/ });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("status")).toHaveCount(0);
  return modal;
}

const entryPoints = [["dean", "events"], ["dean", "events/report-one"], ["event_manager", "dashboard"], ["event_manager", "my-events"], ["event_manager", "events/report-one"]];
for (const width of [1440, 390]) {
  for (const [role, screen] of entryPoints) {
    test(`${role}/${screen} customizes before download at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const calls = await setup(page, role);
      const modal = await openReport(page, role, screen);
      expect(calls).toEqual([]);
      await expect(modal.getByRole("checkbox")).toHaveCount(7);
      for (const name of sectionNames.slice(2)) {
        const option = modal.getByRole("checkbox", { name, exact: true });
        await expect(option).toBeDisabled();
        await expect(option).not.toBeChecked();
        await expect(option.locator("..")).toBeVisible();
      }
      await modal.getByRole("button", { name: "Deselect All", exact: true }).click();
      await expect(modal.getByRole("button", { name: "Generate PDF Report" })).toBeDisabled();
      await modal.getByRole("button", { name: "Select All", exact: true }).click();
      await expect(modal.getByRole("checkbox", { name: sectionNames[2], exact: true })).not.toBeChecked();
      await modal.getByRole("checkbox", { name: sectionNames[1], exact: true }).uncheck();
      await page.screenshot({ path: testInfo.outputPath("customization.png"), animations: "disabled" });
      const download = page.waitForEvent("download");
      await modal.getByRole("button", { name: "Generate PDF Report" }).click();
      expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
      await expect(modal).toHaveCount(0);
      const request = calls.find((call) => !call.path.endsWith("/generate-report"));
      expect(request.method).toBe("POST");
      expect(request.body).toEqual({ include_basic_details: true, include_schedule_venue: false, include_description: false, include_other_info: false, include_photos: false, include_notices: false, include_reports: false, include_documents: false });
    });
  }
}

for (const role of ["dean", "event_manager"]) {
  test(`${role} bulk report customizes availability across events`, async ({ page }) => {
    const calls = await setup(page, role, { mixed: role === "dean" });
    const modal = await openReport(page, role, role === "dean" ? "events" : "my-events", { bulk: true });
    expect(calls).toHaveLength(0);
    if (role === "dean") await expect(modal.getByRole("checkbox", { name: sectionNames[2], exact: true })).toBeEnabled();
    await modal.getByRole("button", { name: "Generate PDF Report" }).click();
    await expect(modal).toHaveCount(0);
    expect(calls[0].body.event_ids).toHaveLength(role === "dean" ? 2 : 1);
    expect(calls[0].body.customization.include_notices).toBe(false);
  });

  test(`${role} available notices and attachments can be selected separately in dark theme`, async ({ page }, testInfo) => {
    const calls = await setup(page, role, { uploads: true, complete: true, theme: "dark" });
    const modal = await openReport(page, role, "events/report-one");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(modal.getByRole("checkbox", { name: "Photographs & Images", exact: true })).toBeDisabled();
    await modal.getByRole("button", { name: "Deselect All", exact: true }).click();
    await modal.getByRole("checkbox", { name: "Uploaded Notices", exact: true }).check();
    await page.screenshot({ path: testInfo.outputPath("dark-customization.png"), animations: "disabled" });
    await modal.getByRole("button", { name: "Generate PDF Report" }).click();
    await expect(modal).toHaveCount(0);
    const call = calls.find((item) => !item.path.endsWith("/generate-report"));
    expect(call.body.include_notices).toBe(true);
    expect(call.body.include_reports).toBe(false);
    expect(call.body.include_description).toBe(false);
    expect(call.body.include_documents).toBe(true);
  });

  test(`${role} failed availability load blocks generation and offers retry`, async ({ page }) => {
    const calls = await setup(page, role, { fail: true });
    const modal = await openReport(page, role, role === "dean" ? "events" : "my-events");
    await expect(modal.getByRole("alert")).toContainText("temporarily unavailable");
    await expect(modal.getByRole("button", { name: "Generate PDF Report" })).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    expect(calls).toHaveLength(0);
    await page.route("**/events/report-one", (route) => route.fulfill({ json: { event: baseEvent, media: [], documents: [] } }));
    await modal.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(modal.getByRole("checkbox", { name: sectionNames[0], exact: true })).toBeEnabled();
    await expect(modal.getByRole("alert")).toHaveCount(0);
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(calls).toHaveLength(0);
  });

  test(`${role} supplied photographs can be downloaded without other sections`, async ({ page }) => {
    const calls = await setup(page, role, { photos: true, complete: true, uploads: true });
    const modal = await openReport(page, role, "events/report-one");
    for (const name of sectionNames) await expect(modal.getByRole("checkbox", { name, exact: true })).toBeEnabled();
    await modal.getByRole("button", { name: "Deselect All", exact: true }).click();
    await modal.getByRole("checkbox", { name: "Photographs & Images", exact: true }).check();
    await modal.getByRole("button", { name: "Generate PDF Report" }).click();
    await expect(modal).toHaveCount(0);
    const call = calls.find((item) => !item.path.endsWith("/generate-report"));
    expect(call.body.include_photos).toBe(true);
    expect(call.body.include_basic_details).toBe(false);
    expect(call.body.include_reports).toBe(false);
  });
}

test("Dean expanded event drawer also opens customization first", async ({ page }) => {
  const calls = await setup(page, "dean");
  const modal = await openReport(page, "dean", "events", { drawer: true });
  expect(calls).toHaveLength(0);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(modal).toHaveCount(0);
});

test("Event Manager draft report safeguard is preserved", async ({ page }) => {
  const calls = await setup(page, "event_manager", { draft: true });
  await page.goto("/event_manager/my-events");
  await page.getByRole("checkbox", { name: `Select ${title}`, exact: true }).check();
  await expect(page.getByRole("button", { name: "Download Report", exact: true }).first()).toBeDisabled();
  await expect(page.locator("#selected-report-restriction")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(calls).toHaveLength(0);
});

for (const width of [1440, 390]) {
  for (const screen of ["dashboard", "my-events", "events/report-one"]) {
    for (const status of ["draft", "pending", "rejected", "revoked", "recorded"]) {
      test(`Event Manager ${screen} disables ${status} report at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 });
        const calls = await setup(page, "event_manager", { status });
        await page.goto(`/event_manager/${screen}`);
        const button = page.getByRole("button", { name: "Download Report", exact: true }).last();
        await expect(button).toBeVisible();
        await expect(button).toBeDisabled();
        await expect(button).toHaveText("Download Report");
        await expect(button).not.toHaveAttribute("title");
        await expect(button).not.toHaveAttribute("aria-describedby");
        await button.click({ force: true });
        await expect(page).toHaveURL(new RegExp(`/event_manager/${screen}$`));
        expect(calls).toHaveLength(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        if (status === "pending") await page.screenshot({ path: testInfo.outputPath("approval-required.png"), fullPage: true, animations: "disabled" });
      });
    }
  }
}

for (const status of ["pending", "draft", "revoked"]) {
  test(`Event Manager mixed selection containing ${status} cannot generate a partial report`, async ({ page }) => {
    const calls = await setup(page, "event_manager", { mixed: true, secondStatus: status });
    await page.goto("/event_manager/my-events");
    await page.getByRole("checkbox", { name: `Select ${title}`, exact: true }).check();
    await page.getByRole("checkbox", { name: "Select Second workshop", exact: true }).check();
    await expect(page.getByRole("button", { name: "Download Report", exact: true }).first()).toBeDisabled();
    await expect(page.locator("#selected-report-restriction")).toHaveCount(0);
    expect(calls).toHaveLength(0);
    await page.getByRole("checkbox", { name: "Select Second workshop", exact: true }).uncheck();
    await page.getByRole("button", { name: "Download Report", exact: true }).first().click();
    await expect(page.getByRole("dialog", { name: /^Customize Consolidated Report/ })).toBeVisible();
    expect(calls).toHaveLength(0);
  });
}

test("Event Manager customization rechecks a stale approval before enabling generation", async ({ page }) => {
  const calls = await setup(page, "event_manager");
  await page.route("**/events/report-one", (route) => route.fulfill({ json: { event: { ...baseEvent, status: "revoked" }, media: [], documents: [] } }));
  const modal = await openReport(page, "event_manager", "my-events");
  await expect(modal.getByRole("alert")).toContainText("Report unavailable.");
  await expect(modal.getByRole("button", { name: "Generate PDF Report" })).toBeDisabled();
  expect(calls).toHaveLength(0);
});

test("Approval withdrawn during customization blocks the download and further generation", async ({ page }) => {
  await setup(page, "event_manager");
  const modal = await openReport(page, "event_manager", "events/report-one");
  await page.route("**/events/report-one/report", (route) => route.fulfill({ status: 400, json: { detail: "Report unavailable." } }));
  await modal.getByRole("button", { name: "Generate PDF Report" }).click();
  await expect(modal.getByRole("alert")).toContainText("Report unavailable.");
  await expect(modal.getByRole("button", { name: "Generate PDF Report" })).toBeDisabled();
});

for (const status of ["completed", "published", "in_progress"]) {
  test(`Event Manager ${status} event retains customization and PDF download`, async ({ page }) => {
    const calls = await setup(page, "event_manager", { status });
    const modal = await openReport(page, "event_manager", "events/report-one");
    expect(calls).toHaveLength(0);
    const download = page.waitForEvent("download");
    await modal.getByRole("button", { name: "Generate PDF Report" }).click();
    await download;
    await expect(modal).toHaveCount(0);
    expect(calls[0].method).toBe("POST");
  });
}

for (const width of [1440, 390]) {
  for (const status of ["recorded", "approved"]) {
    for (const screen of ["dashboard", "my-events", "events/report-one"]) {
      test(`Existing ${status} Event Manager ${screen} retains report at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        const calls = await setup(page, "event_manager", { status, requireApproval: false });
        const modal = await openReport(page, "event_manager", screen);
        expect(calls).toHaveLength(0);
        const download = page.waitForEvent("download");
        await modal.getByRole("button", { name: "Generate PDF Report", exact: true }).click();
        await download;
        await expect(modal).toHaveCount(0);
        expect(calls[0].method).toBe("POST");
      });
    }
  }
}

test("existing recorded and approved events retain consolidated customization", async ({ page }) => {
  const calls = await setup(page, "event_manager", { status: "recorded", secondStatus: "approved", requireApproval: false, mixed: true });
  await page.goto("/event_manager/my-events");
  await page.getByRole("checkbox", { name: `Select ${title}`, exact: true }).check();
  await page.getByRole("checkbox", { name: "Select Second workshop", exact: true }).check();
  await page.getByRole("button", { name: "Download Report", exact: true }).first().click();
  const modal = page.getByRole("dialog", { name: /^Customize Consolidated Report/ });
  await expect(modal.getByRole("button", { name: "Generate PDF Report", exact: true })).toBeEnabled();
  await modal.getByRole("button", { name: "Generate PDF Report", exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(calls[0].body.event_ids).toEqual(["report-one", "report-two"]);
});
