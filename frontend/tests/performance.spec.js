import fs from "node:fs";
import { expect, test } from "@playwright/test";

const file = process.env.PERFORMANCE_SESSION_FILE;
const fixture = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
test.skip(!fixture, "Start tests.performance_browser_server with a temporary session file");

async function enter(page, path = "/dean/research", waitForRecords = true) {
  await page.addInitScript((session) => {
    sessionStorage.setItem("cc_auth_session", JSON.stringify({
      ...session, issued_at: Date.now(), expires_at: Date.now() + 3600000,
    }));
  }, fixture.sessions.dean);
  const requests = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("/dean/research/")) {
      requests.push(new URL(request.url()).pathname + new URL(request.url()).search);
    }
  });
  await page.goto(path);
  if (waitForRecords) await expect(page.getByLabel("Rows per page")).toBeEnabled();
  return requests;
}

test("pagination reuses the research overview while refreshing records", async ({ page }, testInfo) => {
  const requests = await enter(page);
  await expect(page.getByText("1 of 3", { exact: true })).toBeVisible();
  const initial = requests.filter((url) => url.includes("/overview")).length;
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.getByLabel("Rows per page").selectOption("50");
  await expect(page.getByText("1 of 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await testInfo.attach("requests", { body: JSON.stringify(requests, null, 2), contentType: "application/json" });
  expect(requests.filter((url) => url.includes("/overview"))).toHaveLength(initial);
  expect(requests.filter((url) => url.includes("/records"))).toHaveLength(3);
});

test("filter changes refresh the overview and typing stays debounced", async ({ page }) => {
  const requests = await enter(page);
  const initial = requests.filter((url) => url.includes("/overview")).length;
  const search = page.getByLabel("Search by title or teacher");
  await search.pressSequentially("Performance", { delay: 15 });
  await expect(page).toHaveURL(/q=Performance/);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await expect.poll(() => requests.filter((url) => url.includes("/overview")).length).toBe(initial + 1);
  await expect.poll(() => requests.filter((url) => url.includes("/records")).length).toBe(2);
});

test("a failed overview is retried and never cached as a successful result", async ({ page }) => {
  await page.route("**/dean/research/overview*", (route) => route.fulfill({ status: 503, json: { detail: "Overview temporarily unavailable." } }));
  await enter(page, "/dean/research", false);
  await expect(page.getByRole("alert")).toContainText("Overview temporarily unavailable.");
  await page.unroute("**/dean/research/overview*");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
});

test("deleting records on the last page refreshes both the list and overview", async ({ page }) => {
  const requests = await enter(page, "/dean/research?page=3");
  const initial = requests.filter((url) => url.includes("/overview")).length;
  await page.getByLabel("Select  records on this page").check();
  await page.getByRole("button", { name: /^Delete \d+ selected$/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Delete/ }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeEnabled();
  expect(requests.filter((url) => url.includes("/overview"))).toHaveLength(initial + 1);
});
