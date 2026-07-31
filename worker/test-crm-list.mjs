/* Browser proof for the CRM list view on the team portal's Approved and All tabs.
   Serves the real portal files against the real worker module backed by a stub
   database seeded with 24 accounts — the scale the card view stops coping with.
   Screenshots go to worker/_shots/.  Run: node worker/test-crm-list.mjs */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const ROOT = new URL('../', import.meta.url);
const SHOTS = new URL('./_shots/', import.meta.url);
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const PIN = '1234';
const pw = (u) => sha('HAF-CP-TEAM|' + u + '|' + PIN);

const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));

/* 24 accounts: 18 approved (the tab that has to scale), plus a few in every other
   state so the All tab has a real mix to sort and filter. */
const SURNAMES = ['Abbott', 'Nash', 'Okafor', 'Zielinski', 'Baxter', 'Mensah', 'Doyle', 'Ravel',
  'Cummings', 'Whitfield', 'Ibrahim', 'Lang', 'Foster', 'Quinn', 'Delgado', 'Marsh', 'Yates', 'Pike'];
const apps = SURNAMES.map((ln, i) => {
  const n = String(i + 1).padStart(2, '0');
  const day = String(1 + (i % 28)).padStart(2, '0');
  return {
    ref: 'HAF-CP-D' + n, type: 'driver', username: 'T' + ln[0] + '9901' + n,
    fname: 'Test', lname: ln, email: 'd' + n + '@example.invalid', phone: '077009000' + n,
    dob: '1990-01-01', vtype: 'Small van', vreg: 'AB12 CD' + n, status: 'approved',
    email_verified: i % 5 !== 0, submitted: '2026-07-' + day + 'T09:00:00Z',
    updated_at: '2026-07-' + day + 'T09:00:00Z', pin_hash: sha('HAF-CP|x|' + PIN), docs: [],
  };
});
apps.push(
  { ref: 'HAF-CP-FRT01', type: 'freight', username: 'ZEBRAFWD1234', company: 'Zebra Forwarding Ltd',
    crn: '12345678', name: 'Testy McTestface', title: 'Director', email: 'testy@example.invalid',
    phone: '07700900500', status: 'approved', email_verified: true,
    submitted: '2026-07-30T09:00:00Z', updated_at: '2026-07-30T09:00:00Z',
    pin_hash: sha('HAF-CP|ZEBRAFWD1234|' + PIN),
    docs: [{ id: 'id-passport', filename: 'passport.jpg', size: 240000, path: 'HAF-CP-FRT01/id-passport.jpg' }] },
  { ref: 'HAF-CP-PEN01', type: 'driver', username: 'TP990199', fname: 'Pending', lname: 'Person',
    email: 'pen@example.invalid', phone: '07700900601', dob: '1990-01-01', vtype: 'Luton',
    status: 'pending', email_verified: false, submitted: '2026-07-29T09:00:00Z',
    updated_at: '2026-07-29T09:00:00Z', pin_hash: sha('HAF-CP|TP990199|' + PIN), docs: [] },
  { ref: 'HAF-CP-REV01', type: 'driver', username: 'TR990199', fname: 'Review', lname: 'Person',
    email: 'rev@example.invalid', phone: '07700900602', dob: '1990-01-01', vtype: 'MWB van',
    status: 'reviewing', email_verified: true, submitted: '2026-07-28T09:00:00Z',
    updated_at: '2026-07-28T09:00:00Z', pin_hash: sha('HAF-CP|TR990199|' + PIN), docs: [] },
  { ref: 'HAF-CP-REJ01', type: 'driver', username: 'TJ990199', fname: 'Reject', lname: 'Person',
    email: 'rej@example.invalid', phone: '07700900603', dob: '1990-01-01', vtype: 'Small van',
    status: 'rejected', email_verified: true, submitted: '2026-07-27T09:00:00Z',
    updated_at: '2026-07-27T09:00:00Z', pin_hash: sha('HAF-CP|TJ990199|' + PIN), docs: [] },
  { ref: 'HAF-CP-BUS01', type: 'business', company: 'Acme Movers Ltd', name: 'Bill Business',
    email: 'biz@example.invalid', phone: '07700900604', status: 'approved',
    notes: 'Two pallets a week to Leeds', submitted: '2026-07-26T09:00:00Z',
    updated_at: '2026-07-26T09:00:00Z', docs: [] },
);

