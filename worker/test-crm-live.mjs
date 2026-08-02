/* Live check on the crm-list preview against the real API.
   Structure only — no screenshots and nothing about a real applicant is printed. */
import { chromium } from 'playwright-core';

/* the box has changed chromium build more than once — take whichever is installed */
const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });
const SITE = 'https://crm-list.clever-preview.pages.dev/team.html';
const S = { token: 'OTISVERIFY-CRM-31JUL-B', username: 'bf638793', name: 'Brent Ford', role: 'admin' };
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : ''))); };
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.evaluate(s => sessionStorage.setItem('cp_team_session', JSON.stringify(s)), S);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#shell.show', { timeout: 20000 });
ok('the portal loads on the preview', true);

await page.click('#tab-pending');
await page.waitForTimeout(1200);
const titles = (await page.locator('.sec-t').allInnerTexts()).map(t => t.toUpperCase());
ok('New Applications is in three sections', titles.length === 3, titles);
const counts = (await page.locator('.sec-n').allInnerTexts()).map(Number);
const pendingKpi = Number(await page.locator('#kpi-pending').innerText());
ok('the section counts add up to the pending total',
  counts.reduce((a, b) => a + b, 0) === pendingKpi, { counts, pendingKpi });
ok('the working tab still opens as cards', await page.locator('.app-card').count() === pendingKpi);

await page.click('#tab-approved');
await page.waitForSelector('table.crm', { timeout: 20000 });
const heads = await page.locator('.crm thead th').allInnerTexts();
ok('the record list carries 13 columns of record', heads.length === 15, heads.length);
ok('Clever Checked is one of them', heads.some(h => /CLEVER CHECKED/i.test(h)), heads);
ok('so is where they stand in the network', heads.some(h => /IN THE NETWORK/i.test(h)));
ok('every approved row shows a network state', await page.locator('.crm td.td-network').count() === await page.locator('.crm tr.r').count());
const sticky = await page.evaluate(() => {
  const w = document.querySelector('.crm-wrap');
  const a = document.querySelector('.crm tr.r td.stick1').getBoundingClientRect().left;
  w.scrollLeft = 500;
  return { scrolls: w.scrollWidth > w.clientWidth, moved: Math.abs(document.querySelector('.crm tr.r td.stick1').getBoundingClientRect().left - a) };
});
ok('the record scrolls sideways and the first column stays put', sticky.scrolls && sticky.moved < 2, sticky);
await page.click('.col-pick .vs-btn');
await page.waitForTimeout(300);
ok('the Columns button opens the picker', await page.locator('.col-menu').isVisible());
ok('with every column listed', await page.locator('.col-opt').count() === 20);
ok('no javascript errors anywhere in that', errs.length === 0, errs);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
