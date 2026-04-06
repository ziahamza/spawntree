import { chromium, test } from "@playwright/test";

test("repro add config modal", async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage();
  const logs = [];

  page.on("console", (msg) => logs.push(["console", msg.type(), msg.text()]));
  page.on("pageerror", (error) => logs.push(["pageerror", error.message]));
  page.on("requestfailed", (request) =>
    logs.push(["requestfailed", request.url(), request.failure()?.errorText]));

  await page.goto("http://127.0.0.1:2422/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  console.log("TITLE", await page.title());
  console.log("BODY", (await page.locator("body").innerText()).slice(0, 500));

  const repoLinks = page.getByRole("link", { name: /spawntree/i });
  console.log("REPO_LINKS", await repoLinks.count());
  await repoLinks.first().click();
  await page.waitForTimeout(1000);
  console.log("URL", page.url());

  const addConfigButtons = page.getByRole("button", { name: /Add Config/i });
  console.log("ADD_CONFIG_BUTTONS", await addConfigButtons.count());
  await addConfigButtons.first().click();
  await page.waitForTimeout(1500);

  const dialogs = page.locator('[role="dialog"]');
  console.log("DIALOGS", await dialogs.count());
  if (await dialogs.count()) {
    console.log("DIALOG_TEXT", (await dialogs.first().innerText()).slice(0, 1000));
  }

  console.log("LOGS", JSON.stringify(logs, null, 2));
  await browser.close();
});
