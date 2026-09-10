/* Live check on the real clever.usehaf.co.uk team portal, for the two things
   Brent asked for on 10 Sep: the arrivals board split by what an account IS,
   and the invoices-and-payments screen.

   Uses a short-lived verification session token (inserted and deleted by the
   caller) rather than anyone's PIN — never touches a pin_hash.

   PRIVACY: this prints headings, counts and money TOTALS only. It never prints
   or screenshots a row, because the queue holds real people's details. Same
   rule as verify-live.mjs. */
import { chromium } from 'playwright-core';
import { statSync } from 'node:fs';

const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const SITE = 'https://clever.usehaf.co.uk/team.html';
const SESSION = {
  token: process.env.CP_VERIFY_TOKEN,
  username: 'bf638793', name: 'Brent Ford', role: 'admin',
};

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.evaluate(s => sessionStorage.setItem('cp_team_session', JSON.stringify(s)), SESSION);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#tab-signedup', { timeout: 15000 });

/* ── the arrivals board ── */
console.log('\n── the arrivals board, live ──');
await page.click('#tab-signedup');
await page.waitForSelector('.qsec .sec-t', { timeout: 15000 });
const secs = await page.$$eval('.qsec', els => els.map(e => ({
  title: e.querySelector('.sec-t')?.textContent.trim(),
  count: Number(e.querySelector('.sec-n')?.textContent.trim()),
  rows: e.querySelectorAll('tr.r, .app-card').length,
})));
console.log('  sections: ' + JSON.stringify(secs.map(s => [s.title, s.count])));

const want = ['Driver accounts', 'Business accounts with drivers',
              'Limited companies', 'Business accounts without drivers'];
ok('the four sections are on the live board, in order',
   JSON.stringify(secs.map(s => s.title)) === JSON.stringify(want), secs.map(s => s.title));
for (const s of secs) ok(`"${s.title}" count matches the rows under it`, s.count === s.rows, s);

/* a section that is empty because nothing qualifies is a real answer, but a
   board where EVERY section is empty means the data never arrived */
ok('the board is not empty', secs.some(s => s.count > 0), secs.map(s => s.count));
ok('the Limited companies section is not vacuous',
   (secs.find(s => s.title === 'Limited companies') || {}).count > 0);

const boardCount = Number(await page.textContent('#tc-signedup'));
ok('the four sections add up to the tab count',
   secs.reduce((n, s) => n + s.count, 0) === boardCount,
   { sections: secs.map(s => s.count), tab: boardCount });

/* ── invoices and payments ── */
console.log('\n── invoices and payments, live ──');
await page.click('#tab-payments');
await page.waitForSelector('.paytiles .paytile', { timeout: 15000 });
const tiles = await page.$$eval('.paytile', els => els.map(e => ({
  label: e.querySelector('.pt-t')?.textContent.trim(),
  value: e.querySelector('.pt-v')?.textContent.trim(),
})));
console.log('  tiles: ' + JSON.stringify(tiles.map(t => [t.label, t.value])));

ok('the six totals are on the screen', tiles.length === 6, tiles.length);
const tile = l => (tiles.find(t => t.label === l) || {}).value;
ok('signed up is a real number', Number(tile('Signed up')) > 0, tile('Signed up'));
ok('on a plan is a real number', Number(tile('On a plan')) > 0, tile('On a plan'));

/* 🔴 This used to assert only "there is a £ sign, not a dash", which passed
   happily with every total reading £0 — a green check that proved nothing. The
   real question is whether the tile agrees with the records the portal itself
   is holding, so compute the answer from the queue in the page and compare. */
const expected = await page.evaluate(() => {
  const live = QUEUE.filter(a => !a.archived);
  const sum = k => live.reduce((n, a) => n + ((a.money || {})[k] || 0), 0);
  return {
    'Signed up': String(live.length),
    'On a plan': String(live.filter(a => (a.money || {}).plan).length),
    Paid: sum('paid_pence'), 'Awaiting payment': sum('awaiting_pence'),
    Invoiced: sum('invoiced_pence'), Outstanding: sum('outstanding_pence'),
    anyMoney: ['paid_pence', 'awaiting_pence', 'invoiced_pence', 'outstanding_pence']
      .some(k => sum(k) > 0),
  };
});
const asPence = v => Math.round(parseFloat(String(v).replace(/[^0-9.]/g, '') || '0') * 100);
for (const label of ['Paid', 'Awaiting payment', 'Invoiced', 'Outstanding'])
  ok(`${label} on screen is what the records add up to`,
     /£/.test(tile(label) || '') && asPence(tile(label)) === expected[label],
     { screen: tile(label), records: expected[label] });
ok('signed up on screen is what the records add up to',
   tile('Signed up') === expected['Signed up'], { screen: tile('Signed up'), records: expected['Signed up'] });

/* say so out loud rather than letting four £0 tiles read as proof of anything */
if (!expected.anyMoney) console.log('  NOTE  every money total is £0 — no live account has money '
  + 'attached right now, so this run proves the screen adds up, not that it can show a figure.');

const rows = await page.$$eval('.crm tr.r, table tr.r', els => els.length);
ok('the sign-ups are listed', rows > 0, rows);

const refreshed = await page.textContent('body');
ok('the screen says when the money side last refreshed', /refreshed|synced|updated/i.test(refreshed));

await ctx.close();
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
