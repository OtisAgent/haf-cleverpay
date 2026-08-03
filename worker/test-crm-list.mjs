/* Browser proof for the CRM list view on the team portal's Approved and All tabs.
   Serves the real portal files against the real worker module backed by a stub
   database seeded with 24 accounts — the scale the card view stops coping with.
   Screenshots go to worker/_shots/.  Run: node worker/test-crm-list.mjs */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

/* the box has changed chromium build more than once — take whichever is installed */
const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const ROOT = new URL('../', import.meta.url);
const SHOTS = new URL('./_shots/', import.meta.url);
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const PIN = '1234';
const pw = (u) => sha('HAF-CP-TEAM|' + u + '|' + PIN);

const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));

/* 24 accounts: 18 approved (the tab that has to scale), plus a few in every other
   state so the All tab has a real mix to sort and filter. */
const NOW = new Date().toISOString();
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
  /* the three shapes the New Applications sections have to tell apart */
  { ref: 'HAF-CP-TODAY1', type: 'driver', username: 'TT990101', fname: 'Today', lname: 'Arrival',
    email: 'today@example.invalid', phone: '07700900610', dob: '1990-01-01', vtype: 'Small van',
    status: 'pending', email_verified: false, submitted: NOW, updated_at: NOW,
    pin_hash: sha('HAF-CP|TT990101|' + PIN), docs: [] },
  { ref: 'HAF-CP-SEEN1', type: 'driver', username: 'TS990101', fname: 'Seen', lname: 'Nodocs',
    email: 'seen@example.invalid', phone: '07700900611', dob: '1990-01-01', vtype: 'MWB van',
    status: 'pending', email_verified: true, submitted: '2026-07-25T09:00:00Z',
    updated_at: '2026-07-25T09:00:00Z', viewed_at: '2026-07-26T10:00:00Z', viewed_by: 'cleverg',
    pin_hash: sha('HAF-CP|TS990101|' + PIN), docs: [] },
  { ref: 'HAF-CP-SEEN2', type: 'driver', username: 'TD990101', fname: 'Seen', lname: 'Withdocs',
    email: 'seend@example.invalid', phone: '07700900612', dob: '1990-01-01', vtype: 'LWB van',
    status: 'pending', email_verified: true, submitted: '2026-07-24T09:00:00Z',
    updated_at: '2026-07-24T09:00:00Z', viewed_at: '2026-07-26T10:00:00Z', viewed_by: 'cleverg',
    pin_hash: sha('HAF-CP|TD990101|' + PIN),
    docs: [{ id: 'id-passport', filename: 'p.jpg', size: 1000, path: 'HAF-CP-SEEN2/id-passport.jpg' }] },
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

/* the network states: one live in the network, one paid and waiting on activation */
apps[0].activated_at = '2026-07-30T12:00:00Z';
apps[0].membership_paid_at = '2026-07-30T11:00:00Z';
apps[0].membership_amount = 4999;
apps[0].membership_currency = 'gbp';
apps[0].knect = true;
apps[1].membership_paid_at = '2026-07-30T11:30:00Z';
apps[1].membership_amount = 4999;
apps[1].approved_at = '2026-07-30T12:30:00Z';

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
  /* the portal calls the database function straight from the browser, so the stub
     has to answer the preflight the same way Supabase does */
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const send = (d, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(d)); };

  /* stands in for the database function that records who first opened a record —
     same contract: a valid team session, and the first stamp is the one that keeps */
  if (table === 'rpc/cleverpay_team_mark_seen') {
    const b = JSON.parse(body || '{}');
    const s = DB.cleverpay_team_sessions.find(x => x.token === b.p_token && new Date(x.expires_at) > new Date());
    if (!s) return send({ message: 'not_authorised' }, 400);
    const a = DB.cleverpay_applications.find(x => x.ref === String(b.p_ref || '').toUpperCase());
    if (!a) return send({ message: 'not_found' }, 400);
    a.viewed_at = a.viewed_at || new Date().toISOString();
    a.viewed_by = a.viewed_by || s.username;
    return send({ ref: a.ref, viewed_at: a.viewed_at, viewed_by: a.viewed_by });
  }
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
      /* the "opened by" write goes straight to the database, so point it at the stub */
      if (name === 'team.js') f = f.replace("const SB_URL='https://jsdwvogsxlnczzbefwgp.supabase.co'", "const SB_URL='http://127.0.0.1:8796'");
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
  executablePath: CHROME,
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
ok('the record continues to the right of them (14 columns of record, including the driving record check)',
  await page.locator('.crm thead th').count() === 16);
