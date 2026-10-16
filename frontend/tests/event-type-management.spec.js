import fs from "node:fs";
import { expect, test } from "@playwright/test";

// Opt in with a session created ONLY in a disposable local test database.
const sessionFile = process.env.EVENT_TYPE_TEST_SESSION;
const api = process.env.EVENT_TYPE_TEST_API || "http://127.0.0.1:8766";
const session = sessionFile ? JSON.parse(fs.readFileSync(sessionFile, "utf8").replace(/^\uFEFF/, "")) : null;
test.skip(!session, "Requires EVENT_TYPE_TEST_SESSION for an isolated local test account");

async function setup(page, request, theme = "light") {
  const headers = { Authorization: `Bearer ${session.access_token}` };
  const name = `Browser type ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  expect((await request.post(`${api}/event-types`, { headers, data: { name } })).status()).toBe(201);
  const response = await request.post(`${api}/event-manager/events`, { headers, data: {
    event_name: "Type management test", event_date: "2026-01-01", event_type: name,
    location: "Test hall", organizer: "Test Manager", coordinator_contact: "9876543210",
    start_time: "10:00", end_time: "11:00", save_as_draft: true,
  } });
  expect(response.status()).toBe(201);
  const event = (await response.json()).event;
  await page.addInitScript(({ session, theme }) => {
    sessionStorage.setItem("cc_auth_session", JSON.stringify({ ...session, issued_at: Date.now(), expires_at: Date.now() + 3600000 }));
    localStorage.setItem("campus-capture-theme", theme);
  }, { session, theme });
  await page.goto("/event_manager/create-event");
  await page.getByLabel(/^Event Type/).selectOption(name);
  await page.getByRole("button", { name: "Manage event types", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Manage event types", exact: true });
  await expect(modal.getByRole("button", { name: `Edit ${name}`, exact: true })).toBeVisible();
  return { name, event, headers, modal };
}

for (const [width, theme, destination] of [[1440, "light", "Workshop"], [390, "light", "Uncategorized"], [1440, "dark", "Uncategorized"], [390, "dark", "Workshop"]]) {
  test(`rename and safely delete event type at ${width}px in ${theme} to ${destination}`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { name, event, headers, modal } = await setup(page, request, theme);
    await expect(modal.getByRole("button", { name: "Edit Workshop", exact: true })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Edit Other owner type", exact: true })).toHaveCount(0);
    await modal.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
    const editing = page.getByRole("dialog", { name: "Edit event type", exact: true });
    const renamed = name.replace("Browser type", "Updated type");
    await editing.getByLabel("Event type name").fill(renamed);
    await editing.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(modal.getByRole("status").filter({ hasText: "Event type updated" })).toBeVisible();
    await expect(page.getByLabel(/^Event Type/)).toHaveValue(renamed);
    const afterRename = await request.get(`${api}/event-manager/events/${event.id}`, { headers });
    expect((await afterRename.json()).event.event_type).toBe(renamed);

    await modal.getByRole("button", { name: `Delete ${renamed}`, exact: true }).click();
    const deleting = page.getByRole("dialog", { name: "Delete event type", exact: true });
    await expect(deleting.getByText(/1 associated event/)).toBeVisible();
    const confirm = deleting.getByRole("button", { name: "Move events and delete type", exact: true });
    await expect(confirm).toBeDisabled();
    await deleting.getByLabel(/^Move associated events to/).selectOption({ label: destination });
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("delete-confirmation.png"), animations: "disabled" });
    const overflow = await deleting.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
    // Back is cancellation: the catalog and event must still use the source.
    await deleting.getByRole("button", { name: "Back", exact: true }).click();
    await expect(modal.getByRole("button", { name: `Delete ${renamed}`, exact: true })).toBeVisible();
    await modal.getByRole("button", { name: `Delete ${renamed}`, exact: true }).click();
    await expect(deleting.getByText(/1 associated event/)).toBeVisible();
    await expect(confirm).toBeDisabled();
    await deleting.getByLabel(/^Move associated events to/).selectOption({ label: destination });
    await confirm.click();
    await expect(modal.getByRole("status").filter({ hasText: `1 event(s) moved to ${destination}` })).toBeVisible();
    await expect(page.getByLabel(/^Event Type/)).toHaveValue(destination);
    const afterDelete = await request.get(`${api}/event-manager/events/${event.id}`, { headers });
    const savedEvent = (await afterDelete.json()).event;
    expect(savedEvent.event_type).toBe(destination);
    expect(savedEvent.status).toBe("draft");
    expect(savedEvent.event_name).toBe(event.event_name);
    await modal.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByLabel(/^Event Type/).getByRole("option", { name: renamed, exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("duplicate name keeps edit modal open with backend validation feedback", async ({ page, request }) => {
  const { name, modal } = await setup(page, request);
  await modal.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const editing = page.getByRole("dialog", { name: "Edit event type", exact: true });
  await editing.getByLabel("Event type name").fill("Workshop");
  await editing.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editing.getByRole("alert")).toContainText("already exists");
  await expect(page.getByLabel(/^Event Type/)).toHaveValue(name);
});

test("failed deletion retains the type and displays retryable feedback", async ({ page, request }) => {
  const { name, modal, event, headers } = await setup(page, request);
  await modal.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  const deleting = page.getByRole("dialog", { name: "Delete event type", exact: true });
  await expect(deleting.getByText(/1 associated event/)).toBeVisible();
  await deleting.getByLabel(/^Move associated events to/).selectOption("uncategorized");
  await page.route("**/event-types/*", (route) => route.request().method() === "DELETE"
    ? route.fulfill({ status: 503, json: { detail: "No changes were saved. Please retry." } }) : route.continue());
  await deleting.getByRole("button", { name: "Move events and delete type", exact: true }).click();
  await expect(deleting.getByRole("alert")).toContainText("No changes were saved");
  const response = await request.get(`${api}/event-manager/events/${event.id}`, { headers });
  expect((await response.json()).event.event_type).toBe(name);
  await expect(deleting.getByRole("button", { name: "Move events and delete type", exact: true })).toBeEnabled();
});
