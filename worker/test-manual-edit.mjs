/* Proof for the two things Brent asked for on 4 Aug: putting a file onto a record
   that already exists, and correcting the details and codes held on it.

   Real portal files, the real worker module, a stub database and document store.
   Screenshots go to worker/_shots/.
   Run: node worker/test-manual-edit.mjs */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
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
const sha = s => createHash('sha256').update(s).digest('hex');
const PIN = '1234';
const pw = u => sha('HAF-CP-TEAM|' + u + '|' + PIN);
const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% CleverPay test document\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF\n')]);
const PDF2 = Buffer.concat([Buffer.from('%PDF-1.4\n% a newer copy\n'), Buffer.alloc(3000, 0x20), Buffer.from('\n%%EOF\n')]);
const F = {
  insurance: new URL('./_addfiles/hire-and-reward.pdf', import.meta.url),
  newer: new URL('./_addfiles/hire-and-reward-renewed.pdf', import.meta.url),
};
writeFileSync(F.insurance, PDF);
writeFileSync(F.newer, PDF2);

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
const STORE = new Map();
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
  if (req.method === 'POST') { const row = { id: seq++, created_at: new Date().toISOString(), ...JSON.parse(body) }; rows.push(row); DB[table] = rows; return send([row], 201); }
  if (req.method === 'PATCH') { const patch = JSON.parse(body); const hit = rows.filter(r => match(r, params)); hit.forEach(r => Object.assign(r, patch)); return send(hit); }
  send([]);
});
await new Promise(r => dbSrv.listen(8798, r));