ok('the compliance verdict has its own column', await page.locator('.crm th.th-checked').count() === 1);
ok('so does where they stand in the network', await page.locator('.crm th.th-network').count() === 1);
ok('and the vehicle', await page.locator('.crm th.th-vehicle').count() === 1);

/* ── 2b. what the extra columns actually say ── */
console.log('\n── the extra columns ──');
const liveRow = await page.locator('#row-HAF-CP-D01').innerText();
ok('an activated account reads Active in the network', /Active/.test(liveRow), liveRow);
const activeColour = await page.locator('#row-HAF-CP-D01 .npill').evaluate(e => getComputedStyle(e).color);
ok('and it is green', /45,\s*171,\s*96/.test(activeColour), activeColour);
const payingRow = await page.locator('#row-HAF-CP-D02').innerText();
ok('paid but not yet activated reads Activating, not Active', /Activating/.test(payingRow), payingRow);
ok('and it carries the date it was Clever Checked', /30 Jul/.test(payingRow), payingRow);
const notJoined = await page.locator('#row-HAF-CP-D03').innerText();
ok('a checked account with no membership reads Not joined', /Not joined/.test(notJoined), notJoined);
ok('the documents column counts what is in and what is missing',
  /\d+ needed|All \d+ in|\d+ missing/.test(await page.locator('#row-HAF-CP-FRT01 td.td-docs').innerText()));

/* ── 2c. the number and first column stay put when the record scrolls sideways ── */
console.log('\n── sticky first columns ──');
const stick = await page.evaluate(() => {
  const w = document.querySelector('.crm-wrap');
  const before = document.querySelector('.crm tr.r td.stick1').getBoundingClientRect().left;
  w.scrollLeft = 400;
  return { scrolls: w.scrollWidth > w.clientWidth, before,
    after: document.querySelector('.crm tr.r td.stick1').getBoundingClientRect().left };
});
ok('the wider record scrolls sideways inside its own box', stick.scrolls);
ok('the username column does not scroll away with it', Math.abs(stick.after - stick.before) < 2, stick);
await page.evaluate(() => { document.querySelector('.crm-wrap').scrollLeft = 0; });

/* ── 2d. the Columns button ── */
console.log('\n── choosing columns ──');
await page.click('.col-pick .vs-btn');
await page.waitForTimeout(200);
ok('the Columns menu opens', await page.locator('.col-menu').isVisible());
ok('it lists every column there is', await page.locator('.col-opt').count() === 21);
await page.locator('.col-opt:has-text("Membership")').click();
await page.waitForTimeout(250);
ok('ticking Membership adds the column', await page.locator('.crm th.th-membership').count() === 1);
ok('and it shows what was paid', /£49\.99/.test(await page.locator('#row-HAF-CP-D01 td.td-membership').innerText()));
await page.locator('.col-opt:has-text("Phone")').click();
await page.waitForTimeout(250);
ok('unticking Phone removes it', await page.locator('.crm th.th-phone').count() === 0);
await page.reload();
await page.waitForSelector('#shell.show', { timeout: 5000 }).catch(async () => { await login(page, 'cleverg'); });
await page.click('#tab-approved');
await page.waitForSelector('table.crm', { timeout: 5000 });
ok('the choice survives a reload', await page.locator('.crm th.th-membership').count() === 1
  && await page.locator('.crm th.th-phone').count() === 0);
