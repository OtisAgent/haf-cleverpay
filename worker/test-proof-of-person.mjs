/* Browser proof for the freight "proof of person" documents (passport, driving
   licence, utility bill). Serves the real portal files against the real worker
   module backed by a stub database whose saved config is a byte-copy of the LIVE
   portal config — the case that matters, because a saved config overrides the
   built-in list and would otherwise hide anything newly added.
   Screenshots go to worker/_shots/.  Run: node worker/test-proof-of-person.mjs */
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

/* the config exactly as it is saved in production today — 10 freight documents,
   none of them proof of person */
const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));
const NEW_IDS = ['id-passport', 'id-licence', 'id-utility'];

const DB = {
  cleverpay_portal_config: [{ id: 1, config: JSON.parse(JSON.stringify(LIVE_CONFIG)) }],
  cleverpay_applications: [
    {
      ref: 'HAF-CP-FRT01', type: 'freight', username: 'TESTFWD1234', company: 'Test Forwarding Ltd',
      crn: '12345678', name: 'Testy McTestface', title: 'Director', email: 'testy@example.invalid',
      phone: '07700900000', status: 'pending', email_verified: true,
      submitted: '2026-07-31T09:00:00Z', updated_at: '2026-07-31T09:00:00Z',
      pin_hash: sha('HAF-CP|TESTFWD1234|' + PIN), docs: [],
    },
    {
      ref: 'HAF-CP-DRV01', type: 'driver', username: 'TD990101', fname: 'Testy', lname: 'McTestface',
      email: 'driver@example.invalid', phone: '07700900001', dob: '1990-01-01', vtype: 'Small van',
      status: 'pending', email_verified: true, submitted: '2026-07-31T09:00:00Z',
      updated_at: '2026-07-31T09:00:00Z', pin_hash: sha('HAF-CP|TD990101|' + PIN), docs: [],
    },
  ],
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
await new Promise(r => dbSrv.listen(8798, r));

const src = readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8798/rest/v1');
const tmp = new URL('./_pop-worker.mjs', import.meta.url);
writeFileSync(tmp, src);
const worker = (await import(tmp.href)).default;

/* one origin for the pages and the API, so the browser isn't fighting CORS */
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
  const r = await worker.fetch(new Request('http://127.0.0.1:8799' + req.url, {
    method: req.method, headers: req.headers, body: body || undefined,
  }), { SB_KEY: 'stub' }, { waitUntil: p => p });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => siteSrv.listen(8799, r));
const SITE = 'http://127.0.0.1:8799';

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

/* an applicant arrives at the upload page the way the sign-up form sends them */
async function asApplicant(ctx, ref, username) {
  const page = await ctx.newPage();
  await page.goto(SITE + '/status.html');
  await page.evaluate(([ref, hash]) => {
    localStorage.setItem('cp_application', JSON.stringify({
      ref, type: ref.includes('FRT') ? 'freight' : 'driver', status: 'pending', pinHash: hash,
    }));
  }, [ref, sha('HAF-CP|' + username + '|' + PIN)]);
  await page.goto(SITE + '/docs.html');
  await page.waitForSelector('.doc-card', { timeout: 5000 });
  return page;
}

/* ── 1. the team portal settings ── */
console.log('\n── Settings tab, freight section (Gemma, 1280px) ──');
let ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
let page = await ctx.newPage();
await login(page, 'cleverg');
await page.click('#tab-settings');
await page.waitForSelector('.settings-panel', { timeout: 5000 });

for (const id of NEW_IDS) {
  ok(`freight row "${id}" is on the settings page`, await page.locator('#sel-freight-' + id).count() === 1);
}
ok('none of them landed in the driver section', (await Promise.all(NEW_IDS.map(id =>
  page.locator('#sel-driver-' + id).count()))).every(n => n === 0));
ok('all three default to Optional, so nobody is blocked',
  (await Promise.all(NEW_IDS.map(id => page.locator('#sel-freight-' + id).inputValue()))).every(v => v === 'optional'));
ok('the passport row reads as proof of person',
  (await page.locator('#sel-freight-id-passport').locator('xpath=../div').innerText()).includes('Passport — proof of person'));
ok('every document the team had already saved is still there',
  (await Promise.all(LIVE_CONFIG.freight.docs.map(d => page.locator('#sel-freight-' + d.id).count()))).every(n => n === 1));
ok('and their saved Required/Optional choices are untouched',
  (await Promise.all(LIVE_CONFIG.freight.docs.map(async d => (await page.locator('#sel-freight-' + d.id).inputValue()) === d.status))).every(Boolean));
ok('the driver list is unchanged (11 rows)', await page.locator('[id^="sel-driver-"]').count() === LIVE_CONFIG.driver.docs.length);
await page.screenshot({ path: new URL('pop-settings-1280.png', SHOTS).pathname, fullPage: true });