const DB = {
  cleverpay_portal_config: [{ id: 1, config: JSON.parse(JSON.stringify(LIVE_CONFIG)) }],
  cleverpay_applications: apps,
  cleverpay_team_users: [
    { username: 'bf638793', name: 'Brent Ford', role: 'admin', must_set_pin: false, pw_hash: pw('bf638793') },
    { username: 'cleverg', name: 'Gemma Vale', role: 'compliance', must_set_pin: false, pw_hash: pw('cleverg') },
  ],
  cleverpay_team_sessions: [],
  cleverpay_api_keys: [],
};
let seq = 1;

function match(row, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (v === 'is.null') { if (row[k] != null) return false; continue; }
    if (v.startsWith('eq.') && String(row[k] ?? '') !== decodeURIComponent(v.slice(3))) return false;
  }
  return true;
}

const dbSrv = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const table = u.pathname.replace('/rest/v1/', '').split('?')[0];
  let body = ''; for await (const c of req) body += c;
  const rows = DB[table] || [];
  const send = (d, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  const or = u.searchParams.get('or');
  if (or) {
    const want = decodeURIComponent(or).replace(/[()]/g, '').split(',').map(s => s.split('.eq.')[1]);
    return send(rows.filter(r => want.includes(r.ref) || want.includes(r.username)));
  }
  const params = [...u.searchParams.entries()];
  if (req.method === 'GET') {
    let out = rows.filter(r => match(r, params));
    const lim = Number(u.searchParams.get('limit') || 0);
    return send(lim ? out.slice(0, lim) : out);
  }
  if (req.method === 'POST') {
    const row = { id: seq++, created_at: new Date().toISOString(), ...JSON.parse(body) };
    rows.push(row); DB[table] = rows; return send([row], 201);
  }
  if (req.method === 'PATCH') {
    const patch = JSON.parse(body); const hit = rows.filter(r => match(r, params));
    hit.forEach(r => Object.assign(r, patch)); return send(hit);
  }
  send([]);
});
await new Promise(r => dbSrv.listen(8796, r));

const src = readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8796/rest/v1');
const tmp = new URL('./_crm-worker.mjs', import.meta.url);
writeFileSync(tmp, src);
const worker = (await import(tmp.href)).default;

const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css' };
const siteSrv = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  const name = (path === '/' ? '/team.html' : path).slice(1);
  if (/\.(html|js|css)$/.test(name)) {
    try {
      let f = readFileSync(new URL(name, ROOT), 'utf8');
      if (name === 'api.js') f = f.replace(/const CP_API = '[^']*'/, "const CP_API = ''");
      res.writeHead(200, { 'Content-Type': MIME[name.split('.').pop()] });
      return res.end(f);
    } catch { res.writeHead(404); return res.end('nope'); }
  }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined
    : await new Promise(async r => { let b = ''; for await (const c of req) b += c; r(b); });
  const r = await worker.fetch(new Request('http://127.0.0.1:8797' + req.url, {
    method: req.method, headers: req.headers, body: body || undefined,
  }), { SB_KEY: 'stub' }, { waitUntil: p => p });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => siteSrv.listen(8797, r));
const SITE = 'http://127.0.0.1:8797';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };

const browser = await chromium.launch({
  executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});

async function login(page, user) {
  await page.goto(SITE + '/team.html');
  await page.fill('#gate-user', user);
  await page.fill('#gate-pw', PIN);
  await page.click('button.btn-full');
  await page.waitForSelector('#shell.show', { timeout: 5000 });
}

const APPROVED = apps.filter(a => a.status === 'approved').length;

/* ── 1. the Approved tab opens as a list ── */
console.log('\n── Approved tab, list view (1280px) ──');
let ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
let page = await ctx.newPage();
await login(page, 'cleverg');
await page.click('#tab-approved');
await page.waitForSelector('table.crm', { timeout: 5000 });

ok('Approved opens straight into the list, not cards', await page.locator('table.crm').count() === 1);
ok('every approved account has a row', await page.locator('.crm tr.r').count() === APPROVED, APPROVED);
ok('the rows are numbered 1 upwards',
  JSON.stringify(await page.locator('.crm tr.r td.num').allInnerTexts())
    === JSON.stringify(Array.from({ length: APPROVED }, (_, i) => String(i + 1))));
ok('the first column after the number is the username',
  /^username/i.test((await page.locator('.crm thead th').nth(1).innerText()).trim()));
