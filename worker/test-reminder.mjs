/* Proof for the document reminder: the button the team clicks on a pending record,
   and the rules behind it. Real portal files, real worker module, stub database.
   The sending run itself is proved by a live send, not here. Screenshots go to worker/_shots/.
   Run: node worker/test-reminder.mjs */
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

const day = (n) => new Date(Date.now() - n * 864e5).toISOString();
const hoursAgo = (n) => new Date(Date.now() - n * 3600e3).toISOString();

const apps = [
  /* the case this was built for: signed up, never uploaded anything */
  { ref: 'HAF-CP-NODOC', type: 'driver', username: 'ND990101', fname: 'Nadia', lname: 'Doherty',
    email: 'nodoc@example.invalid', phone: '07700900701', dob: '1990-01-01', vtype: 'Small van',
    vreg: 'AB12 CDE', status: 'pending', email_verified: true, submitted: day(6),
    updated_at: day(6), pin_hash: sha('HAF-CP|ND990101|' + PIN), docs: [] },
  /* half way there — the reminder must ask only for what is actually outstanding */
  { ref: 'HAF-CP-PART', type: 'driver', username: 'PT990101', fname: 'Paul', lname: 'Trent',
    email: 'part@example.invalid', phone: '07700900702', dob: '1990-01-01', vtype: 'Luton',
    vreg: 'CD34 EFG', status: 'reviewing', email_verified: true, submitted: day(4), updated_at: day(4),
    pin_hash: sha('HAF-CP|PT990101|' + PIN),
    docs: [{ id: 'dl-front', filename: 'front.jpg', size: 90000, path: 'HAF-CP-PART/dl-front' },
           { id: 'dl-back', filename: 'back.jpg', size: 88000, path: 'HAF-CP-PART/dl-back' },
           { id: 'mot', filename: 'mot.pdf', size: 120000, path: 'HAF-CP-PART/mot' }] },
  /* everything in — there is nothing to chase, so no button */
  { ref: 'HAF-CP-FULL', type: 'driver', username: 'FL990101', fname: 'Farrah', lname: 'Lowe',
    email: 'full@example.invalid', phone: '07700900703', dob: '1990-01-01', vtype: 'MWB van',
    vreg: 'EF56 GHI', status: 'pending', email_verified: true, submitted: day(3), updated_at: day(3),
    pin_hash: sha('HAF-CP|FL990101|' + PIN),
    dvla_licence_no: 'MORGA657054SM9IJ', dvla_check_code: 'Ab12Cd34', ni_number: 'AB123456C',
    dvla_code_at: day(1),
    docs: LIVE_CONFIG.driver.docs.filter(d => d.status === 'required')
      .map(d => ({ id: d.id, filename: d.id + '.pdf', size: 50000, path: 'HAF-CP-FULL/' + d.id })) },
  /* chased two hours ago — the day's chase is spent */
  { ref: 'HAF-CP-DONE', type: 'driver', username: 'DN990101', fname: 'Dexter', lname: 'Nunn',
    email: 'done@example.invalid', phone: '07700900704', dob: '1990-01-01', vtype: 'LWB van',
    vreg: 'GH78 IJK', status: 'pending', email_verified: true, submitted: day(9), updated_at: day(9),
    pin_hash: sha('HAF-CP|DN990101|' + PIN), docs: [],
    reminder_requested_at: hoursAgo(2), reminder_sent_at: hoursAgo(2), reminder_by: 'cleverg', reminder_count: 1 },
  /* chased three days ago and still nothing — it must be chaseable again */
  { ref: 'HAF-CP-STALE', type: 'freight', username: 'ZEBRA1234', company: 'Zebra Forwarding Ltd',
    crn: '12345678', name: 'Zoe Bright', title: 'Director', email: 'stale@example.invalid',
    phone: '07700900705', status: 'pending', email_verified: true, submitted: day(12), updated_at: day(12),
    pin_hash: sha('HAF-CP|ZEBRA1234|' + PIN), docs: [],
    reminder_requested_at: day(3), reminder_sent_at: day(3), reminder_by: 'bf638793', reminder_count: 1 },
  /* a business enquiry carries no compliance documents at all */
  { ref: 'HAF-CP-BIZ01', type: 'business', company: 'Acme Movers Ltd', name: 'Bill Business',
    email: 'biz@example.invalid', phone: '07700900706', status: 'enquiry',
    notes: 'Two pallets a week to Leeds', submitted: day(1), updated_at: day(1), docs: [] },
  /* no email address on file — nothing to send to */
  { ref: 'HAF-CP-NOML', type: 'driver', username: 'NM990101', fname: 'Nolan', lname: 'Mears',
    email: '', phone: '07700900707', dob: '1990-01-01', vtype: 'Small van', status: 'pending',
    email_verified: false, submitted: day(2), updated_at: day(2),
    pin_hash: sha('HAF-CP|NM990101|' + PIN), docs: [] },
];

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
    if (v === 'not.is.null') { if (row[k] == null) return false; continue; }
    if (v.startsWith('eq.') && String(row[k] ?? '') !== decodeURIComponent(v.slice(3))) return false;
  }
  return true;
}

