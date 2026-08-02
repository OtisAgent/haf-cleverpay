/* Browser proof for the Integration panel.
   Serves the real portal files against the real worker module backed by a stub
   database holding one made-up driver, then drives it as Brent, as Gemma, and as
   a third team member. Screenshots go to worker/_shots/.
   Run: node worker/test-panel.mjs */
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

const DB = {
  cleverpay_applications: [{
    ref: 'HAF-CP-TEST01', type: 'driver', username: 'TD990101', fname: 'Testy', lname: 'McTestface',
    email: 'testy@example.invalid', phone: '07700900000', dob: '1990-01-01', vtype: 'Small van',
    status: 'approved', email_verified: true, submitted: '2026-07-31T09:00:00Z',
    approved_at: '2026-07-31T09:30:00Z', updated_at: '2026-07-31T09:30:00Z', docs: [],
  }],
  cleverpay_team_users: [
    { username: 'bf638793', name: 'Brent Ford', role: 'admin', must_set_pin: false, pw_hash: pw('bf638793') },
    { username: 'cleverg', name: 'Gemma Vale', role: 'compliance', must_set_pin: false, pw_hash: pw('cleverg') },
    { username: 'admin', name: 'Admin', role: 'admin', must_set_pin: false, pw_hash: pw('admin') },
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

/* stub database */
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
    const row = { id: seq++, created_at: new Date().toISOString(), use_count: 0, revoked_at: null, ...JSON.parse(body) };
    rows.push(row); DB[table] = rows; return send([row], 201);
  }
  if (req.method === 'PATCH') {
    const patch = JSON.parse(body); const hit = rows.filter(r => match(r, params));
    hit.forEach(r => Object.assign(r, patch)); return send(hit);
  }
  send([]);
});
await new Promise(r => dbSrv.listen(8788, r));

/* the real worker, pointed at the stub database */
const src = readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8788/rest/v1');
const tmp = new URL('./_panel-worker.mjs', import.meta.url);
writeFileSync(tmp, src);
const worker = (await import(tmp.href)).default;

const apiSrv = createServer(async (req, res) => {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined
    : await new Promise(async r => { let b = ''; for await (const c of req) b += c; r(b); });
  const r = await worker.fetch(new Request('http://127.0.0.1:8789' + req.url, {
    method: req.method, headers: req.headers, body: body || undefined,
  }), { SB_KEY: 'stub' }, { waitUntil: p => p });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => apiSrv.listen(8789, r));

/* the real portal files, with the API pointed locally */
/* One origin for both the pages and the API, so the browser test isn't fighting
   CORS that only ever has to allow the real clever.usehaf.co.uk anyway. */
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
  const r = await worker.fetch(new Request('http://127.0.0.1:8790' + req.url, {
    method: req.method, headers: req.headers, body: body || undefined,
  }), { SB_KEY: 'stub' }, { waitUntil: p => p });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => siteSrv.listen(8790, r));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox'],
});

async function login(page, user) {
  await page.goto('http://127.0.0.1:8790/team.html');
  await page.fill('#gate-user', user);
  await page.fill('#gate-pw', PIN);
  await page.click('button.btn-full');
  await page.waitForSelector('#shell.show', { timeout: 5000 });
}

/* ── Brent ── */
console.log('\n── Brent (bf638793), desktop ──');
let ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
let page = await ctx.newPage();
await login(page, 'bf638793');
ok('Brent sees the Integration tab', await page.locator('#tab-integration').count() === 1);
await page.click('#tab-integration');
await page.waitForSelector('.ig-wrap', { timeout: 5000 });
ok('the panel shows no key yet', (await page.locator('.ig-wrap').innerText()).includes('no key yet'));
ok('the status light is amber, not green', await page.locator('.ig-dot.ig-warn').count() === 1);
ok('the endpoint address is shown', (await page.locator('#ig-ep').innerText()).includes('/partner/compliance'));
await page.screenshot({ path: new URL('brent-nokey-1280.png', SHOTS).pathname, fullPage: true });

