/**
 * Opens every page, clicks its main buttons, and writes screenshots to qa/.
 * Run with the UI up: npm run dev, then npm run qa:pages.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type ConsoleMessage, type Page } from "playwright";
import { ROOT_DIR } from "../server/src/config.ts";

const UI = `http://localhost:${process.env.UI_PORT ?? "5173"}`;
const OUT = resolve(ROOT_DIR, "qa");

type PageCheck = {
  page: string;
  buttons: string[];
  clicked: string[];
  consoleErrors: string[];
  uiError: string;
  shot: string;
};

const PAGES = [
  { tab: "Mission Control", file: "mission-control", clicks: ["Plan mission"] },
  { tab: "Providers & Honesty", file: "providers-honesty", clicks: ["Refresh"] },
  { tab: "Attack Lab", file: "attack-lab", clicks: ["Run all attacks"] },
  { tab: "Receipts", file: "receipts", clicks: ["Refresh"] },
  { tab: "Setup", file: "setup", clicks: ["Refresh"] },
] as const;

async function visibleButtons(page: Page): Promise<string[]> {
  return page.locator(".content button:visible").allInnerTexts();
}

/** The app shows "… <label>" while a request is in flight. */
async function settle(page: Page, timeout = 180000) {
  const busy = page.locator("p.lede", { hasText: /^…/ });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await busy.count()) === 0) return;
    await page.waitForTimeout(250);
  }
}

async function uiErrorText(page: Page): Promise<string> {
  const err = page.locator("p.err");
  if (await err.count()) return (await err.first().innerText()).trim();
  return "";
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const results: PageCheck[] = [];
  await page.goto(UI, { waitUntil: "networkidle" });

  for (const spec of PAGES) {
    const before = consoleErrors.length;
    await page.getByRole("button", { name: spec.tab }).click();
    await page.waitForTimeout(600);
    await settle(page);

    const buttons = await visibleButtons(page);
    const clicked: string[] = [];
    for (const label of spec.clicks) {
      const btn = page.getByRole("button", { name: label, exact: true });
      if ((await btn.count()) && (await btn.first().isEnabled())) {
        await btn.first().click();
        await settle(page);
        clicked.push(label);
      }
    }

    const shot = resolve(OUT, `${spec.file}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    results.push({
      page: spec.tab,
      buttons,
      clicked,
      consoleErrors: consoleErrors.slice(before),
      uiError: await uiErrorText(page),
      shot: `qa/${spec.file}.png`,
    });
  }

  // A goal other than the built-in demo needs the planner model, so this is
  // the path that must surface the server's error text verbatim.
  await page.getByRole("button", { name: "Mission Control" }).click();
  await page.waitForTimeout(400);
  await page.locator("#goal").fill("Research Tesla and write a short brief");
  await page.getByRole("button", { name: "Plan mission", exact: true }).click();
  await settle(page);
  const errorText = await uiErrorText(page);
  await page.screenshot({ path: resolve(OUT, "mission-control-error.png"), fullPage: true });

  await browser.close();

  for (const r of results) {
    console.log(`\n## ${r.page}`);
    console.log(`  screenshot : ${r.shot}`);
    console.log(`  buttons    : ${r.buttons.join(" | ") || "none"}`);
    console.log(`  clicked    : ${r.clicked.join(", ") || "none"}`);
    console.log(`  ui error   : ${r.uiError || "none"}`);
    console.log(`  console    : ${r.consoleErrors.join(" ; ") || "clean"}`);
  }

  console.log(`\n## Error surfacing`);
  console.log(`  screenshot : qa/mission-control-error.png`);
  console.log(`  ui error   : ${errorText || "none shown"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