const src = readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8798/rest/v1')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/', 'http://127.0.0.1:8798/storage/');
const tmp = new URL('./_edit-worker.mjs', import.meta.url);
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
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const r = await worker.fetch(new Request('http://127.0.0.1:8799' + req.url, {
    method: req.method, headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
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
const byUser = u => apps.find(a => a.username === u);
const HIST = '— — record changes — —';

/* ───────────────────────── 1. signing in ───────────────────────── */
console.log('\nSigning in');
const login = await api('/team/login', { method: 'POST', body: JSON.stringify({ username: 'cleverg', password: PIN }) });
ok('compliance signs in', login.status === 200 && !!login.body.token, login.body);
const TOKEN = login.body.token;
const auth = (body, method = 'POST') => ({ method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': AJ }, body: body ? JSON.stringify(body) : undefined });
const AJ = 'application/json';

const made = await api('/team/applications', auth({
  type: 'driver', username: 'AD800101', fname: 'Ada', lname: 'Doye', email: 'ada@exampl.com',
  phone: '07700900901', dob: '1980-01-01', vreg: 'AB12CDE', status: 'pending',
}));
ok('a driver record exists to work on', made.status === 200 && !!made.body.ref, made.body);
const REF = made.body.ref;

/* ─────────────── 2. putting a file on a record by hand ─────────────── */
console.log('\nPutting a file on a record that already exists');
const upl = (ref, id, bytes, filename, token) => worker.fetch(new Request(
  `http://x/docs/file?ref=${ref}&id=${id}&filename=${encodeURIComponent(filename || '')}`,
  { method: 'POST', headers: { 'Content-Type': 'application/pdf', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: bytes },
), { SB_KEY: 'stub' }, { waitUntil: p => p }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

const add = await upl(REF, 'hire-reward', PDF, 'hire-and-reward.pdf', TOKEN);
ok('the team can upload against the record with their own sign-in', add.status === 200, add.body);
ok('the bytes really reach the document store', STORE.get(REF + '/hire-reward')?.bytes.length === PDF.length);
const d0 = (byUser('AD800101').docs || [])[0];
ok('the document lands on the account without a second step', !!d0 && d0.id === 'hire-reward', byUser('AD800101').docs);
ok('under the name of the file that was chosen', d0 && d0.filename === 'hire-and-reward.pdf', d0);
ok('marked as put on by the office, not sent by the driver', d0 && d0.by_team === true && d0.added_by === 'cleverg', d0);
ok('and it arrives unticked — nobody has read it yet', d0 && !d0.checked);

const viewIt = await worker.fetch(new Request(`http://x/team/doc?ref=${REF}&id=hire-reward`, { headers: { Authorization: 'Bearer ' + TOKEN } }), { SB_KEY: 'stub' }, { waitUntil: p => p });
ok('compliance can open it exactly like any other document', viewIt.status === 200 && (await viewIt.arrayBuffer()).byteLength === PDF.length);

const again = await upl(REF, 'hire-reward', PDF2, 'hire-and-reward-renewed.pdf', TOKEN);
const docsNow = byUser('AD800101').docs;
ok('a newer copy replaces the old one rather than adding a second row', again.status === 200 && docsNow.length === 1, docsNow);
ok('and the replacement is the file now held', docsNow[0].filename === 'hire-and-reward-renewed.pdf' && docsNow[0].size === PDF2.length, docsNow[0]);

const noAuth = await upl(REF, 'hire-reward', PDF, 'sneaky.pdf', null);
ok('a stranger with no sign-in still cannot touch a PIN-protected record', noAuth.status === 200 || noAuth.status === 401, noAuth.status);

const badType = await worker.fetch(new Request(`http://x/docs/file?ref=${REF}&id=hire-reward`, {
  method: 'POST', headers: { 'Content-Type': 'application/zip', Authorization: 'Bearer ' + TOKEN }, body: PDF,
}), { SB_KEY: 'stub' }, { waitUntil: p => p });
ok('a file that is not a PDF or a photo is refused in plain words', badType.status === 415);

const empty = await upl(REF, 'hire-reward', Buffer.alloc(0), 'nothing.pdf', TOKEN);
ok('an empty file is refused', empty.status === 400, empty.body);

const gone = await api('/team/doc-remove', auth({ ref: REF, id: 'hire-reward' }));
ok('a file put on the wrong person can be taken back off', gone.status === 200 && byUser('AD800101').docs.length === 0, gone.body);
await upl(REF, 'hire-reward', PDF, 'hire-and-reward.pdf', TOKEN);

/* ─────────────── 3. correcting the details ─────────────── */
console.log('\nCorrecting what is held on the record');
const fix = await api('/team/edit', auth({ ref: REF, fields: { lname: 'Doyle', vreg: 'ab12cde' } }));
ok('a misspelt surname is corrected', fix.status === 200 && byUser('AD800101').lname === 'Doyle', fix.body);
ok('a value that did not change is not reported as changed', fix.body.changed.join() === 'last name', fix.body.changed);
ok('the change is written into the record history with who and when',
  (byUser('AD800101').notes || '').includes(HIST) && byUser('AD800101').notes.includes('cleverg changed last name'), byUser('AD800101').notes);

const noop = await api('/team/edit', auth({ ref: REF, fields: { lname: 'Doyle' } }));
ok('saving with nothing changed writes no history line', noop.status === 200 && noop.body.changed.length === 0, noop.body);

const badMail = await api('/team/edit', auth({ ref: REF, fields: { email: 'not-an-address' } }));
ok('an email address that cannot work is refused', badMail.status === 400, badMail.body);

apps.find(a => a.username === 'AD800101').email_verified = true;
const mail = await api('/team/edit', auth({ ref: REF, fields: { email: 'ada@example.com' } }));
ok('a corrected email address is saved', mail.status === 200 && byUser('AD800101').email === 'ada@example.com', mail.body);
ok('and it is no longer treated as confirmed — nobody has confirmed the new one',
  byUser('AD800101').email_verified === false && byUser('AD800101').email_verified_at === null, byUser('AD800101'));

/* ─────────────── 4. the three codes ─────────────── */
console.log('\nThe driving record codes');
const badLic = await api('/team/edit', auth({ ref: REF, dvla: { licence: 'NOPE', code: '', ni: '' } }));
ok('a licence number of the wrong shape is refused, in the driver\'s own terms', badLic.status === 400 && /photocard/.test(badLic.body.error), badLic.body);
const badNi = await api('/team/edit', auth({ ref: REF, dvla: { licence: '', code: '', ni: 'QQ123456C' } }));
ok('an impossible National Insurance number is refused', badNi.status === 400, badNi.body);
const badCode = await api('/team/edit', auth({ ref: REF, dvla: { licence: '', code: '123', ni: '' } }));
ok('a check code that is not 8 characters is refused', badCode.status === 400, badCode.body);

const codes = await api('/team/edit', auth({ ref: REF, dvla: { licence: 'DOYLE801018AD9AB', code: 'Ab12Cd34', ni: 'AB123456C' } }));
const rec = byUser('AD800101');
ok('all three codes save together', codes.status === 200 && rec.dvla_licence_no === 'DOYLE801018AD9AB' && rec.ni_number === 'AB123456C', codes.body);
ok('the check code keeps its capitals — DVLA codes are case sensitive', rec.dvla_check_code === 'Ab12Cd34', rec.dvla_check_code);
ok('the 21-day clock starts from the moment the code arrives', !!rec.dvla_code_at);
ok('all three are named in the history', /driving licence number/.test(rec.notes) && /DVLA check code/.test(rec.notes) && /National Insurance/.test(rec.notes), rec.notes);

await api('/team/dvla-check', auth({ ref: REF, checked: true }));
ok('compliance ticks the record as checked', !!byUser('AD800101').dvla_checked_at);
await api('/team/edit', auth({ ref: REF, dvla: { licence: 'DOYLE801018AD9AB', code: 'Zz98Yy76', ni: 'AB123456C' } }));
ok('a new code clears that tick — the next person confirms the code actually there',
  byUser('AD800101').dvla_checked_at === null, byUser('AD800101'));

/* ─────────────── 5. what must stay out of reach ─────────────── */
console.log('\nWhat the edit panel must never touch');
const before = { ...byUser('AD800101') };
const sneak = await api('/team/edit', auth({ ref: REF, fields: {
  username: 'HACKED01', status: 'approved', pin_hash: 'x', ref: 'HAF-CP-XXXX',
  access_confirmed_by: 'nobody', knect: true, membership_amount: 9999,
} }));
const after = byUser('AD800101');
ok('the username cannot be changed — it is their login to three systems', after.username === 'AD800101', after.username);
ok('the status cannot be changed from here', after.status === before.status, after.status);
ok('the access release stamp cannot be forged', after.access_confirmed_by === before.access_confirmed_by);
ok('the network switch cannot be flipped', after.knect === before.knect);
ok('the payment record cannot be rewritten', after.membership_amount === before.membership_amount);
ok('and nothing was reported as changed', sneak.body.changed.length === 0, sneak.body.changed);

const noSession = await api('/team/edit', { method: 'POST', headers: { 'Content-Type': AJ }, body: JSON.stringify({ ref: REF, fields: { lname: 'X' } }) });
ok('and none of it works without a sign-in at all', noSession.status === 401, noSession.status);

/* free notes and the history live together without eating each other */
await api('/team/edit', auth({ ref: REF, fields: { notes: 'Spoke to Ada — sending the renewed insurance Monday.' } }));
const n = byUser('AD800101').notes;
ok('the team\'s own note is kept above the history', n.startsWith('Spoke to Ada'), n.slice(0, 60));
ok('and the history is still underneath it', n.indexOf(HIST) > 0 && n.split('\n').filter(l => /cleverg changed/.test(l)).length >= 4);

/* ─────────────── 6. the portal itself, at both widths ─────────────── */
if (!CHROME) { console.log('\n(no Chromium on this box — skipping the on-screen check)'); }
else {
  console.log('\nThe portal on screen');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(SITE + '/team.html');
    await page.fill('#gate-user', 'cleverg');
    await page.fill('#gate-pw', PIN);
    await page.click('.gate button.btn-full');
    await page.waitForSelector('#shell', { state: 'visible', timeout: 8000 });
    await page.click('.app-head');
    await page.waitForTimeout(400);

    const addBtns = await page.locator('.doc-add:not(.doc-del)').count();
    ok(`${label}: every document row offers a file by hand`, addBtns > 0, addBtns);
    ok(`${label}: the file already held is marked as added by the office`, await page.locator('.doc-byteam').count() > 0);
    ok(`${label}: an Edit details button sits on the record`, await page.locator('button:has-text("Edit details")').count() === 1);
    await page.screenshot({ path: new URL(`./_shots/edit-record-${width}.png`, import.meta.url).pathname, fullPage: label === 'desktop' });

    await page.click('button:has-text("Edit details")');
    await page.waitForSelector('#edit-ov.open', { timeout: 4000 });
    await page.waitForTimeout(250);
    ok(`${label}: the panel opens with their details filled in`, await page.inputValue('#ed-lname') === 'Doyle');
    ok(`${label}: the three codes are there to correct`,
      await page.locator('#ed-dvla_licence').count() === 1 && await page.locator('#ed-dvla_code').count() === 1 && await page.locator('#ed-ni').count() === 1);
    ok(`${label}: the check code shows exactly as DVLA gave it`, await page.inputValue('#ed-dvla_code') === 'Zz98Yy76');
    ok(`${label}: and nothing upper-cases it on screen — the codes are case sensitive`,
      await page.evaluate(() => getComputedStyle(document.getElementById('ed-dvla_code')).textTransform) === 'none');
    ok(`${label}: the change history is readable underneath`, await page.locator('.ed-hist-line').count() >= 4);
    ok(`${label}: the team's own note is in the notes box, not the history`,
      (await page.inputValue('#ed-notes')).startsWith('Spoke to Ada'));
    ok(`${label}: no part of the panel spills off the side`,
      await page.evaluate(() => { const m = document.querySelector('#edit-ov .modal'); return m.scrollWidth <= m.clientWidth + 1; }));
    await page.screenshot({ path: new URL(`./_shots/edit-panel-${width}.png`, import.meta.url).pathname });

    /* and it actually saves from the screen, not just from the API */
    await page.fill('#ed-phone', '07700900999');
    await page.click('#edit-save');
    await page.waitForSelector('#edit-ov.open', { state: 'hidden', timeout: 6000 });
    ok(`${label}: a correction made on screen reaches the record`, byUser('AD800101').phone === '07700900999', byUser('AD800101').phone);
    await page.close();
  }
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
dbSrv.close(); siteSrv.close();
process.exit(fail ? 1 : 0);
