/* Eyes-on check of the documents section on the REAL team portal, after the deploy.
   Opens the Add account modal only, never submits, and clips every screenshot to the
   modal so no real applicant's details are captured. Nothing is written anywhere.
   Run: node worker/verify-add-docs-live.mjs */
import { chromium } from 'playwright-core';
import { statSync, mkdirSync, existsSync } from 'node:fs';

const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const SITE = 'https://clever.usehaf.co.uk/team.html';
const SHOTS = new URL('./_shots/', import.meta.url);
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function openPortal(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(SITE, { waitUntil: 'networkidle' });
  /* client-side gate only — the queue behind stays empty without a real session */
  await page.evaluate(() => sessionStorage.setItem('cp_team_session', JSON.stringify(
    { token: 'OTISVERIFY-ADDDOCS', username: 'bf638793', name: 'Brent Ford', role: 'admin' })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  return { ctx, page };
}

/* ── desktop ── */
console.log('\n── the live portal at 1280 ──');
let { ctx, page } = await openPortal(1280);

ok('the deployed page carries the rebuilt document section', await page.evaluate(() =>
  !!document.getElementById('add-doc-rows') && !!document.querySelector('style, link')));

await page.evaluate(() => openAdd());
await page.waitForTimeout(300);
ok('the Add account form opens', await page.locator('#add-ov.open').count() === 1);

await page.evaluate(() => toggleAddDocs());
await page.waitForTimeout(300);

const rows = await page.locator('#add-doc-rows .adr').count();
ok('the document list is live and populated', rows > 0, rows);

const style = await page.evaluate(() => {
  const px = (v) => parseFloat(v) || 0;
  const sec = getComputedStyle(document.querySelector('.add-docs'));
  const row = document.querySelector('.adr');
  const rs = row ? getComputedStyle(row) : null;
  const btn = document.querySelector('.adr-btn');
  const bs = btn ? getComputedStyle(btn) : null;
  const tog = getComputedStyle(document.getElementById('add-docs-toggle'));
  const wrap = document.getElementById('add-doc-rows');
  const ws = getComputedStyle(wrap);
  const modal = document.querySelector('#add-ov .modal');
  return {
    divider: px(sec.borderTopWidth), sectionTop: px(sec.paddingTop), sectionBottom: px(sec.marginBottom),
    rowBorder: rs ? px(rs.borderTopWidth) : 0, rowPadY: rs ? px(rs.paddingTop) : 0,
    rowRadius: rs ? px(rs.borderTopLeftRadius) : 0,
    gap: px(ws.rowGap), listMax: px(ws.maxHeight), listScrolls: wrap.scrollHeight > wrap.clientHeight + 1,
    btnBorder: bs ? px(bs.borderTopWidth) : 0, btnRadius: bs ? px(bs.borderTopLeftRadius) : 0,
    togBorder: px(tog.borderTopWidth),
    modalFits: modal.getBoundingClientRect().height <= window.innerHeight,
    submitVisible: (() => { const r = document.getElementById('add-submit').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight + 1; })(),
    overflowsRight: [...document.querySelectorAll('#add-doc-rows *')]
      .some(el => el.getBoundingClientRect().right > window.innerWidth),
  };
});
ok('there is a divider line above the section', style.divider > 0, style.divider);
ok('each document sits in its own outlined card', style.rowBorder > 0 && style.rowRadius > 0, style);
ok('the Attach buttons look like buttons', style.btnBorder > 0 && style.btnRadius > 0, style);
ok('the open/close control looks like a button', style.togBorder > 0, style.togBorder);
ok('the cards are evenly spaced', style.gap > 0, style.gap);
ok('the space above and below the section is balanced',
  Math.abs(style.sectionTop - style.sectionBottom) < 6, style);
ok('a long list scrolls inside the form instead of stretching it', style.listScrolls, style);
ok('the whole form still fits the screen', style.modalFits, style);
ok('Add account stays in view', style.submitVisible, style);
ok('nothing runs off the right edge', !style.overflowsRight);

await page.locator('#add-ov .modal').screenshot({ path: SHOTS.pathname + 'live-add-docs-1280.png' });

await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await page.waitForTimeout(200);
await page.locator('#add-ov .modal').screenshot({ path: SHOTS.pathname + 'live-add-docs-dark-1280.png' });
ok('it holds up in dark mode too', await page.evaluate(() =>
  parseFloat(getComputedStyle(document.querySelector('.adr')).borderTopWidth) > 0));

/* the forwarder list is a different set of paperwork */
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; setAddType('freight'); });
await page.waitForTimeout(250);
await page.evaluate(() => { const r = document.getElementById('add-doc-rows');
  if (r.style.display === 'none') toggleAddDocs(); });
await page.waitForTimeout(250);
const fRows = await page.locator('#add-doc-rows .adr').count();
ok('a freight forwarder gets its own company paperwork list', fRows > 0, fRows);
await page.locator('#add-ov .modal').screenshot({ path: SHOTS.pathname + 'live-add-docs-freight-1280.png' });
await ctx.close();

/* ── phone ── */
console.log('\n── the live portal at 390 ──');
({ ctx, page } = await openPortal(390));
await page.evaluate(() => { openAdd(); toggleAddDocs(); });
await page.waitForTimeout(400);
const m = await page.evaluate(() => {
  const row = document.querySelector('.adr');
  const btn = document.querySelector('.adr-btn').getBoundingClientRect();
  return {
    rows: document.querySelectorAll('.adr').length,
    wrapped: getComputedStyle(row).flexWrap === 'wrap',
    btnW: btn.width, btnH: btn.height, btnRight: btn.right,
    overflows: [...document.querySelectorAll('#add-ov *')]
      .some(el => el.getBoundingClientRect().right > window.innerWidth + 1),
  };
});
ok('the list is there on a phone', m.rows > 0, m.rows);
ok('each card stacks instead of squashing', m.wrapped, m);
ok('the Attach button is still a proper tap target', m.btnH >= 22 && m.btnW >= 48, m);
ok('nothing runs off the side of a phone screen', !m.overflows, m);
await page.locator('#add-ov .modal').screenshot({ path: SHOTS.pathname + 'live-add-docs-390.png' });
await ctx.close();

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
