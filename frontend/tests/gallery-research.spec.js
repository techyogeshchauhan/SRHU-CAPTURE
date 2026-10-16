import { expect, test } from "@playwright/test";

// Opt in only against tests.gallery_research_browser_server, never a shared API.
const API = process.env.GALLERY_RESEARCH_TEST_API;
test.skip(API !== "http://127.0.0.1:8765", "Start the isolated Gallery/Research browser fixture first.");
test.describe.configure({ mode: "serial" });
test.use({ channel: "chromium" });

async function signIn(page, request, email) {
  const response = await request.post(`${API}/auth/login`, {
    data: { email, password: "Browser-test-only-123!" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const data = await response.json();
  await page.addInitScript((session) => {
    sessionStorage.setItem("cc_auth_session", JSON.stringify({
      access_token: session.access_token,
      user: session.user,
      issued_at: Date.now(),
      expires_at: Date.now() + session.expires_in * 1000,
    }));
  }, data);
  return { Authorization: `Bearer ${data.access_token}` };
}

test.afterEach(async ({ page }, testInfo) => {
  const path = testInfo.outputPath("browser.png");
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach("browser", { path, contentType: "image/png" });
});

for (const width of [1440, 390]) {
  test(`Gallery albums, viewer and navigation at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, request, "dean@srhu.edu.in");
    await page.goto("/dean/gallery");
    const cards = page.getByRole("button", { name: /^Open album:/ });
    await expect(cards).toHaveCount(2);
    await cards.first().click();
    const album = page.getByRole("dialog", { name: "Gallery browser workshop", exact: true });
    await expect(album).toBeVisible();
    await expect(album.getByRole("button", { name: /^View image/ })).toHaveCount(2);
    await expect(album.getByRole("heading", { name: /^Videos/ })).toHaveCount(0);
    const box = await album.boundingBox();
    expect(box.width).toBeGreaterThan(width * 0.75);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: testInfo.outputPath("album.png") });
    await album.getByRole("button", { name: /^View image 1/ }).click();
    await expect(page.getByRole("dialog", { name: /image 1 of 2$/ })).toBeVisible();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Zoom out", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("viewer.png") });
    const albumUrl = page.url();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog", { name: /image 2 of 2$/ })).toBeVisible();
    await expect(page).toHaveURL(albumUrl);
    await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close viewer", exact: true }).click();
    await expect(album).toBeVisible();
    await album.getByRole("button", { name: "Next album", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Gallery browser seminar", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).not.toHaveURL(/album=/);
    await page.getByRole("tab", { name: /^Videos/ }).click();
    await expect(page).toHaveURL(/media=video/);
    await expect(cards).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("tab", { name: /^Videos/ })).toHaveAttribute("aria-selected", "true");
    await expect(cards).toHaveCount(0);
    await page.getByRole("button", { name: "Clear filters", exact: true }).first().click();
    await expect(cards).toHaveCount(2);
  });
}

for (const [role, width] of [["teacher", 1440], ["event_manager", 1440], ["event_manager", 390]]) {
  test(`${role} Research create, edit and submit at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const manager = role === "event_manager";
    const headers = await signIn(page, request, manager ? "vishal@srhu.edu.in" : "meera@srhu.edu.in");
    const title = `Browser patent ${role} ${width}`;
    await page.goto(`/${role}/research/new`);
    await page.getByRole("radio", { name: /^Patent/ }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    if (manager) {
      await page.getByRole("combobox", { name: /Faculty Name/ }).fill("Meera");
      await page.getByRole("option", { name: /Meera Joshi/ }).click();
    }
    await page.getByLabel(/^Title of the invention/).fill(title);
    await page.getByLabel(/^Filing date/).fill("01/10/2026");
    await page.getByLabel(/^Inventors/).fill("Meera Joshi");
    await page.getByLabel(/^Patent office/).selectOption("India (IPO)");
    await page.getByLabel(/^Application number/).fill(`BROWSER-${role}-${width}`);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${role}/research/[a-f0-9]{24}$`));
    const id = new URL(page.url()).pathname.split("/").pop();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Edit", exact: true }).click();
    await expect(page.getByLabel(/^Title of the invention/)).toHaveValue(title);
    await expect(page.getByLabel(/^Filing date/)).toHaveValue("01/10/2026");
    await page.getByLabel(/^Title of the invention/).fill(`${title} updated`);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("heading", { name: `${title} updated`, exact: true })).toBeVisible();
    const saved = await request.get(`${API}/research/records/${id}`, { headers });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).record.record_date).toBe("2026-10-01");
    await page.getByRole("button", { name: manager ? "Record" : "Submit for verification", exact: true }).click();
    await expect(page.getByText(manager ? "Recorded in the research portfolio." : "Sent to the Dean for verification.", { exact: false })).toBeVisible();
    const submitted = (await (await request.get(`${API}/research/records/${id}`, { headers })).json()).record;
    expect(submitted.verification_status).toBe(manager ? "verified" : "submitted");
    if (manager) {
      await page.getByRole("link", { name: "Update", exact: true }).click();
      await page.getByLabel(/^Title of the invention/).fill(`${title} accepted update`);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(page.getByRole("heading", { name: `${title} accepted update`, exact: true })).toBeVisible();
      const updated = (await (await request.get(`${API}/research/records/${id}`, { headers })).json()).record;
      expect(updated.verification_status).toBe("verified");
    }
  });
}

test("Gallery/Research reject anonymous and wrong-role access", async ({ page, request }) => {
  for (const path of ["/dean/gallery", "/research/records", "/dean/research/records"]) {
    expect((await request.get(`${API}${path}`)).status()).toBe(401);
  }
  await page.goto("/dean/gallery");
  await expect(page).toHaveURL(/\/login$/);
  const headers = await signIn(page, request, "arjun@srhu.edu.in");
  expect((await request.get(`${API}/dean/gallery`, { headers })).status()).toBe(403);
  expect((await request.get(`${API}/dean/research/records`, { headers })).status()).toBe(403);
  await page.goto("/dean/gallery");
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  const own = await request.get(`${API}/research/records`, { headers });
  expect(own.status()).toBe(200);
  expect((await own.json()).records).toHaveLength(0);
});

test("Dean can read manager submissions and focused category records", async ({ page, request }) => {
  await signIn(page, request, "dean@srhu.edu.in");
  await page.goto("/dean/research");
  await expect(page.getByRole("link", { name: /Browser patent event_manager 1440 accepted update/ })).toBeVisible();
  await page.goto("/dean/research/category/patent");
  await expect(page.getByRole("link", { name: /Browser patent event_manager 390 accepted update/ })).toBeVisible();
  await expect(page.getByText("Browser patent teacher 1440 updated", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: /Browser patent event_manager 1440 accepted update/ }).click();
  await expect(page.getByRole("heading", { name: "Browser patent event_manager 1440 accepted update", exact: true })).toBeVisible();
});