/* ── 2. the team can switch one to Required and it sticks ── */
console.log('\n── switching passport to Required ──');
await page.selectOption('#sel-freight-id-passport', 'required');
await page.click('button:has-text("Save freight requirements")');
await page.waitForSelector('.toast.show', { timeout: 5000 });
ok('saving confirms', (await page.locator('.toast').innerText()).includes('Freight requirements saved'));
const saved = DB.cleverpay_portal_config[0].config.freight.docs;
ok('the saved config now holds all three new documents',
  NEW_IDS.every(id => saved.some(d => d.id === id)), saved.map(d => d.id));
ok('passport is stored as Required', (saved.find(d => d.id === 'id-passport') || {}).status === 'required');
ok('nothing else changed status', LIVE_CONFIG.freight.docs.every(d =>
  (saved.find(x => x.id === d.id) || {}).status === d.status));
await ctx.close();

/* ── 3. what the freight applicant sees ── */
console.log('\n── the freight applicant\'s upload page ──');
ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
page = await asApplicant(ctx, 'HAF-CP-FRT01', 'TESTFWD1234');
for (const id of NEW_IDS) {
  ok(`the freight applicant is offered "${id}"`, await page.locator('#card-' + id).count() === 1);
}
ok('passport now sits under Required (the team just switched it)',
  await page.locator('#card-id-passport .doc-req').count() === 1 &&
  await page.locator('#req-list #card-id-passport').count() === 1);
ok('licence and utility bill stay Optional',
  await page.locator('#opt-list #card-id-licence .doc-opt').count() === 1 &&
  await page.locator('#opt-list #card-id-utility .doc-opt').count() === 1);
ok('each one has a working file picker',
  (await Promise.all(NEW_IDS.map(id => page.locator('#input-' + id).count()))).every(n => n === 1));
ok('the utility bill wording is about the person, not the business',
  (await page.locator('#hint-id-utility').innerText()).includes('own name at their home address'));
await page.screenshot({ path: new URL('pop-applicant-1280.png', SHOTS).pathname, fullPage: true });
await ctx.close();

/* ── 4. the driver side is untouched ── */
console.log('\n── the driver applicant\'s upload page ──');
ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
page = await asApplicant(ctx, 'HAF-CP-DRV01', 'TD990101');
ok('no proof-of-person cards leaked onto the driver page',
  (await Promise.all(NEW_IDS.map(id => page.locator('#card-' + id).count()))).every(n => n === 0));
ok('the driver still sees their full 11 documents', await page.locator('.doc-card').count() === LIVE_CONFIG.driver.docs.length);
await ctx.close();

/* ── 5. an uploaded proof-of-person document shows in the compliance queue ── */
console.log('\n── the compliance queue ──');
DB.cleverpay_applications[0].docs = [
  { id: 'id-passport', filename: 'passport.jpg', size: 240000, path: 'HAF-CP-FRT01/id-passport.jpg' },
  { id: 'id-utility', filename: 'utility-bill.pdf', size: 91000, path: 'HAF-CP-FRT01/id-utility.pdf' },
];
ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
page = await ctx.newPage();
await login(page, 'cleverg');
await page.waitForSelector('.app-card', { timeout: 5000 });
const card = page.locator('.app-card').filter({ hasText: 'HAF-CP-FRT01' }).first();
await card.click();
await page.waitForTimeout(400);
const cardText = await card.innerText();
ok('the passport shows by name, not by code', cardText.includes('Passport — proof of person'), cardText.slice(0, 400));
ok('the utility bill shows by name, not by code', cardText.includes('Utility bill — proof of person'));
ok('the team can open the uploaded file', await card.locator('button.doc-open').count() >= 2);
ok('the licence they did not upload is not flagged as missing', !cardText.includes('Driving licence — proof of person'));
await page.screenshot({ path: new URL('pop-queue-1280.png', SHOTS).pathname, fullPage: true });
await ctx.close();

/* ── 6. mobile ── */
console.log('\n── mobile 390px ──');
ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
page = await ctx.newPage();
await login(page, 'cleverg');
await page.click('#tab-settings');
await page.waitForSelector('.settings-panel');
ok('settings: no sideways scrolling on mobile',
  !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
await page.screenshot({ path: new URL('pop-settings-390.png', SHOTS).pathname, fullPage: true });
await page.close();
page = await asApplicant(ctx, 'HAF-CP-FRT01', 'TESTFWD1234');
ok('applicant page: no sideways scrolling on mobile',
  !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
ok('all three cards are visible on a phone',
  (await Promise.all(NEW_IDS.map(id => page.locator('#card-' + id).isVisible()))).every(Boolean));
await page.screenshot({ path: new URL('pop-applicant-390.png', SHOTS).pathname, fullPage: true });
await ctx.close();

await browser.close();
dbSrv.close(); siteSrv.close();
try { unlinkSync(tmp); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
