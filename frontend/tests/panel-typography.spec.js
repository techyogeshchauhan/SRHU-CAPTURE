import { expect, test } from "@playwright/test";

const eventTitle = "National Level Hackathon — Hackathon 2.0 (2026), a 30-hour national innovation programme";
const researchTitle = "A reusable research system for sustainable innovation across university laboratories";
const faculty = { id: "faculty-layout", name: "Dr. Sample Faculty", email: "faculty@example.test", role: "teacher", phone: "9876543210", department: "SST", designation: "Assistant Professor", email_verified: true, is_active: true, onboarding_status: "active", event_count: 1 };
const event = {
  id: "event-layout", event_name: eventTitle, event_type: "Workshop", status: "pending",
  event_date: "2026-10-01", end_date: "2026-10-01", start_time: "10:00", end_time: "11:00",
  location: "University seminar hall", organizer: faculty.name, department: "SST",
  contact_info: faculty.phone, expected_participants: 125, participant_count: 125,
  description: "A programme for university research and collaboration.",
  teacher_id: faculty.id, teacher_name: faculty.name, teacher_email: faculty.email,
  owner_id: "manager-layout", owner_name: "Event Manager", created_at: "2026-10-01T09:00:00Z",
  submitted_at: "2026-10-01T09:00:00Z", history: [], report_photo_ids: [],
};
const category = {
  key: "patent", label: "Patent", short: "Patent", title_label: "Title of the invention",
  date_label: "Filing date", description: "Patents filed, published or granted.",
  outcomes: [{ key: "filed", label: "Filed" }, { key: "published", label: "Published" }],
  fields: [
    { key: "inventors", label: "Inventors", type: "textarea", required: true },
    { key: "office", label: "Patent office", type: "select", required: true, options: ["India (IPO)", "PCT / WIPO"] },
    { key: "application_number", label: "Application number", type: "text", required: true },
  ], evidence_tags: ["Filing receipt", "Other"], closed_outcomes: [],
};
const record = {
  id: "research-layout", title: researchTitle, category: "patent", category_label: "Patent",
  faculty_id: faculty.id, faculty, created_by: "manager-layout", created_by_name: "Event Manager",
  created_by_role: "event_manager", record_date: "2026-10-01", academic_year: "2026-27",
  outcome_status: "filed", verification_status: "verified", recorded_by_manager: true,
  verified_by: { id: "manager-layout", name: "Event Manager", role: "event_manager" },
  details: { inventors: faculty.name, office: "India (IPO)", application_number: "LAYOUT-2026-001" },
  permissions: { can_edit: true, can_submit: false, can_delete: true }, evidence: [], duplicates: [],
  history: [], reminders: [], created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T09:00:00Z",
};
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#244b65"/></svg>');

async function fixtures(page, role, theme = "light") {
  const user = { ...faculty, id: `${role}-layout`, role, name: role === "dean" ? "Dean" : role === "event_manager" ? "Event Manager" : "Sample User", must_change_password: false };
  await page.addInitScript(({ user, theme }) => {
    sessionStorage.setItem("cc_auth_session", JSON.stringify({ access_token: "typography-fixture", issued_at: Date.now(), expires_at: Date.now() + 3600000, user }));
    localStorage.setItem("campus-capture-theme", theme);
  }, { user, theme });
  // All application traffic stays in the browser fixtures; no shared API writes.
  await page.route("**/*", async (route) => {
    if (!["fetch", "xhr"].includes(route.request().resourceType())) return route.continue();
    const path = new URL(route.request().url()).pathname;
    let json;
    if (path === "/auth/me" || path === "/users/me") json = { user };
    else if (path === "/notifications") json = { notifications: [], unread: 0 };
    else if (path === "/event-types") json = { event_types: ["Workshop"] };
    else if (path === "/faculty/coordinators") json = { coordinators: [] };
    else if (path.endsWith("/upload-limits")) json = { limits: { photos_required: false, documents_required: false, videos_required: false } };
    else if (path === "/dean/dashboard/stats") json = { total_events: 1, pending_events: 1, approved_events: 0, rejected_events: 0 };
    else if (path === "/dean/teachers") json = { teachers: [faculty], total: 1, counts: { all: 1, active: 1 }, onboarding_counts: { active: 1 }, email_configured: false };
    else if (path === "/dean/teachers/activity") json = { activity: [] };
    else if (path === "/dean/gallery") json = { groups: [{ event, photos: 1, videos: 0, cover: { id: "photo", media_url: image } }], total: 1, totals: { events: 1, photos: 1, videos: 0 } };
    else if (path.endsWith("/events/event-layout/media")) json = { media: [{ id: "photo", media_type: "image", media_url: image, file_name: "layout.svg" }] };
    else if (path.endsWith("/events/event-layout/documents")) json = { documents: [] };
    else if (path.endsWith("/events/event-layout/report-status")) json = { report_generated: false };
    else if (path.endsWith("/events/event-layout")) json = { event, media: [], documents: [] };
    else if (path.endsWith("/events")) json = { events: [event], total: 1, counts: { all: 1, pending: 1, approved: 0, rejected: 0 } };
    else if (path === "/research/categories") json = { categories: [category], limits: { evidence_required: false, max_evidence_files: 5, max_evidence_total_bytes: 10485760 } };
    else if (path === "/research/faculty") json = { faculty: [faculty] };
    else if (path.endsWith("/research/records/research-layout")) json = { record };
    else if (path.endsWith("/research/records")) json = { records: [record], total: 1, counts: { all: 1, verified: 1 }, academic_years: ["2026-27"] };
    else if (path.endsWith("/research/overview")) json = { total: 1, faculty_count: 1, by_category: { patent: 1 }, patents: { filed: 1 } };
    else if (path === "/research/duplicates") json = { duplicates: [] };
    else if (path === "/research/outcomes-due") json = { records: [] };
    else if (path === "/research/reminders/check") json = { sent: 0 };
    else return route.fulfill({ status: 404, json: { detail: `Missing UI fixture: ${path}` } });
    return route.fulfill({ json });
  });
}

