/* Proof for the driving record check: the three things a driver now gives us
   (licence number, DVLA check code, National Insurance number), what the
   compliance team sees, and the rules underneath. Real portal files, real
   worker module, stub database. Screenshots go to worker/_shots/.
   Run: node worker/test-dvla.mjs */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

/* the box has moved chromium build more than once — take whichever is installed */
const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const ROOT = new URL('../', import.meta.url);
const SHOTS = new URL('./_shots/', import.meta.url);
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const PIN = '1234';
const pw = (u) => sha('HAF-CP-TEAM|' + u + '|' + PIN);
const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));

const day = (n) => new Date(Date.now() - n * 864e5).toISOString();
const allDocs = (ref) => LIVE_CONFIG.driver.docs.filter(d => d.status === 'required')
  .map(d => ({ id: d.id, filename: d.id + '.pdf', size: 50000, path: ref + '/' + d.id }));

/* a real-shaped licence number: 5 name characters, 6 date digits, 2, 1 digit, 2 */
const LIC = 'MORGA657054SM9IJ';
const CODE = 'Ab12Cd34';   /* DVLA codes are case sensitive — this must survive as typed */
const NI = 'AB123456C';

const apps = [
  /* the everyday case: paperwork uploaded, record check still outstanding */
  { ref: 'HAF-CP-REC01', type: 'driver', username: 'RC900101', fname: 'Rita', lname: 'Chase',
    email: 'rec01@example.invalid', phone: '07700900801', dob: '1990-01-01', vtype: 'Small van',
    vreg: 'AB12 CDE', status: 'pending', email_verified: true, submitted: day(2), updated_at: day(2),
    pin_hash: sha('HAF-CP|RC900101|' + PIN), docs: allDocs('HAF-CP-REC01') },
  /* everything supplied, nobody has run the check yet */
  { ref: 'HAF-CP-REC02', type: 'driver', username: 'RC900202', fname: 'Ravi', lname: 'Coyle',
    email: 'rec02@example.invalid', phone: '07700900802', dob: '1990-02-02', vtype: 'Luton',
    vreg: 'CD34 EFG', status: 'reviewing', email_verified: true, submitted: day(3), updated_at: day(3),
    pin_hash: sha('HAF-CP|RC900202|' + PIN), docs: allDocs('HAF-CP-REC02'),
    dvla_licence_no: LIC, dvla_check_code: CODE, ni_number: NI, dvla_code_at: day(2) },
  /* a code supplied 25 days ago — dead, and nobody should be sent to GOV.UK with it */
  { ref: 'HAF-CP-REC03', type: 'driver', username: 'RC900303', fname: 'Rosa', lname: 'Kemp',
    email: 'rec03@example.invalid', phone: '07700900803', dob: '1990-03-03', vtype: 'MWB van',
    vreg: 'EF56 GHI', status: 'pending', email_verified: true, submitted: day(30), updated_at: day(30),
    pin_hash: sha('HAF-CP|RC900303|' + PIN), docs: allDocs('HAF-CP-REC03'),
    dvla_licence_no: LIC, dvla_check_code: 'Zz98Yy76', ni_number: NI, dvla_code_at: day(25) },
  /* signed up, nothing supplied — the card must say so rather than look complete */
  { ref: 'HAF-CP-REC04', type: 'driver', username: 'RC900404', fname: 'Remy', lname: 'Vale',
    email: 'rec04@example.invalid', phone: '07700900805', dob: '1990-04-04', vtype: 'Small van',
    vreg: 'GH78 IJK', status: 'pending', email_verified: true, submitted: day(1), updated_at: day(1),
    pin_hash: sha('HAF-CP|RC900404|' + PIN), docs: [] },
  /* a freight company has no driving record to check */
  { ref: 'HAF-CP-FRT99', type: 'freight', username: 'ZEBRA9999', company: 'Zebra Forwarding Ltd',
    crn: '12345678', name: 'Zoe Bright', title: 'Director', email: 'frt99@example.invalid',
    phone: '07700900804', status: 'pending', email_verified: true, submitted: day(1), updated_at: day(1),
    pin_hash: sha('HAF-CP|ZEBRA9999|' + PIN), docs: [] },
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
const find = (ref) => apps.find(a => a.ref === ref);

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
    const a = find(String(b.p_ref || '').toUpperCase());
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
await new Promise(r => dbSrv.listen(8798, r));

const swap = s => s
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8798/rest/v1');
const src = swap(readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8'));
const tmp = new URL('./_dvla-worker.mjs', import.meta.url);
writeFileSync(tmp, src);
const apiWorker = (await import(tmp.href)).default;
/* The back office runs as its own worker in production, reached over a private
   binding because a single script no longer fits the 20,000-character deploy
   pipe. The harness wires the two together the same way, so what is tested here
   is the same path a request takes live. */
const adminSrc = swap(readFileSync(new URL('./cleverpay-admin.js', import.meta.url), 'utf8'));
const atmp = new URL('./_dvla-admin.mjs', import.meta.url);
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
      if (name === 'team.js') f = f.replace("const SB_URL='https://jsdwvogsxlnczzbefwgp.supabase.co'", "const SB_URL='http://127.0.0.1:8798'");
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
const api = async (path, init = {}) => {
  const r = await worker.fetch(new Request('http://127.0.0.1:8799' + path, init), { SB_KEY: 'stub' }, { waitUntil: p => p });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};

/* ── 1. what the driver sends ── */
console.log('\nThe driver supplies the record check');
const pinOf = (u) => sha('HAF-CP|' + u + '|' + PIN);
const submit = (ref, user, dvla) => api('/docs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ref, pinHash: pinOf(user), docs: find(ref).docs, dvla }),
});

const badLic = await submit('HAF-CP-REC01', 'RC900101', { licence: 'NOTALICENCE', code: CODE, ni: NI });
ok('a licence number that cannot be real is refused, in plain words',
  badLic.status === 400 && /licence number/i.test(badLic.body.error), badLic.body);
const badCode = await submit('HAF-CP-REC01', 'RC900101', { licence: LIC, code: 'ABC', ni: NI });
ok('a check code of the wrong length is refused', badCode.status === 400 && /8 letters and numbers/i.test(badCode.body.error), badCode.body);
const badNi = await submit('HAF-CP-REC01', 'RC900101', { licence: LIC, code: CODE, ni: 'AB12X456C' });
ok('a National Insurance number that cannot be real is refused',
  badNi.status === 400 && /National Insurance/i.test(badNi.body.error), badNi.body);
ok('and nothing was written while it was wrong', !find('HAF-CP-REC01').dvla_check_code);

const good = await submit('HAF-CP-REC01', 'RC900101', { licence: 'morga657054sm9ij', code: CODE, ni: 'ab 12 34 56 c' });
const rec01 = find('HAF-CP-REC01');
ok('a good set is accepted', good.status === 200, good.body);
ok('the licence number is stored tidied and upper-cased', rec01.dvla_licence_no === LIC, rec01.dvla_licence_no);
ok('the National Insurance number is stored without spaces', rec01.ni_number === NI, rec01.ni_number);
ok('the check code keeps its capitals exactly as GOV.UK gave them', rec01.dvla_check_code === CODE, rec01.dvla_check_code);
ok('the day the code arrived is stamped, so its age can be shown',
  !!rec01.dvla_code_at && Date.now() - Date.parse(rec01.dvla_code_at) < 60000, rec01.dvla_code_at);
ok('the driver never sees the stored PIN come back', good.body && good.body.pin_hash === undefined);

/* ── 2. the chase asks for it ── */
console.log('\nThe chase knows a missing record check is missing compliance');
const login = await api('/team/login', { method: 'POST', body: JSON.stringify({ username: 'cleverg', password: PIN }) });
ok('compliance signs in', login.status === 200 && !!login.body.token, login.body);
const TOKEN = login.body.token;
const auth = (body, method = 'POST') => ({ method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

/* a driver with every file uploaded but no record check is still incomplete */
const bare = { ...rec01 };
rec01.dvla_licence_no = null; rec01.dvla_check_code = null; rec01.ni_number = null; rec01.dvla_code_at = null;
const chase = await api('/team/remind', auth({ ref: 'HAF-CP-REC01' }));
ok('files all in but no record check → there is still something to chase', chase.status === 200, chase.body);
ok('it asks for the licence number, the code and the NI number',
  ['Driving licence number', 'DVLA check code', 'National Insurance number'].every(n => chase.body.missing.includes(n)), chase.body.missing);
const chaseFrt = await api('/team/remind', auth({ ref: 'HAF-CP-FRT99' }));
ok('a freight company is never asked for a driving record',
  chaseFrt.status === 200 && !chaseFrt.body.missing.some(n =>
    ['Driving licence number', 'DVLA check code', 'National Insurance number'].includes(n)), chaseFrt.body.missing);
Object.assign(rec01, bare);   /* put the record back */

/* ── 3. the team side ── */
console.log('\nThe compliance team runs and records the check');
ok('no session → the check cannot be ticked',
  (await api('/team/dvla-check', { method: 'POST', body: JSON.stringify({ ref: 'HAF-CP-REC02' }) })).status === 401);
ok('no session → the values cannot be edited',
  (await api('/team/dvla', { method: 'PUT', body: JSON.stringify({ ref: 'HAF-CP-REC02' }) })).status === 401);

const noCode = await api('/team/dvla-check', auth({ ref: 'HAF-CP-FRT99' }));
ok('nothing to check yet → the tick is refused with a reason',
  noCode.status === 400 && /no check code/i.test(noCode.body.error), noCode.body);

const tick = await api('/team/dvla-check', auth({ ref: 'HAF-CP-REC02' }));
const rec02 = find('HAF-CP-REC02');
ok('the check is recorded', tick.status === 200 && !!rec02.dvla_checked_at, tick.body);
ok('with the name of the person who ran it', rec02.dvla_checked_by === 'cleverg', rec02.dvla_checked_by);

/* the driver comes back with a fresh code — the old confirmation cannot stand */
const refresh = await submit('HAF-CP-REC02', 'RC900202', { licence: LIC, code: 'Nw55Nw55', ni: NI });
ok('a new code is accepted', refresh.status === 200, refresh.body);
ok('a new code clears the old confirmation — nobody checked THIS record yet',
  rec02.dvla_checked_at === null && rec02.dvla_checked_by === null, [rec02.dvla_checked_at, rec02.dvla_checked_by]);
ok('and the new code is stamped with today', Date.now() - Date.parse(rec02.dvla_code_at) < 60000);

/* re-sending the SAME code must not reset the clock or wipe a valid check */
await api('/team/dvla-check', auth({ ref: 'HAF-CP-REC02' }));
const stampBefore = rec02.dvla_code_at;
await submit('HAF-CP-REC02', 'RC900202', { licence: LIC, code: 'Nw55Nw55', ni: NI });
ok('re-saving the same code leaves the check and its date alone',
  rec02.dvla_code_at === stampBefore && !!rec02.dvla_checked_at, [rec02.dvla_code_at, rec02.dvla_checked_at]);

/* The team corrects the driving record through the same Edit details panel as
   every other correction — /team/dvla was a second door onto the same three
   fields that no page ever opened, so it went when the worker was split. */
const fix = await api('/team/edit', auth({ ref: 'HAF-CP-REC01', dvla: { licence: LIC, code: 'Fx11Fx11', ni: NI } }));
ok('the team can correct a transposed digit for the driver', fix.status === 200 && find('HAF-CP-REC01').dvla_check_code === 'Fx11Fx11', fix.body);
const fixBad = await api('/team/edit', auth({ ref: 'HAF-CP-REC01', dvla: { licence: 'RUBBISH', code: CODE, ni: NI } }));
ok('but the team cannot save nonsense either', fixBad.status === 400, fixBad.body);

/* ── 4. the private partner API must not leak any of this ── */
console.log('\nNone of it reaches the partner API');
const mint = await api('/team/integration/key', auth({ label: 'proof' }));
const KEY = mint.body && mint.body.key;
ok('a key can be minted for the back-office API', mint.status === 200 && /^cpk_/.test(KEY || ''), mint.status);
const partner = await api('/partner/compliance', { headers: { 'X-API-Key': KEY } });
const first = partner.body && (partner.body.accounts || [])[0];
ok('the partner API answers', partner.status === 200 && !!first, partner.body);
const leaked = JSON.stringify(partner.body);
ok('no National Insurance number in it', !leaked.includes(NI));
ok('no licence number in it', !leaked.includes(LIC));
ok('no check code in it', !/Nw55Nw55|Fx11Fx11/.test(leaked));

/* ── 5. what the driver actually sees ── */
console.log('\nThe driver’s upload page');
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox'],
});
async function asApplicant(ctx, ref, username, type) {
  const page = await ctx.newPage();
  await page.goto(SITE + '/status.html');
  await page.evaluate(([ref, hash, type]) => {
    localStorage.setItem('cp_application', JSON.stringify({ ref, type, status: 'pending', pinHash: hash }));
  }, [ref, sha('HAF-CP|' + username + '|' + PIN), type]);
  await page.goto(SITE + '/docs.html');
  await page.waitForSelector('.doc-card', { timeout: 5000 });
  return page;
}

let ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
let page = await asApplicant(ctx, 'HAF-CP-REC01', 'RC900101', 'driver');
ok('the driver is asked for their driving record', await page.locator('#rec-check:visible').count() === 1);
ok('all three boxes are there', (await Promise.all(['lic', 'code', 'ni'].map(k => page.locator('#rc-' + k).count()))).every(n => n === 1));
ok('the GOV.UK page is one click away',
  (await page.locator('.rc-govlink').getAttribute('href')) === 'https://www.gov.uk/view-driving-licence');
ok('and it explains how to get the code', /Get a code to share your driving record/i.test(await page.locator('.rc-how').innerText()));
await page.fill('#rc-lic', 'not a licence');
await page.locator('#rc-code').click();
await page.waitForTimeout(150);
ok('a wrong licence number is called out before they submit',
  await page.locator('#err-rc-lic.show').count() === 1);
await page.screenshot({ path: SHOTS.pathname + 'dvla-driver-error-1280.png', fullPage: true });
ok('and the application cannot be submitted while it is wrong',
  await page.locator('#submit-btn').isDisabled());
await page.fill('#rc-lic', LIC); await page.fill('#rc-code', CODE); await page.fill('#rc-ni', NI);
await page.locator('#rc-lic').click();
await page.waitForTimeout(200);
ok('with all three right, the record check reads as done',
  await page.locator('#rc-block.rc-done').count() === 1 && await page.locator('.rc-err.show').count() === 0);
await page.screenshot({ path: SHOTS.pathname + 'dvla-driver-1280.png', fullPage: true });
await ctx.close();

ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
page = await asApplicant(ctx, 'HAF-CP-REC01', 'RC900101', 'driver');
ok('the record check is there on a phone too', await page.locator('#rec-check:visible').count() === 1);
await page.screenshot({ path: SHOTS.pathname + 'dvla-driver-390.png', fullPage: true });
await ctx.close();

ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
page = await asApplicant(ctx, 'HAF-CP-FRT99', 'ZEBRA9999', 'freight');
ok('a freight company is never shown it', await page.locator('#rec-check:visible').count() === 0);
await ctx.close();

/* ── 6. what Gemma sees ── */
console.log('\nThe compliance portal');
async function signIn(page, user) {
  await page.goto(SITE + '/team.html');
  await page.waitForTimeout(250);
  if (await page.locator('#shell.show').count()) return;
  await page.fill('#gate-user', user);
  await page.fill('#gate-pw', PIN);
  await page.click('button.btn-full');
  await page.waitForSelector('#shell.show', { timeout: 5000 });
}
const openCard = async (page, ref) => {
  await page.click(`#head-${ref}`);
  await page.waitForSelector(`#card-${ref}.expanded`, { timeout: 3000 });
};

for (const [w, h, tag] of [[1280, 1200, '1280'], [390, 900, '390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: h } });
  const p = await c.newPage();
  await signIn(p, 'cleverg');
  await p.waitForSelector('#card-HAF-CP-REC03', { timeout: 5000 });
  await openCard(p, 'HAF-CP-REC03');
  await p.waitForTimeout(200);
  const panel = p.locator('#card-HAF-CP-REC03 .rc-panel');
  ok('the record check panel is on the card at ' + tag + 'px', await panel.count() === 1);
  const txt = await panel.innerText();
  ok('the licence number is readable at ' + tag + 'px', txt.includes(LIC), txt);
  ok('the National Insurance number is masked until asked for, at ' + tag + 'px',
    txt.includes('AB••••••C') && !txt.includes(NI), txt);
  ok('GOV.UK is one click away at ' + tag + 'px',
    (await p.locator('#card-HAF-CP-REC03 .rc-actions a').getAttribute('href')) === 'https://www.gov.uk/view-driving-licence');
  await p.screenshot({ path: SHOTS.pathname + 'dvla-team-' + tag + '.png' });
  await c.close();
}

ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
page = await ctx.newPage();
await signIn(page, 'cleverg');
await page.waitForSelector('#card-HAF-CP-REC03', { timeout: 5000 });
await openCard(page, 'HAF-CP-REC03');
await page.waitForTimeout(200);
ok('a code past 21 days is shown as dead, not left to be discovered on GOV.UK',
  /Expired/i.test(await page.locator('#card-HAF-CP-REC03 .rc-age').innerText()));
await page.click('#card-HAF-CP-REC03 [id^="nibtn-"]');
await page.waitForTimeout(150);
ok('the NI number can be revealed when it is genuinely needed',
  (await page.locator('#ni-HAF-CP-REC03').innerText()) === NI);

await openCard(page, 'HAF-CP-REC04').catch(() => {});
await page.waitForTimeout(200);
const gapTxt = await page.locator('#card-HAF-CP-REC04 .rc-panel').innerText();
ok('an outstanding record check says so on the card', /Not supplied yet/.test(gapTxt), gapTxt);

/* ticking it from the portal, the way Gemma will */
find('HAF-CP-REC03').dvla_checked_at = null; find('HAF-CP-REC03').dvla_checked_by = null;
await page.reload();
await page.waitForSelector('#card-HAF-CP-REC03', { timeout: 5000 });
await openCard(page, 'HAF-CP-REC03');
await page.click('#card-HAF-CP-REC03 .rc-confirm');
await page.waitForTimeout(400);
ok('ticking it in the portal writes the check to the record',
  !!find('HAF-CP-REC03').dvla_checked_at && find('HAF-CP-REC03').dvla_checked_by === 'cleverg',
  find('HAF-CP-REC03').dvla_checked_by);
await openCard(page, 'HAF-CP-REC03').catch(() => {});
await page.waitForTimeout(200);
ok('and the card then shows who checked it',
  /Record checked by cleverg/.test(await page.locator('#card-HAF-CP-REC03 .rc-confirm').innerText()));
await page.screenshot({ path: SHOTS.pathname + 'dvla-team-checked-1280.png' });
await ctx.close();

await browser.close();
dbSrv.close(); siteSrv.close();
try { unlinkSync(tmp); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
