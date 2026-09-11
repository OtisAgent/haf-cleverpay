/* NOBODY STARTS THE SIGN-UP AFRESH.

   Brent, 11 Sep: "people are having to start a fresh". Three faults, one feeling:

     1. A document was stored but never written onto the record. Only POST /docs
        did that, and POST /docs runs on Submit and nowhere else. So somebody who
        uploaded four files and closed the tab had four files in the store and a
        record that said it had none — invisible to the portal, invisible to them.
     2. The account form held nothing until the Continue button.
     3. Logging back in with any document on the record sent them to the status
        page, with no way back to the list they were halfway through.

   Real worker module, stub database and store, real portal files in a real
   browser for the form half.

   Run: node worker/test-save-and-resume.mjs
*/
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
const TMPD = new URL('./_addfiles/', import.meta.url);
if (!existsSync(TMPD)) mkdirSync(TMPD, { recursive: true });
const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));

const sha = (s) => createHash('sha256').update(s).digest('hex');
/* the applicant's PIN is salted with their own username — get this wrong and every
   auth check in here passes for the wrong reason */
const pinHashFor = (user, pin) => sha('HAF-CP|' + user + '|' + pin);
const TEAM_PIN = '1234';
const teamPw = (u) => sha('HAF-CP-TEAM|' + u + '|' + TEAM_PIN);

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% CleverPay test document\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF\n')]);
const LICENCE = new URL('./_addfiles/resume-licence.pdf', import.meta.url);
writeFileSync(LICENCE, PDF);

const apps = [];
const DB = {
  cleverpay_portal_config: [{ id: 1, config: JSON.parse(JSON.stringify(LIVE_CONFIG)) }],
  cleverpay_applications: apps,
  cleverpay_team_users: [
    { username: 'cleverg', name: 'Gemma Vale', role: 'compliance', active: true, must_set_pin: false, pw_hash: teamPw('cleverg') },
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
    const p = decodeURIComponent(u.pathname.slice('/storage/'.length));
    if (req.method === 'GET') {
      const f = STORE.get(p);
      if (!f) { res.writeHead(404, CORS); return res.end('no'); }
      res.writeHead(200, { 'Content-Type': f.mime, ...CORS }); return res.end(f.bytes);
    }
    STORE.set(p, { bytes: raw, mime: (req.headers['content-type'] || '').split(';')[0] });
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ Key: p }));
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
await new Promise(r => dbSrv.listen(8798, r));

/* The specific addresses first, then the bare host LAST. cleverpay-admin.js holds
   `const HOST = 'https://…supabase.co'` with no /rest/v1 on it, so a swap that only
   rewrote the long forms left the back office talking to the real database — where
   it got a 401 and the harness read it as "the login is broken". A stub that is
   silently not being used is worse than no stub at all. */
const swap = s => s
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8798/rest/v1')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/', 'http://127.0.0.1:8798/storage/')
  .replaceAll('https://jsdwvogsxlnczzbefwgp.supabase.co', 'http://127.0.0.1:8798');