const dbSrv = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const table = u.pathname.replace('/rest/v1/', '').split('?')[0];
  let body = ''; for await (const c of req) body += c;
  const rows = DB[table] || [];
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const send = (d, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(d)); };
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

const src = readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8796/rest/v1');
const tmp = new URL('./_rem-worker.mjs', import.meta.url);
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

/* ── 1. the rules, straight at the API ── */
console.log('\nAPI — who may be chased, and for what');
const api = async (path, init = {}) => {
  const r = await worker.fetch(new Request('http://127.0.0.1:8797' + path, init), { SB_KEY: 'stub' }, { waitUntil: p => p });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const login = await api('/team/login', { method: 'POST', body: JSON.stringify({ username: 'cleverg', password: PIN }) });
ok('compliance signs in', login.status === 200 && !!login.body.token, login.body);
const TOKEN = login.body.token;
const auth = (body, method = 'POST') => ({ method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

ok('no session → refused', (await api('/team/remind', { method: 'POST', body: JSON.stringify({ ref: 'HAF-CP-NODOC' }) })).status === 401);
ok('unknown reference → not found', (await api('/team/remind', auth({ ref: 'HAF-CP-XXXX' }))).status === 404);
const biz = await api('/team/remind', auth({ ref: 'HAF-CP-BIZ01' }));
ok('business enquiry → refused, no documents exist', biz.status === 400 && /do not have compliance/i.test(biz.body.error), biz.body);
const noml = await api('/team/remind', auth({ ref: 'HAF-CP-NOML' }));
ok('no email address → refused', noml.status === 400 && /email address/i.test(noml.body.error), noml.body);
const full = await api('/team/remind', auth({ ref: 'HAF-CP-FULL' }));
ok('everything uploaded → nothing to chase', full.status === 400 && /already in/i.test(full.body.error), full.body);
const done = await api('/team/remind', auth({ ref: 'HAF-CP-DONE' }));
ok('chased two hours ago → held until tomorrow', done.status === 429, done.body);

const REQ = LIVE_CONFIG.driver.docs.filter(d => d.status === 'required');
/* licence number, DVLA check code, National Insurance number — compliance, but not files */
const RECORD = 3;
const DRIVER_ITEMS = REQ.length + RECORD;
const first = await api('/team/remind', auth({ ref: 'HAF-CP-NODOC' }));
ok('never uploaded → reminder accepted', first.status === 200 && first.body.ok === true, first.body);
ok('asks for every required document and the driving record check',
  first.body.missing && first.body.missing.length === DRIVER_ITEMS, first.body.missing);
ok('records who sent it', apps[0].reminder_by === 'cleverg' && apps[0].reminder_count === 1, apps[0].reminder_by);

const part = await api('/team/remind', auth({ ref: 'HAF-CP-PART' }));
const partMissing = first.body.missing.length - 3;
ok('half-uploaded → asks only for what is outstanding',
  part.status === 200 && part.body.missing.length === partMissing, part.body.missing);
ok('never asks for a document already held',
  !part.body.missing.some(n => ['MOT certificate', 'Driving licence — front', 'Driving licence — back'].includes(n)),
  part.body.missing);

const stale = await api('/team/remind', auth({ ref: 'HAF-CP-STALE' }));
ok('chased three days ago → chaseable again', stale.status === 200, stale.body);
ok('freight gets the freight document list',
  stale.body.missing.includes('Certificate of Incorporation'), stale.body.missing);
ok('second click the same day → held', (await api('/team/remind', auth({ ref: 'HAF-CP-NODOC' }))).status === 429);

/* ── 2. what the reviewer actually sees and clicks ── */
console.log('\nThe portal');
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox'],
});
async function signIn(page) {
  await page.goto(SITE + '/team.html');
  await page.waitForTimeout(250);
  /* the portal remembers the session, so a reload lands straight in the shell */
  if (await page.locator('#shell.show').count()) return;
  await page.fill('#gate-user', 'cleverg');
  await page.fill('#gate-pw', PIN);
  await page.click('button.btn-full');
  await page.waitForSelector('#shell.show', { timeout: 5000 });
}
const openCard = async (page, ref) => {
  await page.click(`#head-${ref}`);
  await page.waitForSelector(`#card-${ref}.expanded`, { timeout: 3000 });
};

const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await signIn(page);
/* the pending tab is where the queue lives */
await page.waitForSelector('#card-HAF-CP-NOML', { timeout: 5000 });

await openCard(page, 'HAF-CP-NOML');
ok('no email address → no chase button offered',
  await page.locator('#card-HAF-CP-NOML .btn-remind').count() === 0);

await openCard(page, 'HAF-CP-FULL');
ok('nothing outstanding → no chase button offered',
  await page.locator('#card-HAF-CP-FULL .btn-remind').count() === 0);

await openCard(page, 'HAF-CP-DONE');
const spent = page.locator('#card-HAF-CP-DONE .action-bar button:disabled');
ok('already chased today → the button says so and cannot be clicked',
  await spent.count() === 1 && /Reminded today/.test(await spent.first().innerText()));

/* the record this was built for: pending, chased days ago, still nothing uploaded */
await openCard(page, 'HAF-CP-NODOC');
ok('outstanding paperwork → the chase button is on the card',
  await page.locator('#card-HAF-CP-NODOC .action-bar').count() === 1);
await page.close();

/* the reviewer's own record — reset so the click below is a real first chase */
const target = 'HAF-CP-NODOC';
apps[0].reminder_requested_at = null; apps[0].reminder_sent_at = null;
apps[0].reminder_by = null; apps[0].reminder_count = 0;

const shots = [];
for (const [w, h, tag] of [[1280, 1000, '1280'], [390, 844, '390']]) {
  const p2 = await browser.newPage({ viewport: { width: w, height: h } });
  await signIn(p2);
  await p2.waitForSelector('#card-' + target, { timeout: 5000 });
  await openCard(p2, target);
  await p2.waitForTimeout(200);
  ok('the chase button is offered at ' + tag + 'px',
    await p2.locator(`#card-${target} .btn-remind`).count() === 1);
  await p2.screenshot({ path: SHOTS.pathname + 'remind-actions-' + tag + '.png' });
  shots.push(tag);
  await p2.close();
}
ok('screenshots captured at desktop and phone widths', shots.length === 2);

/* the confirm step, end to end */
const p3 = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await signIn(p3);
await p3.waitForSelector('#card-' + target, { timeout: 5000 });
await openCard(p3, target);
await p3.click(`#card-${target} .btn-remind`);
await p3.waitForSelector('#rm-ov.open', { timeout: 3000 });
const listed = await p3.locator('#rm-list li').count();
ok('the confirm step lists the exact outstanding documents', listed === DRIVER_ITEMS, listed);
ok('the confirm step shows the address it will go to',
  (await p3.locator('#rm-email').innerText()) === 'nodoc@example.invalid');
await p3.screenshot({ path: SHOTS.pathname + 'remind-confirm-1280.png' });
await p3.click('#rm-go');
await p3.waitForFunction(() => !document.getElementById('rm-ov').classList.contains('open'), null, { timeout: 4000 });
const toast = await p3.locator('#toast').innerText();
ok('sending confirms where it went', /nodoc@example.invalid/.test(toast), toast);
ok('the record now shows it was reminded', !!apps[0].reminder_requested_at && apps[0].reminder_by === 'cleverg');
await openCard(p3, target).catch(() => {});
await p3.waitForTimeout(200);
ok('and the button will not fire twice',
  await p3.locator(`#card-${target} .btn-remind`).count() === 0);
await p3.screenshot({ path: SHOTS.pathname + 'remind-after-1280.png' });
await p3.close();

await browser.close();
dbSrv.close(); siteSrv.close();
try { unlinkSync(tmp); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