ok('the reference sits next to it',
  /^reference/i.test((await page.locator('.crm thead th').nth(2).innerText()).trim()));
ok('the record continues to the right of them (8 more columns)',
  await page.locator('.crm thead th').count() === 12);
ok('the whole record fits the screen — no column is cut off',
  await page.evaluate(() => { const w = document.querySelector('.crm-wrap'); return w.scrollWidth <= w.clientWidth + 1; }));
ok('the last column is on screen', await page.locator('.crm th.th-submitted').isVisible());

/* ── 2. the stripe ── */
console.log('\n── alternating rows ──');
const cls = await page.locator('.crm tr.r').evaluateAll(rs => rs.map(r => r.className.includes('row-b') ? 'b' : 'a'));
ok('rows alternate a/b all the way down', cls.every((c, i) => c === (i % 2 ? 'b' : 'a')), cls.join(''));
const bg = await page.locator('.crm tr.r').evaluateAll(rs => rs.slice(0, 2).map(r => getComputedStyle(r).backgroundColor));
ok('row 1 and row 2 really do render differently', bg[0] !== bg[1], bg);
ok('the shade is a transparency, so it works in either theme', /rgba\(.+0\.0?\d+\)/.test(bg[1]), bg[1]);
await page.screenshot({ path: new URL('crm-approved-1280.png', SHOTS).pathname, fullPage: true });

/* ── 3. a row still opens the full record ── */
console.log('\n── opening a row ──');
const target = page.locator('#row-HAF-CP-FRT01');
await target.click();
await page.waitForTimeout(300);
ok('the detail row opens under it', await page.locator('#det-HAF-CP-FRT01').isVisible());
const det = await page.locator('#det-HAF-CP-FRT01').innerText();
ok('it carries the applicant details',
  det.includes('Zebra Forwarding Ltd') && /co\. reg\. no\./i.test(det));
ok('it carries the compliance documents', det.includes('Passport'));
ok('it carries the actions', det.includes('Approved'));
await page.screenshot({ path: new URL('crm-row-open-1280.png', SHOTS).pathname, fullPage: true });
await page.locator('#row-HAF-CP-D01').click();
await page.waitForTimeout(300);
ok('opening another closes the first — one record at a time',
  await page.locator('.crm tr.det.open').count() === 1);
await page.locator('#row-HAF-CP-D01').click();
await page.waitForTimeout(300);
ok('clicking it again closes it', await page.locator('.crm tr.det.open').count() === 0);

/* ── 4. search and sort — the reason a list beats cards at scale ── */
console.log('\n── search and sort ──');
await page.fill('#crm-search', 'Okafor');
await page.waitForTimeout(250);
ok('searching a surname narrows to one row', await page.locator('.crm tr.r').count() === 1);
ok('the count line says so', (await page.locator('.list-count').innerText()).startsWith('1 of'));
await page.fill('#crm-search', 'ZEBRAFWD');
await page.waitForTimeout(250);
ok('a username finds the record too', await page.locator('.crm tr.r').count() === 1);
await page.fill('#crm-search', 'HAF-CP-D05');
await page.waitForTimeout(250);
ok('so does a reference', await page.locator('.crm tr.r').count() === 1);
await page.fill('#crm-search', '');
await page.waitForTimeout(250);
ok('clearing brings everyone back', await page.locator('.crm tr.r').count() === APPROVED);

await page.locator('.crm th.th-name').click();
await page.waitForTimeout(250);
const names = await page.locator('.crm tr.r .c-name').allInnerTexts();
ok('clicking Name sorts A–Z',
  JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1)), names.slice(0, 3));
await page.locator('.crm th.th-name').click();
await page.waitForTimeout(250);
const rev = await page.locator('.crm tr.r .c-name').allInnerTexts();
ok('clicking it again sorts Z–A', JSON.stringify(rev) === JSON.stringify([...names].reverse()));
ok('the numbering restarts at 1 after a sort',
  (await page.locator('.crm tr.r td.num').first().innerText()) === '1');

/* ── 5. the All tab ── */
console.log('\n── All tab ──');
await page.click('#tab-all');
await page.waitForSelector('table.crm', { timeout: 5000 });
ok('All is a list too', await page.locator('table.crm').count() === 1);
ok('it holds every account', await page.locator('.crm tr.r').count() === apps.length, apps.length);
const statuses = await page.locator('.crm tr.r .chip').allInnerTexts();
ok('all four states are on show',
  ['Approved', 'Pending', 'In Review', 'Rejected'].every(s => statuses.includes(s)));

