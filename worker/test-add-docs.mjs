/* Proof for attaching documents while the team adds an account by hand: the files
   the team already holds go on the record at the moment the account is created,
   land in the document store, and read back in the queue exactly like a driver's
   own upload. Real portal files, real worker module, stub database and store.
   Screenshots go to worker/_shots/.
   Run: node worker/test-add-docs.mjs */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const ROOT = new URL('../', import.meta.url);
const SHOTS = new URL('./_shots/', import.meta.url);
const TMPD = new URL('./_addfiles/', import.meta.url);
[SHOTS, TMPD].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const PIN = '1234';
const pw = (u) => sha('HAF-CP-TEAM|' + u + '|' + PIN);
const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));

/* real-ish files the team would have on the desk */
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% CleverPay test document\n'), Buffer.alloc(4096, 0x20), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082', 'hex');
const F = {
  dlFront: new URL('./_addfiles/licence-front.pdf', import.meta.url),
  hrIns:   new URL('./_addfiles/hire-and-reward.png', import.meta.url),
  noType:  new URL('./_addfiles/photo-of-mot.heic', import.meta.url),
  huge:    new URL('./_addfiles/too-big.pdf', import.meta.url),
  incorp:  new URL('./_addfiles/incorporation.pdf', import.meta.url),
};
writeFileSync(F.dlFront, PDF);
writeFileSync(F.hrIns, PNG);
writeFileSync(F.noType, PNG);                       /* chromium reports no MIME for .heic */
writeFileSync(F.huge, Buffer.alloc(16 * 1024 * 1024, 0x41));
writeFileSync(F.incorp, PDF);

const apps = [];
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
const STORE = new Map();          /* path → {bytes, mime} — stands in for the document store */
let seq = 1;

function match(row, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (v === 'is.null') { if (row[k] != null) return false; continue; }
    if (v === 'not.is.null') { if (row[k] == null) return false; continue; }
    if (v.startsWith('eq.') && String(row[k] ?? '') !== decodeURIComponent(v.slice(3))) return false;
  }
  return true;
}

/* one stub server for both the database and the document store, binary-safe */
const dbSrv = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);

  if (u.pathname.startsWith('/storage/')) {
    const path = decodeURIComponent(u.pathname.slice('/storage/'.length));
    if (req.method === 'GET') {
      const f = STORE.get(path);
      if (!f) { res.writeHead(404, CORS); return res.end('no'); }
      res.writeHead(200, { 'Content-Type': f.mime, ...CORS }); return res.end(f.bytes);
    }
    STORE.set(path, { bytes: raw, mime: (req.headers['content-type'] || '').split(';')[0] });
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ Key: path }));
  }

  const table = u.pathname.replace('/rest/v1/', '').split('?')[0];
  const rows = DB[table] || [];
  const body = raw.toString('utf8');
  const send = (d, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(d)); };
  const or = u.searchParams.get('or');
  if (or) {
    const want = decodeURIComponent(or).replace(/[()]/g, '').split(',').map(s => s.split('.eq.')[1]);
    return send(rows.filter(r => want.includes(r.ref) || want.includes(r.username)));
  }
  const params = [...u.searchParams.entries()];
  if (req.method === 'GET') {
    const out = rows.filter(r => match(r, params));
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

const swap = s => s
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8796/rest/v1')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/', 'http://127.0.0.1:8796/storage/');
const src = swap(readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8'));
const tmp = new URL('./_add-worker.mjs', import.meta.url);
writeFileSync(tmp, src);
const apiWorker = (await import(tmp.href)).default;
/* The back office runs as its own worker in production, reached over a private
   binding because a single script no longer fits the 20,000-character deploy
   pipe. The harness wires the two together the same way, so what is tested here
   is the same path a request takes live. */
const adminSrc = swap(readFileSync(new URL('./cleverpay-admin.js', import.meta.url), 'utf8'));
const atmp = new URL('./_add-admin.mjs', import.meta.url);
writeFileSync(atmp, adminSrc);
const adminWorker = (await import(atmp.href)).default;
const worker = { fetch: (req, env, ctx) => apiWorker.fetch(req,
  { ...env, ADMIN: { fetch: r => adminWorker.fetch(r, {}, ctx) } }, ctx) };

const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css' };
const siteSrv = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  const name = (path === '/' ? '/team.html' : path).slice(1);
  if (/\.(html|js|css)$/.test(name)) {
    try {
      let f = readFileSync(new URL(name, ROOT), 'utf8');
      if (name === 'api.js') f = f.replace(/const CP_API = '[^']*'/, "const CP_API = ''");
      if (name === 'team.js') f = f.replace("const SB_URL='https://jsdwvogsxlnczzbefwgp.supabase.co'", "const SB_URL='http://127.0.0.1:8796'");
      res.writeHead(200, { 'Content-Type': MIME[name.split('.').pop()] });
      return res.end(f);
    } catch { res.writeHead(404); return res.end('nope'); }
  }
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const r = await worker.fetch(new Request('http://127.0.0.1:8797' + req.url, {
    method: req.method, headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
  }), { SB_KEY: 'stub' }, { waitUntil: p => p });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => siteSrv.listen(8797, r));
