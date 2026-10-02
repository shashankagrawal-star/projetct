// Browser walkthrough of the whole workflow against a RUNNING, FRESH server (empty database).
//
//   npm i --no-save playwright-core
//   (DATABASE_PATH=/tmp/e2e.db PORT=8098 npm start) &
//   BASE=http://localhost:8098 CHROME_PATH="/path/to/chrome" node e2e/run.mjs
//
// Uses whichever engine the server is configured for (LLM or rule-based). Screenshots go to e2e/screenshots/.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const BASE = process.env.BASE ?? 'http://localhost:8080';
const out = process.env.OUT ?? new URL('./screenshots', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = async (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

await page.goto(BASE);
await page.waitForSelector('text=Next step');
await shot('01-overview-empty');

// ask the agent
await page.click('text=Mapping plan');
await page.click('button:has-text("Propose a mapping plan")');
await page.waitForSelector('text=Version 1', { timeout: 20000 });
await shot('02-plan-v1');

// answer blocking questions via "Accept" buttons on the Questions tab
await page.click('button[role=tab]:has-text("Questions")');
await page.waitForSelector('.q.open');
for (let i = 0; i < 8; i++) {
  const btn = page.locator('.q.open button:has-text("Accept")').first();
  if (!(await btn.count())) break;
  await btn.click();
  await page.waitForTimeout(400);
}
await shot('03-questions-answered');

// dry run
await page.click('button:has-text("Run dry run on v1")');
await page.waitForSelector('text=Dry run #1', { timeout: 15000 });
await shot('04-dry-run');
await page.click('button.chip-btn:has-text("INVALID_PHONE")');
await page.waitForTimeout(600);
await page.locator('tbody tr.clickable').first().click();
await shot('05-dry-run-evidence');

// approve
await page.goto(BASE + '/execution');
await page.waitForSelector('text=Approve v1');
await page.click('button:has-text("Approve v1")');
await page.check('input[type=checkbox]');
await shot('06-approve-modal');
await page.click('.modal button:has-text("Approve")');
await page.waitForSelector('text=v1 is approved');

// execute with failure injection
await page.waitForSelector('button:has-text("Start execution")');
await page.check('text=Demo: make the target fail after');
await page.click('button:has-text("Start execution")');
await page.click('.modal button:has-text("Execute")');
await page.waitForSelector('text=This execution stopped part-way', { timeout: 15000 });
await shot('07-execution-failed');
await page.click('button:has-text("Retry")');
await page.waitForSelector('text=Execution completed', { timeout: 15000 });
await page.waitForSelector('text=Reconciliation');
await shot('08-execution-completed');

// rollback
await page.click('button:has-text("Roll back…")');
await page.fill('.modal textarea', 'visual check rollback');
await page.click('.modal button:has-text("Roll back")');
await page.waitForSelector('text=Rolled back');
await shot('09-rolled-back');

await page.goto(BASE + '/history');
await page.waitForSelector('text=Audit log');
await shot('10-history');
await page.goto(BASE);
await page.waitForSelector('text=Next step');
await shot('11-overview-final');

console.log('console/page errors:', errors.length ? errors : 'none');
await browser.close();