const screens = [
  ["dean", "dashboard"], ["dean", "events"], ["dean", "archive"], ["dean", "gallery"],
  ["dean", "events/event-layout"], ["dean", "research"], ["dean", "research/category/patent"],
  ["dean", "research/research-layout"], ["dean", "teachers"], ["dean", "profile"],
  ["event_manager", "dashboard"], ["event_manager", "create-event"], ["event_manager", "my-events"],
  ["event_manager", "events/event-layout"], ["event_manager", "profile"], ["event_manager", "research"],
  ["event_manager", "research/category/patent"], ["event_manager", "research/new"],
  ["event_manager", "research/research-layout"], ["event_manager", "research/research-layout/edit"],
];

for (const width of [1440, 390]) {
  for (const [role, screen] of screens) {
    test(`${role}/${screen} typography at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await fixtures(page, role);
      await page.goto(`/${role}/${screen}`);
      await expect(page.locator(".panel-typography")).toBeVisible();
      await expect(page.locator("main h1")).toBeVisible();
      if (screen === "research/new") {
        await page.getByRole("radio", { name: /^Patent/ }).click();
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(page.getByLabel(/^Title of the invention/)).toBeVisible();
      }
      const type = await page.locator("main h1").evaluate((el) => {
        const s = getComputedStyle(el);
        return { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeight };
      });
      expect(type.family).toContain("Sora");
      expect(type.size).toBe(width >= 640 ? "24px" : "20px");
      expect(type.weight).toBe("600");
      expect(parseFloat(type.lineHeight)).toBeCloseTo((width >= 640 ? 24 : 20) * 1.35, 1);
      const base = await page.locator(".panel-typography").evaluate((el) => ({ family: getComputedStyle(el).fontFamily, size: getComputedStyle(el).fontSize }));
      expect(base.family).toContain("Inter");
      expect(base.size).toBe("14px");
      const labels = await page.locator(".field > label").evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
      expect(labels.every((size) => size === "14px")).toBe(true);
      for (const [selector, size] of [["main h2", "18px"], ["main h3", "16px"], ["main th", "12px"], ["main td", "14px"]]) {
        const sizes = await page.locator(selector).evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
        expect(sizes, selector).toEqual(sizes.map(() => size));
      }
      const controls = await page.locator("main .input").evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
      expect(controls.every((size) => size === (width >= 640 ? "14px" : "16px"))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
      const screenshot = testInfo.outputPath("page.png");
      await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
      await testInfo.attach("page", { path: screenshot, contentType: "image/png" });
    });
  }
}

for (const width of [1440, 390]) {
  test(`Gallery album and viewer retain navigation at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixtures(page, "dean");
    await page.goto("/dean/gallery");
    await page.getByRole("button", { name: /^Open album:/ }).click();
    const album = page.getByRole("dialog", { name: eventTitle, exact: true });
    await expect(album).toBeVisible();
    await expect(album.locator("h2").first()).toHaveCSS("font-size", "18px");
    await page.screenshot({ path: testInfo.outputPath("album.png"), animations: "disabled" });
    await album.getByRole("button", { name: /^View image 1/ }).click();
    const viewer = page.getByRole("dialog", { name: /image 1 of 1$/ });
    await expect(viewer).toBeVisible();
    await viewer.getByRole("button", { name: "Close viewer", exact: true }).click();
    await expect(album).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

for (const role of ["dean", "event_manager"]) {
  for (const theme of ["light", "dark"]) {
    test(`${role} portalled dialogs share typography in ${theme} theme`, async ({ page }, testInfo) => {
      await fixtures(page, role, theme);
      await page.goto(`/${role}/profile`);
      await expect(page.locator("main h1")).toBeVisible();
      if (theme === "dark") await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.getByRole("button", { name: "Edit profile", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Inter");
      expect(await dialog.locator("h2").evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Sora");
      expect(await dialog.locator("h2").evaluate((el) => getComputedStyle(el).fontSize)).toBe("18px");
      await page.screenshot({ path: testInfo.outputPath("profile-modal.png"), animations: "disabled" });
      await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    });
  }
}

for (const role of ["teacher", "superadmin"]) {
  test(`${role} retains its existing typography`, async ({ page }) => {
    await fixtures(page, role);
    await page.goto(`/${role}/profile`);
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator(".panel-typography")).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--panel-text-body"))).toBe("");
  });
}
