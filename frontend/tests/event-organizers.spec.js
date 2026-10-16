import fs from "node:fs";
import { expect, test } from "@playwright/test";

const file = process.env.ORGANIZER_SESSION_FILE;
const fixture = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
const api = "http://127.0.0.1:8767";
test.skip(!fixture, "Start the isolated organizer_browser_server fixture");

async function signIn(page, role = "event_manager") {
  const session = fixture.sessions[role];
  await page.addInitScript((session) => sessionStorage.setItem("cc_auth_session", JSON.stringify({
    ...session, issued_at: Date.now(), expires_at: Date.now() + 3600000,
  })), session);
  return { Authorization: `Bearer ${session.access_token}` };
}

async function add(page, name, directory = true) {
  await page.getByRole("combobox", { name: /Organizer \/ Faculty Coordinator/ }).fill(name);
  if (directory) await page.getByRole("option", { name: new RegExp(name) }).click();
  else await page.getByRole("button", { name: "Add organizer", exact: true }).click();
  await expect(page.getByRole("list", { name: "Selected organizers" }).getByText(name, { exact: true })).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`create, reload and edit multiple organizers at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const headers = await signIn(page);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/event_manager/create-event");
    await page.locator("#eventName").fill(`Organizer browser ${width}`);
    await page.getByLabel(/^Event Type/).selectOption("Seminar");
    await page.locator("#eventDate").fill("01-10-2026");
    await page.locator("#eventDate").blur();
    await page.locator("#endDate").fill("01-10-2026");
    await page.locator("#endDate").blur();
    await page.locator("#startTime-hour").fill("10");
    await page.locator("#startTime-minute").fill("00");
    await page.locator("#startTime-period").selectOption("AM");
    await page.locator("#endTime-hour").fill("11");
    await page.locator("#endTime-minute").fill("00");
    await page.locator("#endTime-period").selectOption("AM");
    await page.locator("#location").fill("Organizer test hall");
    await page.locator("#description").fill("A browser organizer workflow validation.");
    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(page.getByText("Please enter the organizer or faculty coordinator name.", { exact: true })).toBeVisible();
    await add(page, "Dr. Rao");
    await expect(page.locator("#contactInfo")).toHaveValue("9876543210");
    await page.locator("#contactInfo").fill("9123456789");
    await add(page, "Dr. Verma");
    await add(page, "Guest Organizer", false);
    await expect(page.locator("#contactInfo")).toHaveValue("9123456789");
    const saved = page.waitForResponse((res) => res.url().endsWith("/event-manager/events") && res.request().method() === "POST");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    const event = (await response.json()).event;
    expect(event.organizers).toEqual(["Dr. Rao", "Dr. Verma", "Guest Organizer"]);
    await page.goto(`/event_manager/create-event?editEventId=${event.id}`);
    await expect(page.getByRole("list", { name: "Selected organizers" }).getByRole("listitem")).toHaveCount(3);
    await page.getByRole("button", { name: "Remove organizer Dr. Rao", exact: true }).click();
    const patched = page.waitForResponse((res) => res.url().endsWith(`/event-manager/events/${event.id}`) && res.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    expect((await patched).status()).toBe(200);
    const detail = await request.get(`${api}/event-manager/events/${event.id}`, { headers });
    expect((await detail.json()).event.organizers).toEqual(["Dr. Verma", "Guest Organizer"]);
    await page.goto(`/event_manager/events/${event.id}`);
    await expect(page.getByText("Dr. Verma; Guest Organizer", { exact: true }).last()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("organizers.png") });
    expect(errors).toEqual([]);
  });
}

test("legacy single organizer opens as one selection and can become multiple", async ({ page, request }) => {
  const headers = await signIn(page);
  const event = { id: fixture.events.legacy };
  await page.goto(`/event_manager/create-event?editEventId=${event.id}`);
  await expect(page.getByRole("list", { name: "Selected organizers" }).getByText("Legacy Organizer", { exact: true })).toBeVisible();
  await add(page, "Dr. Rao");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${api}/event-manager/events/${event.id}`, { headers })).json()).event.organizers).toEqual(["Legacy Organizer", "Dr. Rao"]);
});

for (const role of ["event_manager", "dean"]) {
  test(`${role} displays all organizers and downloads their customized PDF`, async ({ page }, testInfo) => {
    await signIn(page, role);
    await page.goto(`/${role}/events/${fixture.events.organizers}`);
    await expect(page.getByText("Dr. Rao; Dr. Verma; Guest Organizer", { exact: true }).last()).toBeVisible();
    await page.getByRole("button", { name: /^Download Report$/i }).last().click();
    const modal = page.getByRole("dialog", { name: /^Customize Event Report/ });
    await expect(modal.getByRole("button", { name: "Generate PDF Report", exact: true })).toBeEnabled();
    const pending = page.waitForEvent("download");
    await modal.getByRole("button", { name: "Generate PDF Report", exact: true }).click();
    const file = await pending;
    await file.saveAs(testInfo.outputPath(`${role}-organizers.pdf`));
    await expect(modal).toHaveCount(0);
  });
}

test("removing every organizer enforces the minimum and guest directory saving still works", async ({ page }) => {
  await signIn(page);
  await page.goto("/event_manager/create-event");
  await page.locator("#organizer").fill("New Faculty Coordinator");
  await page.locator("#contactInfo").fill("9123456789");
  await page.getByRole("button", { name: '+ Save "New Faculty Coordinator" to the directory', exact: true }).click();
  await expect(page.getByRole("list", { name: "Selected organizers" }).getByText("New Faculty Coordinator", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove organizer New Faculty Coordinator", exact: true }).click();
  await page.getByRole("button", { name: /^Next/ }).click();
  await expect(page.getByText("Please enter the organizer or faculty coordinator name.", { exact: true })).toBeVisible();
});

test("Teacher form keeps its existing single-organizer input", async ({ page }) => {
  await signIn(page, "teacher");
  await page.goto("/teacher/create-event");
  await page.getByRole("combobox", { name: /Organizer \/ Faculty Coordinator/ }).fill("Teacher Coordinator");
  await expect(page.getByRole("combobox", { name: /Organizer \/ Faculty Coordinator/ })).toHaveValue("Teacher Coordinator");
  await expect(page.getByRole("list", { name: "Selected organizers" })).toHaveCount(0);
});