await page.click('button:has-text("Generate key")');
await page.waitForSelector('#ig-key-ov.open', { timeout: 5000 });
const shownKey = (await page.locator('#ig-key-val').innerText()).trim();
ok('the key is shown once, in full', /^cpk_[a-f0-9]{40}$/.test(shownKey), shownKey);
ok('it warns the key will not be shown again', (await page.locator('#ig-key-ov .modal').innerText()).includes('not be shown again'));
await page.screenshot({ path: new URL('brent-newkey-1280.png', SHOTS).pathname });
await page.click('button:has-text("I\'ve saved it")');
await page.waitForSelector('#ig-key-ov.open', { state: 'hidden' });
await page.waitForSelector('.ig-kval', { timeout: 5000 });
ok('the panel now shows only the key prefix', (await page.locator('.ig-kval').innerText()).trim() === shownKey.slice(0, 12) + '…');
ok('the full key is gone from the page', !(await page.content()).includes(shownKey));
ok('the status light is now green', await page.locator('.ig-dot.ig-ok').count() === 1);
ok('it says the back office can connect', (await page.locator('.ig-status-t').innerText()).includes('Working'));
await page.screenshot({ path: new URL('brent-key-1280.png', SHOTS).pathname, fullPage: true });

/* the back office actually works with that key */
const res = await fetch('http://127.0.0.1:8789/partner/compliance', { headers: { 'X-API-Key': shownKey } });
const data = await res.json();
ok('the generated key really reads the back-office endpoint', res.status === 200 && data.count === 1, data);
ok('and only the agreed fields cross', JSON.stringify(Object.keys(data.accounts[0]).sort()) ===
  JSON.stringify(['account_type', 'approved_at', 'compliance_status', 'email_confirmed', 'name', 'received', 'reference', 'rejected_at', 'submitted_at', 'updated_at'].filter(k => k !== 'received').sort()), Object.keys(data.accounts[0]));

await page.click('#tab-integration');
await page.waitForSelector('.ig-status-s');
ok('"last used" appears once the back office has called', (await page.locator('.ig-status-s').innerText()).includes('Last used'), await page.locator('.ig-status-s').innerText());
await ctx.close();

/* ── Brent, mobile ── */
console.log('\n── Brent, mobile 390px ──');
ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
page = await ctx.newPage();
await login(page, 'bf638793');
await page.click('#tab-integration');
await page.waitForSelector('.ig-wrap');
const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok('no sideways scrolling on mobile', !wide);
await page.screenshot({ path: new URL('brent-key-390.png', SHOTS).pathname, fullPage: true });
await ctx.close();

/* ── Gemma ── */
console.log('\n── Gemma (cleverg) ──');
ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
page = await ctx.newPage();
await login(page, 'cleverg');
ok('Gemma sees the Integration tab', await page.locator('#tab-integration').count() === 1);
await page.click('#tab-integration');
await page.waitForSelector('.ig-wrap');
ok('Gemma sees the key Brent made', (await page.locator('.ig-kval').innerText()).trim() === shownKey.slice(0, 12) + '…');
ok('Gemma can replace it', await page.locator('button:has-text("Replace key")').count() === 1);
await page.screenshot({ path: new URL('gemma-key-1280.png', SHOTS).pathname, fullPage: true });
await ctx.close();

/* ── a third team member ── */
console.log('\n── a third team login (admin) ──');
ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
page = await ctx.newPage();
await login(page, 'admin');
ok('no Integration tab anywhere on the page', await page.locator('#tab-integration').count() === 0);
ok('the word "Integration" appears nowhere', !(await page.locator('.tab-bar').innerText()).includes('Integration'));
await page.click('#tab-all');   /* the made-up driver is approved, so not on Pending */
/* the All tab has been the CRM list since the list view shipped — rows, not cards */
await page.waitForSelector('.crm tbody tr, .app-card');
ok('they still see the normal queue', (await page.locator('#main-content').innerText()).includes('McTestface'));
await page.screenshot({ path: new URL('admin-notab-1280.png', SHOTS).pathname, fullPage: true });

/* and if they force the request anyway, the server refuses */
const forced = await page.evaluate(async () => {
  const t = JSON.parse(sessionStorage.getItem('cp_team_session')).token;
  const a = await fetch('/team/integration', { headers: { Authorization: 'Bearer ' + t } });
  const b = await fetch('/team/integration/key', {
    method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: '{}' });
  return { read: a.status, make: b.status, readBody: await a.text() };
});
ok('forcing the read is refused by the server', forced.read === 404, forced);
ok('forcing a key is refused by the server', forced.make === 404, forced);
ok('the refusal reveals nothing', forced.readBody.trim() === '{"error":"Not found."}', forced.readBody);
await ctx.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log('screenshots → worker/_shots/\n');
await browser.close();
unlinkSync(tmp);
dbSrv.close(); apiSrv.close(); siteSrv.close();
process.exit(fail ? 1 : 0);