/* ── 6. the card view is still there, and the other tabs are unchanged ── */
console.log('\n── card view and the other tabs ──');
await page.click('.vs-btn:has-text("Cards")');
await page.waitForTimeout(300);
ok('switching to Cards brings the old view back', await page.locator('.app-card').count() === apps.length);
ok('and the list is gone while it is showing', await page.locator('table.crm').count() === 0);
await page.click('.vs-btn:has-text("List")');
await page.waitForTimeout(300);
ok('switching back returns the list', await page.locator('table.crm').count() === 1);

await page.click('#tab-pending');
await page.waitForTimeout(300);
ok('Pending is untouched — still cards', await page.locator('.app-card').count() === 1 && await page.locator('table.crm').count() === 0);
await page.locator('.app-head').first().click();
await page.waitForTimeout(300);
ok('and a pending card still expands', await page.locator('.app-card.expanded .app-detail').isVisible());
await page.click('#tab-settings');
await page.waitForSelector('.settings-panel', { timeout: 5000 });
ok('Settings still loads', await page.locator('.settings-panel').count() >= 1);
await ctx.close();

/* ── 7. approving from the list ── */
console.log('\n── acting on a record from the list ──');
ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
page = await ctx.newPage();
await login(page, 'cleverg');
await page.click('#tab-all');
await page.waitForSelector('table.crm', { timeout: 5000 });
await page.locator('#row-HAF-CP-REV01').click();
await page.waitForTimeout(300);
await page.locator('#det-HAF-CP-REV01 button.btn-approve').click();
await page.waitForSelector('.toast.show', { timeout: 5000 });
ok('approving from an open row works', DB.cleverpay_applications.find(a => a.ref === 'HAF-CP-REV01').status === 'approved');
await page.waitForTimeout(400);
ok('the row stays open after the list refreshes', await page.locator('#det-HAF-CP-REV01').isVisible());
ok('and its status now reads Approved',
  (await page.locator('#row-HAF-CP-REV01').innerText()).includes('Approved'));
await ctx.close();

/* ── 8. mobile ── */
console.log('\n── mobile 390px ──');
ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
page = await ctx.newPage();
await login(page, 'cleverg');
await page.click('#tab-approved');
await page.waitForSelector('table.crm', { timeout: 5000 });
ok('no sideways scrolling of the page on a phone',
  !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
const fit = await page.evaluate(() => {
  const w = document.querySelector('.crm-wrap');
  const cells = [...document.querySelectorAll('.crm tr.r')[0].children]
    .filter(c => getComputedStyle(c).display !== 'none')
    .map(c => c.className + ':' + Math.round(c.getBoundingClientRect().width));
  return { scroll: w.scrollWidth, client: w.clientWidth, cells };
});
ok('the table itself fits the phone', fit.scroll <= fit.client + 1, fit);
ok('email, phone and date fold away on a phone',
  await page.locator('.crm td.sm-hide').first().isVisible() === false);
ok('number, username, reference, name and status stay',
  await page.locator('.crm tr.r').first().locator('td:not(.sm-hide)').count() === 6);
await page.locator('.crm tr.r').first().click();
await page.waitForTimeout(300);
ok('a record still opens on a phone', await page.locator('.crm tr.det.open').count() === 1);
ok('and opening it does not push the page sideways',
  !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
await page.screenshot({ path: new URL('crm-approved-390.png', SHOTS).pathname, fullPage: true });
await ctx.close();

/* ── 9. light theme ── */
console.log('\n── light theme ──');
ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
page = await ctx.newPage();
await login(page, 'cleverg');
await page.click('#tab-approved');
await page.waitForSelector('table.crm', { timeout: 5000 });
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await page.waitForTimeout(200);
const lbg = await page.locator('.crm tr.r').evaluateAll(rs => rs.slice(0, 2).map(r => getComputedStyle(r).backgroundColor));
ok('the stripe still reads in the light theme', lbg[0] !== lbg[1], lbg);
await page.screenshot({ path: new URL('crm-approved-light-1280.png', SHOTS).pathname, fullPage: true });
await ctx.close();

await browser.close();
dbSrv.close(); siteSrv.close();
try { unlinkSync(tmp); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