const tmp = new URL('./_resume-worker.mjs', import.meta.url);
writeFileSync(tmp, swap(readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8')));
const apiWorker = (await import(tmp.href)).default;
const atmp = new URL('./_resume-admin.mjs', import.meta.url);
writeFileSync(atmp, swap(readFileSync(new URL('./cleverpay-admin.js', import.meta.url), 'utf8')));
const adminWorker = (await import(atmp.href)).default;
const worker = { fetch: (req, env, ctx) => apiWorker.fetch(req,
  { ...env, ADMIN: { fetch: r => adminWorker.fetch(r, {}, ctx) } }, ctx) };

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };

const api = async (path, init = {}) => {
  const r = await worker.fetch(new Request('http://127.0.0.1:8799' + path, init), { SB_KEY: 'stub' }, { waitUntil: p => p });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const J = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const rec = (ref) => apps.find(a => a.ref === ref);

/* ══ 1. AN ACCOUNT IS BORN UNFINISHED ════════════════════════════════════════ */
console.log('\nAn account is born unfinished');
const USER = 'RS900101';
const PIN = '7788';
const applied = await api('/apply', J({
  type: 'driver', username: USER, pinHash: pinHashFor(USER, PIN),
  fname: 'Rae', lname: 'Shaw', email: 'rae@example.test', phone: '07700900222',
  dob: '1990-01-01', vtype: 'Small Van', vreg: 'RS12 SHW',
}));
ok('the account is created', applied.status === 200 && !!applied.body.ref, applied.body);
const REF = applied.body.ref;
ok('and it is a draft, not something the team is waiting on', rec(REF).status === 'draft', rec(REF) && rec(REF).status);
ok('the PIN hash never comes back to the browser', applied.body.pin_hash === undefined);

/* ══ 2. A DOCUMENT REACHES THE RECORD THE MOMENT IT IS UPLOADED ══════════════
   This is the fault the whole job is about. Before 11 Sep this assertion read
   zero, because the applicant branch returned before the record was patched. */
console.log('\nA document reaches the record the moment it is uploaded');
const upload = (id, filename, key = pinHashFor(USER, PIN), headers = {}) =>
  api(`/docs/file?ref=${REF}&id=${id}&k=${key}&filename=${encodeURIComponent(filename)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/pdf', ...headers }, body: PDF });

const u1 = await upload('licence_front', 'licence-front.pdf');
ok('the upload is accepted', u1.status === 200, u1.body);
ok('the file is in the document store', STORE.has(`${REF}/licence_front`));
ok('AND it is on the record — before anybody pressed Submit', (rec(REF).docs || []).length === 1, rec(REF).docs);
ok('the record names the file the person chose', (rec(REF).docs[0] || {}).filename === 'licence-front.pdf', rec(REF).docs[0]);
ok('an applicant upload is NOT marked as one the office added', !rec(REF).docs[0].by_team && !rec(REF).docs[0].added_by, rec(REF).docs[0]);
ok('the reply still carries what the page draws its tick from',
  u1.body.path === `${REF}/licence_front` && u1.body.mime === 'application/pdf' && u1.body.size > 0, u1.body);
ok('and the reply carries the record back, so a refresh agrees with it', !!u1.body.app && u1.body.app.docs.length === 1);
ok('the record it hands back still hides the PIN hash', u1.body.app.pin_hash === undefined);

const u2 = await upload('insurance', 'hire-and-reward.pdf');
ok('a second document is added, not swapped in', (rec(REF).docs || []).length === 2, rec(REF).docs.map(d => d.id));
const u3 = await upload('licence_front', 'licence-front-v2.pdf');
ok('re-uploading the same type replaces it rather than duplicating it', (rec(REF).docs || []).length === 2, rec(REF).docs.map(d => d.id));
ok('and the newer file is the one on the record',
  (rec(REF).docs.find(d => d.id === 'licence_front') || {}).filename === 'licence-front-v2.pdf',
  rec(REF).docs.find(d => d.id === 'licence_front'));
ok('uploading does not submit the application', rec(REF).status === 'draft', rec(REF).status);

/* the guard that was there before must still be there */
const stranger = await upload('mot', 'not-mine.pdf', 'deadbeef');
ok('somebody with the wrong PIN cannot put a file on this record', stranger.status === 401, stranger.status);
ok('and nothing of theirs reached the record', (rec(REF).docs || []).length === 2);

/* ══ 3. THEY COME BACK, AND THEIR WORK IS THERE ══════════════════════════════ */
console.log('\nThey come back, and their work is there');
const back = await api('/login', J({ id: USER, pin: PIN }));
ok('they can log back in', back.status === 200, back.status);
ok('their uploads come back with them', (back.body.docs || []).length === 2, (back.body.docs || []).length);
ok('and the record still says they have not submitted it', back.body.status === 'draft', back.body.status);

/* ══ 4. SUBMIT IS WHAT PUTS IT IN FRONT OF THE TEAM ══════════════════════════ */
console.log('\nSubmit is what puts it in front of the team');
const sub = await api('/docs', J({ ref: REF, pinHash: pinHashFor(USER, PIN), docs: [] }));
ok('the submission is accepted', sub.status === 200, sub.status);
ok('and NOW it is waiting on the team', rec(REF).status === 'pending', rec(REF).status);
ok('submitting nothing new did not wipe what was already there', (rec(REF).docs || []).length === 2, (rec(REF).docs || []).length);

/* A returning applicant replacing one file the team asked them to correct must
   not drag an approved account backwards into the queue. */
const APPROVED_USER = 'AP900101';
const ap = await api('/apply', J({ type: 'driver', username: APPROVED_USER, pinHash: pinHashFor(APPROVED_USER, PIN),
  fname: 'Ann', lname: 'Platt', email: 'ann@example.test', phone: '07700900333', dob: '1990-01-01',
  vtype: 'Small Van', vreg: 'AP12 PLT' }));
const AREF = ap.body.ref;
rec(AREF).status = 'approved';
await api('/docs', J({ ref: AREF, pinHash: pinHashFor(APPROVED_USER, PIN),
  docs: [{ id: 'insurance', filename: 'renewed.pdf', path: `${AREF}/insurance`, mime: 'application/pdf', size: 10 }] }));
ok('an approved account replacing a document stays approved', rec(AREF).status === 'approved', rec(AREF).status);

/* ══ 5. THE OFFICE'S OWN UPLOADS ARE STILL MARKED AS THEIRS ══════════════════ */
console.log("\nThe office's own uploads are still marked as theirs");
const tl = await api('/team/login', J({ username: 'cleverg', password: TEAM_PIN }));
ok('compliance signs in', tl.status === 200 && !!tl.body.token, tl.status);
const byTeam = await api(`/docs/file?ref=${REF}&id=mot&filename=posted-in.pdf`,
  { method: 'POST', headers: { 'Content-Type': 'application/pdf', Authorization: 'Bearer ' + tl.body.token }, body: PDF });
ok('the team can still put a file on a record', byTeam.status === 200, byTeam.body);
const mot = rec(REF).docs.find(d => d.id === 'mot');
ok('and it says who put it there', mot && mot.by_team === true && mot.added_by === 'cleverg', mot);

/* ══ 6. THE FORM ITSELF KEEPS WHAT THEY TYPED ════════════════════════════════ */
console.log('\nThe form itself keeps what they typed');
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml' };
const siteSrv = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const name = (p === '/' ? '/index.html' : p).slice(1);
  try {
    const ext = name.split('.').pop();
    let f = readFileSync(new URL(name, ROOT));
    if (name === 'api.js') f = Buffer.from(String(f).replace(/const CP_API = '[^']*'/, "const CP_API = ''"));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return res.end(f);
  } catch { res.writeHead(404); return res.end('nope'); }
});
await new Promise(r => siteSrv.listen(8800, r));
const SITE = 'http://127.0.0.1:8800';

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage();
page.on('pageerror', e => { fail++; console.log('  FAIL  page threw: ' + e.message); });

/* Nobody reaches this form cold — they arrive from join.usehaf.co.uk with a type
   already chosen, which is the journey that actually exists. */
const ARRIVE = `${SITE}/index.html?join=test-1234&type=driver&plan=driver_pro`;
let posted = null;
await page.route('**/apply', route => {
  posted = JSON.parse(route.request().postData() || '{}');
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ref: 'HAF-CP-DRAFT1', username: posted.username, status: 'draft', docs: [] }) });
});
await page.route('**/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

await page.goto(ARRIVE);
await page.waitForTimeout(450);
await page.fill('#d-fname', 'Rae');
await page.fill('#d-lname', 'Shaw');
await page.fill('#d-email', 'rae@example.test');
await page.fill('#d-phone', '07700900222');
await page.fill('#d-dob', '1990-01-01');
await page.fill('#d-vreg', 'RS12 SHW');
await page.fill('#d-pin', '7788');
await page.fill('#d-pin2', '7788');
await page.waitForTimeout(250);

const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('cp_signup_draft') || 'null'));
ok('what they typed is kept as they go', !!draft && draft.vals['d-fname'] === 'Rae', draft && draft.vals);
ok('their security PIN is NOT kept', !!draft && !Object.keys(draft.vals).some(k => /pin/i.test(k)), draft && Object.keys(draft.vals));

/* the walk-away: close the page entirely and come back to it */
await page.goto('about:blank');
await page.goto(ARRIVE);
await page.waitForTimeout(700);
ok('coming back puts them on their own form, not the account picker', await page.isVisible('#d-fname'));
ok('their name is still there', (await page.inputValue('#d-fname')) === 'Rae', await page.inputValue('#d-fname'));
ok('their email is still there', (await page.inputValue('#d-email')) === 'rae@example.test', await page.inputValue('#d-email'));
ok('their vehicle registration is still there', (await page.inputValue('#d-vreg')) === 'RS12 SHW', await page.inputValue('#d-vreg'));
ok('the PIN box is empty, so it has to be chosen again', (await page.inputValue('#d-pin')) === '', await page.inputValue('#d-pin'));
ok('and they are told what happened', await page.isVisible('#draft-note'));

/* a shared machine needs a way out */
await page.click('#draft-note a');
await page.waitForTimeout(600);
ok('"start again" empties it', await page.evaluate(() => localStorage.getItem('cp_signup_draft')) === null);

/* finishing the form clears it — the account holds those answers now */
await page.goto(ARRIVE);
await page.waitForTimeout(450);
await page.fill('#d-fname', 'Rae');
await page.fill('#d-lname', 'Shaw');
await page.fill('#d-email', 'rae@example.test');
await page.fill('#d-phone', '07700900222');
await page.fill('#d-dob', '1990-01-01');
await page.selectOption('#d-vtype', { index: 1 });
await page.fill('#d-vreg', 'RS12 SHW');
await page.fill('#d-pin', '7788');
await page.fill('#d-pin2', '7788');
await page.evaluate(() => { const t = document.getElementById('d-terms'); if (t) t.checked = true; });
await page.click('#driver-form button[type=submit]');
await page.waitForTimeout(500);
ok('the application is sent', !!posted, posted);
ok('and the kept copy is cleared once the account holds it',
  await page.evaluate(() => localStorage.getItem('cp_signup_draft')) === null);

await browser.close();
siteSrv.close(); dbSrv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
