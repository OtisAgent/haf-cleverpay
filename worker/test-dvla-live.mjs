/* Live check of the driving record check on the dvla-check preview, against the
   real API (worker version preview) and the real database.
   Structure only — nothing about a real applicant is printed or screenshotted. */
import { chromium } from 'playwright-core';
import { statSync } from 'node:fs';

const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const SITE = 'https://dvla-check.clever-preview.pages.dev/team.html';
const S = { token: 'OTISVERIFY-DVLA-3AUG', username: 'bf638793', name: 'Brent Ford', role: 'admin' };

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : ''))); };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function run(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(s => sessionStorage.setItem('cp_team_session', JSON.stringify(s)), S);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#shell.show', { timeout: 20000 });
  ok(`${width}: the portal loads on the preview`, true);

  /* the API it is actually talking to must be the version preview, not production */
  const api = await page.evaluate(() => CP_API);
  ok(`${width}: the page talks to the preview API`, /^https:\/\/48155cfe-cleverpay-api\./.test(api), api);

  await page.click('#tab-pending');
  await page.waitForTimeout(1500);
  const cards = await page.locator('.app-card').count();
  ok(`${width}: pending applications load from the live database`, cards > 0, cards);

  /* open the first driver record and look for the record-check block */
  const driver = page.locator('.app-card:has(.chip-driver)').first();
  const haveDriver = await driver.count() > 0;
  ok(`${width}: there is a driver application to look at`, haveDriver);
  if (haveDriver) {
    await driver.click();
    await page.waitForTimeout(1200);
    const html = await page.content();
    ok(`${width}: the record shows the driving record check`, /Driving record check/i.test(html));
    ok(`${width}: with the licence number`, /Licence number/i.test(html));
    ok(`${width}: with the DVLA check code`, /Check code/i.test(html));
    ok(`${width}: with the National Insurance number`, /National Insurance/i.test(html));
    ok(`${width}: and a one-click link to GOV.UK`, /gov\.uk\/view-driving-licence/i.test(html));
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    ok(`${width}: nothing spills off the side of the screen`, wide);
  }

  ok(`${width}: no javascript errors anywhere in that`, errs.length === 0, errs);
  await ctx.close();
}

await run(1280);
await run(390);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