const SITE = 'http://127.0.0.1:8797';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };
const api = async (path, init = {}) => {
  const r = await worker.fetch(new Request('http://127.0.0.1:8797' + path, init), { SB_KEY: 'stub' }, { waitUntil: p => p });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const byUser = (u) => apps.find(a => a.username === u);

/* ── 1. the road the portal drives: create, store the file, put it on the record ── */
console.log('\nThe road the portal drives');
const login = await api('/team/login', { method: 'POST', body: JSON.stringify({ username: 'cleverg', password: PIN }) });
ok('compliance signs in', login.status === 200 && !!login.body.token, login.body);
const TOKEN = login.body.token;
const auth = (body, method = 'POST') => ({ method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

const made = await api('/team/applications', auth({ type: 'driver', username: 'AD800101', fname: 'Ada', lname: 'Doyle',
  phone: '07700900901', dob: '1980-01-01', status: 'approved' }));
ok('an account can still be added with no documents at all', made.status === 200 && !!made.body.ref, made.body);
const REF = made.body.ref;
ok('and it starts with an empty document list', Array.isArray(byUser('AD800101').docs) && byUser('AD800101').docs.length === 0);

const up = await api(`/docs/file?ref=${REF}&id=dl-front&k=`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: PDF });
ok('a file the team holds goes into the document store', up.status === 200 && up.body.path === REF + '/dl-front', up.body);
ok('the store really received the bytes', STORE.get(REF + '/dl-front')?.bytes.length === PDF.length);
const patched = await api('/team/applications/' + REF, auth({ docs: [{ id: 'dl-front', filename: 'licence-front.pdf', req: true, path: up.body.path, mime: 'application/pdf', size: PDF.length }] }, 'PATCH'));
ok('and it is written onto the account', patched.status === 200 && byUser('AD800101').docs[0].id === 'dl-front', patched.body);
const view = await worker.fetch(new Request(`http://x/team/doc?ref=${REF}&id=dl-front`, { headers: { Authorization: 'Bearer ' + TOKEN } }), { SB_KEY: 'stub' }, { waitUntil: p => p });
ok('compliance can open it straight away, like any other document',
  view.status === 200 && Buffer.from(await view.arrayBuffer()).length === PDF.length, view.status);

/* a PIN set at the same time must not lock the team out of its own upload */
const withPin = await api('/team/applications', auth({ type: 'driver', username: 'PN800202', fname: 'Pia', lname: 'Nunn',
  phone: '07700900902', dob: '1980-02-02', status: 'pending', pinHash: sha('HAF-CP|PN800202|9911') }));
const upPin = await api(`/docs/file?ref=${withPin.body.ref}&id=mot&k=${sha('HAF-CP|PN800202|9911')}`,
  { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
ok('setting a PIN at the same time does not block the upload', upPin.status === 200, upPin.body);
const upWrong = await api(`/docs/file?ref=${withPin.body.ref}&id=mot&k=nonsense`,
  { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
ok('and nobody else can push a file onto that account', upWrong.status === 401, upWrong.status);

const upBad = await api(`/docs/file?ref=${REF}&id=mot&k=`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('hello') });
ok('a file type the store will not take is refused with a reason', upBad.status === 415, upBad.body);

/* ── 2. what Gemma actually does ── */
console.log('\nAdding a driver with their paperwork, in the portal');
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
async function signIn(page, user) {
  await page.goto(SITE + '/team.html');
  await page.waitForTimeout(250);
  if (await page.locator('#shell.show').count()) return;
  await page.fill('#gate-user', user);
  await page.fill('#gate-pw', PIN);
  await page.click('button.btn-full');
  await page.waitForSelector('#shell.show', { timeout: 5000 });
}
const modalClosed = (p, t) => p.waitForFunction(
  () => !document.getElementById('add-ov').classList.contains('open'), null, { timeout: t });
const watch = (p) => { p.on('pageerror', e => console.log('  [page error] ' + e.message));
  p.on('console', m => { if (m.type() === 'error') console.log('  [console] ' + m.text()); }); };
const fillDriver = async (p, fn, ln, ph, dob) => {
  await p.fill('#ad-fname', fn); await p.fill('#ad-lname', ln);
  await p.fill('#ad-phone', ph); await p.fill('#ad-dob', dob);
};

let ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
let page = await ctx.newPage();
watch(page);
await signIn(page, 'cleverg');
await page.click('.add-btn');
await page.waitForSelector('#add-ov.open', { timeout: 3000 });

ok('the documents section is on the add form', await page.locator('.add-docs').count() === 1);
ok('it starts closed, so the form is no longer to look at than before',
  await page.locator('#add-doc-rows').isVisible() === false);
ok('and it is clearly optional', /optional/i.test(await page.locator('.add-docs-head').innerText()));

await page.click('#add-docs-toggle');
await page.waitForTimeout(150);
const rowCount = await page.locator('#add-doc-rows .adr').count();
ok('opening it lists every document a driver needs',
  rowCount === LIVE_CONFIG.driver.docs.length, rowCount);
ok('required paperwork is marked as required',
  await page.locator('#add-doc-rows .adr-req').count() === LIVE_CONFIG.driver.docs.filter(d => d.status === 'required').length);

await page.setInputFiles('#adri-dl-front', F.dlFront.pathname);
await page.waitForTimeout(120);
ok('a chosen file is shown by name on its row', /licence-front\.pdf/.test(await page.locator('#adrf-dl-front').innerText()));
ok('and the button turns into Remove', (await page.locator('#adri-dl-front').locator('xpath=../button').innerText()) === 'Remove');
ok('the count is on the toggle so nothing is attached by accident',
  /1 attached/.test(await page.locator('#add-docs-toggle').innerText()));

await page.setInputFiles('#adri-h-r-ins', F.hrIns.pathname);
await page.setInputFiles('#adri-mot', F.noType.pathname);
await page.waitForTimeout(120);
ok('a phone photo with no file type of its own is still accepted',
  !/only/i.test(await page.locator('#adrf-mot').innerText()), await page.locator('#adrf-mot').innerText());
ok('three attached', /3 attached/.test(await page.locator('#add-docs-toggle').innerText()));

await page.setInputFiles('#adri-dbs', F.huge.pathname);
await page.waitForTimeout(150);
ok('a file too big for the store is refused before it is sent, in plain words',
  /Over 15MB/.test(await page.locator('#adrf-dbs').innerText()), await page.locator('#adrf-dbs').innerText());
ok('and it is not counted as attached', /3 attached/.test(await page.locator('#add-docs-toggle').innerText()));

await page.locator('#adri-h-r-ins').locator('xpath=../button').click();
await page.waitForTimeout(120);
ok('an attachment can be taken back off', /2 attached/.test(await page.locator('#add-docs-toggle').innerText()));
await page.setInputFiles('#adri-h-r-ins', F.hrIns.pathname);
await page.waitForTimeout(120);

await fillDriver(page, 'Gwen', 'Marsh', '07700900903', '1988-03-03');
await page.fill('#ad-email', 'gwen@example.invalid');
await page.selectOption('#ad-vtype', 'Luton');
await page.fill('#ad-vreg', 'gm19 haf');
await page.fill('#ad-pin', '4455');
await page.waitForTimeout(150);
ok('the HAF username still builds itself', (await page.locator('#add-uname').innerText()) === 'GM090388',
  await page.locator('#add-uname').innerText());
await page.screenshot({ path: SHOTS.pathname + 'add-docs-1280.png' });

/* the team can flip the portal to dark, so the section has to hold there too */
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await page.waitForTimeout(120);
await page.screenshot({ path: SHOTS.pathname + 'add-docs-dark-1280.png' });
ok('the document rows keep their outline in dark mode',
  await page.evaluate(() => {
    const r = document.querySelector('.adr'), b = document.querySelector('.adr-btn');
    const bw = (el) => parseFloat(getComputedStyle(el).borderTopWidth) > 0;
    return bw(r) && bw(b) && getComputedStyle(document.querySelector('.add-docs')).borderTopWidth !== '0px';
  }));
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

await page.click('#add-submit');
await modalClosed(page, 15000);
await page.waitForTimeout(600);
const gwen = byUser('GM090388');
ok('the driver is created', !!gwen, apps.map(a => a.username));
ok('with all three documents on the record', (gwen.docs || []).length === 3, gwen.docs);
ok('every one of them points at a file really held in the store',
  (gwen.docs || []).every(d => STORE.has(d.path)), (gwen.docs || []).map(d => d.path));
ok('the file names are the ones off the desk, not made up',
  (gwen.docs || []).map(d => d.filename).sort().join(',') === 'hire-and-reward.png,licence-front.pdf,photo-of-mot.heic',
  (gwen.docs || []).map(d => d.filename));
ok('the licence photo went in as a PDF and the MOT photo as an image',
  gwen.docs.find(d => d.id === 'dl-front').mime === 'application/pdf' && /^image\//.test(gwen.docs.find(d => d.id === 'mot').mime),
  gwen.docs.map(d => d.mime));
ok('each one records who attached it', (gwen.docs || []).every(d => d.added_by === 'cleverg'), gwen.docs.map(d => d.added_by));
ok('nothing is ticked as checked — attaching is not reviewing',
  (gwen.docs || []).every(d => d.checked === undefined || d.checked === false));
ok('the confirmation says the documents went on too',
  /3 documents attached/.test(await page.locator('#toast').innerText()), await page.locator('#toast').innerText());
ok('the PIN the team set is still what was saved', gwen.pin_hash === sha('HAF-CP|GM090388|4455'));

/* the whole point: compliance can see them without asking her for anything */
await page.evaluate(() => setView('cards'));   /* approved opens as a record list */
await page.waitForSelector('#card-' + gwen.ref, { timeout: 5000 });
await page.click('#head-' + gwen.ref);
await page.waitForSelector('#card-' + gwen.ref + '.expanded', { timeout: 3000 });
await page.waitForTimeout(250);
const rows = await page.locator('#card-' + gwen.ref + ' .doc-row').allInnerTexts();
ok('the queue shows the licence as uploaded, not missing',
  rows.some(t => /Driving licence — front/.test(t) && /uploaded/i.test(t)), rows);
ok('and it can be opened from there', await page.locator('#card-' + gwen.ref + ' .doc-open').count() >= 3);
await page.click('#card-' + gwen.ref + ' .doc-open');
await page.waitForTimeout(900);
ok('the document viewer really opens the file the team attached',
  await page.locator('#doc-ov.open').count() === 1 && await page.locator('#dv-body iframe, #dv-body img').count() === 1,
  await page.locator('#dv-body').innerText().catch(() => '?'));
ok('and it names the file the team put there',
  /licence-front\.pdf/.test(await page.locator('#dv-sub').innerText()), await page.locator('#dv-sub').innerText());
await page.screenshot({ path: SHOTS.pathname + 'add-docs-viewer-1280.png' });
await page.keyboard.press('Escape').catch(() => {});
await ctx.close();

/* ── 3. the forwarder list, and switching between them ── */
console.log('\nFreight forwarders get their own list');
ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
page = await ctx.newPage();
await signIn(page, 'cleverg');
await page.click('.add-btn');
await page.waitForSelector('#add-ov.open', { timeout: 3000 });
await page.click('#add-docs-toggle');
await page.setInputFiles('#adri-dl-front', F.dlFront.pathname);
await page.waitForTimeout(120);
await page.click('#at-freight');
await page.waitForTimeout(150);
ok('switching to a forwarder swaps the list to company paperwork',
  await page.locator('#adri-incorp').count() === 1 && await page.locator('#adri-dl-front').count() === 0);
ok('and a driver document picked by mistake does not follow it across',
  /Attach documents/.test(await page.locator('#add-docs-toggle').innerText()),
  await page.locator('#add-docs-toggle').innerText());
await page.setInputFiles('#adri-incorp', F.incorp.pathname);
await page.fill('#af-company', 'Marsh Freight Ltd');
await page.fill('#af-name', 'Gwen Marsh');
await page.fill('#af-phone', '07700900904');
await page.waitForTimeout(150);
await page.screenshot({ path: SHOTS.pathname + 'add-docs-freight-1280.png' });
await page.click('#add-submit');
await modalClosed(page, 15000);
await page.waitForTimeout(500);
const frt = apps.find(a => a.company === 'Marsh Freight Ltd');
ok('the forwarder is created with its certificate attached',
  !!frt && (frt.docs || []).length === 1 && frt.docs[0].id === 'incorp', frt && frt.docs);
ok('and the certificate is in the store', !!frt && STORE.has(frt.docs[0].path));
await ctx.close();

/* ── 4. nothing changed for the plain, no-documents add ── */
console.log('\nThe old way of adding still works untouched');
ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
page = await ctx.newPage();
await signIn(page, 'cleverg');
await page.click('.add-btn');
await page.waitForSelector('#add-ov.open', { timeout: 3000 });
await fillDriver(page, 'Rory', 'Kent', '07700900905', '1975-05-05');
await page.click('#add-submit');
await modalClosed(page, 10000);
await page.waitForTimeout(400);
const rory = byUser('RK090575');
ok('an account with no documents is added exactly as before', !!rory && (rory.docs || []).length === 0, rory && rory.docs);
ok('and the confirmation does not mention documents',
  !/document/i.test(await page.locator('#toast').innerText()), await page.locator('#toast').innerText());
ok('a duplicate is still refused',
  await (async () => { await page.click('.add-btn'); await fillDriver(page, 'Rory', 'Kent', '07700900905', '1975-05-05');
    await page.click('#add-submit'); await page.waitForTimeout(600);
    return /already exists/i.test(await page.locator('#add-err').innerText()); })());
await page.keyboard.press('Escape').catch(() => {});
await ctx.close();

/* ── 5. on a phone ── */
console.log('\nOn a phone');
ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
page = await ctx.newPage();
await signIn(page, 'cleverg');
await page.click('.add-btn');
await page.waitForSelector('#add-ov.open', { timeout: 3000 });
await page.click('#add-docs-toggle');
await page.waitForTimeout(150);
ok('the documents section is usable on a phone', await page.locator('#add-doc-rows').isVisible());
await page.setInputFiles('#adri-dl-front', F.dlFront.pathname);
await page.waitForTimeout(120);
const box = await page.locator('#add-doc-rows').boundingBox();
ok('and nothing runs off the side of the screen', box.width <= 390 && box.x >= 0, box);
ok('the attach button is still reachable',
  await page.locator('#adri-dl-front').locator('xpath=../button').isVisible());
await page.screenshot({ path: SHOTS.pathname + 'add-docs-390.png' });
await ctx.close();

await browser.close();
dbSrv.close(); siteSrv.close();
try { unlinkSync(tmp); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