await page.click('.col-pick .vs-btn');
await page.waitForTimeout(150);
await page.locator('.col-menu-f button').click();
await page.waitForTimeout(250);
ok('the reset puts the standard columns back',
  await page.locator('.crm thead th').count() === 16 && await page.locator('.crm th.th-phone').count() === 1);
await page.click('.col-pick .vs-btn');
await page.waitForTimeout(150);

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

/* ── 6b. New Applications: sections ── */
console.log('\n── New Applications, sections ──');
await page.click('#tab-pending');
await page.waitForTimeout(300);
ok('New Applications still opens as cards, not a list',
  await page.locator('.app-card').count() === 4 && await page.locator('table.crm').count() === 0);
const secTitles = (await page.locator('.sec-t').allInnerTexts()).map(t => t.toUpperCase());
ok('it is split into the three sections, in order',
  JSON.stringify(secTitles) === JSON.stringify(['New today', 'Seen by the team — no documents yet', 'Everything else waiting'].map(t => t.toUpperCase())), secTitles);
const secCounts = await page.locator('.sec-n').allInnerTexts();
ok('each heading carries its own count', JSON.stringify(secCounts) === JSON.stringify(['1', '1', '2']), secCounts);
const secOf = async (i) => (await page.locator('.qsec').nth(i).innerText());
ok('today\'s arrival is the only thing under New today', (await secOf(0)).includes('Today Arrival'));
ok('the one we opened with nothing uploaded sits in its own section',
  (await secOf(1)).includes('Seen Nodocs') && !(await secOf(1)).includes('Seen Withdocs'));
ok('one we opened that DID upload is not in it — it is waiting on us, not them',
  (await secOf(2)).includes('Seen Withdocs') && (await secOf(2)).includes('Pending Person'));
ok('a card that has been opened says who opened it',
  (await page.locator('#card-HAF-CP-SEEN1').innerText()).includes('Opened by cleverg'));
await page.locator('#head-HAF-CP-PEN01').click();
await page.waitForTimeout(300);
ok('and a pending card still expands', await page.locator('.app-card.expanded .app-detail').isVisible());

/* ── 6c. opening a record is what puts it in the "seen" section ── */
console.log('\n── opening a record records who opened it ──');
await page.waitForTimeout(400);
const pen = DB.cleverpay_applications.find(a => a.ref === 'HAF-CP-PEN01');
ok('opening it stamped the record in the database', !!pen.viewed_at, pen.viewed_at);
ok('with the name of whoever opened it', pen.viewed_by === 'cleverg', pen.viewed_by);
const firstStamp = pen.viewed_at;
await page.click('#tab-approved');
await page.click('#tab-pending');
await page.waitForTimeout(300);
ok('it has moved into the seen-with-no-documents section',
  (await secOf(1)).includes('Pending Person'));
const counts2 = await page.locator('.sec-n').allInnerTexts();
ok('and the counts moved with it', JSON.stringify(counts2) === JSON.stringify(['1', '2', '1']), counts2);
await page.locator('#head-HAF-CP-PEN01').click();
await page.waitForTimeout(400);
ok('re-opening it keeps the FIRST person and time, not the latest',
  DB.cleverpay_applications.find(a => a.ref === 'HAF-CP-PEN01').viewed_at === firstStamp);
await page.screenshot({ path: new URL('crm-pending-sections-1280.png', SHOTS).pathname, fullPage: true });
await page.click('.vs-btn:has-text("List")');
await page.waitForTimeout(300);
ok('the sections work as a list too', await page.locator('.qsec table.crm').count() === 3);
ok('with the same three headings', (await page.locator('.sec-t').count()) === 3);
await page.screenshot({ path: new URL('crm-pending-sections-list-1280.png', SHOTS).pathname, fullPage: true });
await page.click('.vs-btn:has-text("Cards")');
await page.waitForTimeout(300);
ok('and New Applications remembers cards separately from the other tabs',
  await page.locator('.app-card').count() === 4);
await page.click('#tab-approved');
await page.waitForTimeout(300);
ok('— Approved is still a list', await page.locator('table.crm').count() === 1);
await page.click('#tab-pending');
await page.waitForTimeout(300);
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
