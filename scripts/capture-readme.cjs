#!/usr/bin/env node
"use strict";

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const baseUrl = process.env.RESTORK_DEMO_URL || "http://127.0.0.1:5173";
const localeArg = process.argv.find((value) => value.startsWith("--locale="));
const locale = localeArg?.split("=", 2)[1] === "zh-CN" ? "zh-CN" : "en";
const rehearse = process.argv.includes("--rehearse");
const discover = process.argv.includes("--discover");
const output = path.join(projectRoot, "build", "readme-frames", locale);

async function injectCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById("readme-demo-cursor")) return;
    const cursor = document.createElement("div");
    cursor.id = "readme-demo-cursor";
    cursor.innerHTML = `<svg width="25" height="25" viewBox="0 0 25 25" xmlns="http://www.w3.org/2000/svg"><path d="M4 3L20 13L13 14L10 22L4 3Z" fill="#F4FDFF" stroke="#07101D" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
    cursor.style.cssText = "position:fixed;left:48px;top:48px;width:25px;height:25px;z-index:999999;pointer-events:none;filter:drop-shadow(0 0 5px #27F3E5);";
    document.body.appendChild(cursor);
    document.addEventListener("mousemove", (event) => {
      cursor.style.left = `${event.clientX}px`;
      cursor.style.top = `${event.clientY}px`;
    });
  });
}

async function moveAndClick(page, locator, label) {
  const target = typeof locator === "string" ? page.locator(locator).first() : locator;
  if (!await target.isVisible().catch(() => false)) throw new Error(`missing ${label}`);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await page.waitForTimeout(250);
  await target.click();
  await page.waitForTimeout(700);
}

async function ensureVisible(page, selector, label) {
  const visible = await page.locator(selector).first().isVisible().catch(() => false);
  if (!visible) throw new Error(`REHEARSAL FAIL: ${label} (${selector})`);
  process.stdout.write(`REHEARSAL OK: ${label}\n`);
}

async function settle(page) {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(500);
}

async function shot(page, name) {
  await settle(page);
  await page.screenshot({ path: path.join(output, name), animations: "allow" });
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const url = `${baseUrl}/demo.html?theme=cyberpunk&locale=${encodeURIComponent(locale)}&startup=start`;
  await page.goto(url, { waitUntil: "networkidle" });
  await injectCursor(page);
  await settle(page);

  if (discover) {
    const fields = await page.evaluate(() => [...document.querySelectorAll("input,select,textarea,button,[contenteditable]")]
      .filter((element) => element.offsetParent !== null)
      .map((element) => ({ tag: element.tagName, name: element.getAttribute("name") || "", text: (element.textContent || "").trim().slice(0, 48), view: element.getAttribute("data-view") || "" })));
    process.stdout.write(`${JSON.stringify(fields, null, 2)}\n`);
    await browser.close();
    return;
  }

  for (const [selector, label] of [
    ['[data-view="radar"]', "Radar navigation"],
    ['[data-view="deliverables"]', "Deliverables navigation"],
    ['[data-view="runs"]', "Runs navigation"],
    ['[data-view="vault"]', "Knowledge navigation"],
  ]) await ensureVisible(page, selector, label);

  await moveAndClick(page, '[data-view="radar"]', "Radar navigation");
  await ensureVisible(page, '.radar-x-lane [data-radar-action="save_topic"]', "Save verified X topic");
  await moveAndClick(page, '[data-view="deliverables"]', "Deliverables navigation");
  await ensureVisible(page, '[data-x-draft="x-draft-demo"]', "X draft card");
  await ensureVisible(page, '[data-x-draft="x-draft-demo"] [data-x-publication-form]', "Manual publication record form");

  if (rehearse) {
    process.stdout.write("REHEARSAL PASSED\n");
    await browser.close();
    return;
  }

  await page.goto(url, { waitUntil: "networkidle" });
  await injectCursor(page);
  await shot(page, "00-start.png");

  await moveAndClick(page, '[data-view="radar"]', "Radar navigation");
  await page.locator(".radar-x-lane").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shot(page, "01-radar.png");
  await moveAndClick(page, '.radar-x-lane [data-radar-action="save_topic"]', "Save verified X topic");
  await page.locator(".radar-x-lane").scrollIntoViewIfNeeded();
  await shot(page, "02-topic-saved.png");

  await moveAndClick(page, '[data-view="deliverables"]', "Deliverables navigation");
  await shot(page, "03-drafts.png");
  const draft = page.locator('[data-x-draft="x-draft-demo"]');
  await draft.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await shot(page, "04-variants.png");
  const publication = draft.locator("[data-x-publication-form]").first();
  await moveAndClick(page, publication.locator('button[type="submit"]'), "Record as published");
  await shot(page, "05-recorded.png");

  await moveAndClick(page, '[data-view="runs"]', "Runs navigation");
  await moveAndClick(page, "[data-run-list] [data-run-id]", "First run record");
  await page.waitForTimeout(700);
  await shot(page, "06-run.png");
  await moveAndClick(page, '[data-subview="approvals"]', "Approvals subview");
  await shot(page, "07-approval.png");
  await moveAndClick(page, '[data-view="vault"]', "Knowledge navigation");
  await page.waitForTimeout(700);
  await shot(page, "08-vault.png");

  fs.copyFileSync(path.join(output, "01-radar.png"), path.join(output, "poster.png"));
  process.stdout.write(`Captured README flow in ${output}\n`);
  await browser.close();
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
