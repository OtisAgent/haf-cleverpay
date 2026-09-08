/* Proof that the office can put a document on a record that already exists, and
   that the application then goes all the way through to released.

   Why this test exists: the Add file button on a document row posted to
   /team/doc-file. Nothing serves that path — /team/* is forwarded to the back
   office worker, which has no file door at all — so every press came back
   "Not found", the office could not attach paperwork that arrived by email or
   WhatsApp, and compliance had nothing to release against. The real door is
   /docs/file on the API worker, which has always taken both the applicant (PIN
   in `k`) and the team (their session in Authorization).

   Real portal files, real worker modules, stub database and store.
   Run: node worker/test-gemma-upload.mjs */
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
const TMPD = new URL('./_gemmafiles/', import.meta.url);
if (!existsSync(TMPD)) mkdirSync(TMPD, { recursive: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const PIN = '1234';
const pw = (u) => sha('HAF-CP-TEAM|' + u + '|' + PIN);
const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% CleverPay test document\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF\n')]);
const REQ_DOCS = LIVE_CONFIG.driver.docs.filter(d => d.status === 'required');
const files = REQ_DOCS.map(d => {
  const u = new URL('./_gemmafiles/' + d.id + '.pdf', import.meta.url);
  writeFileSync(u, PDF);
  return { ...d, path: u.pathname, name: d.id + '.pdf' };
});

/* ── the stub world: database, document store, both workers, the real site ── */
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
  journey_switch: [],
  haf_mail_log: [],
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
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8798/rest/v1')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/', 'http://127.0.0.1:8798/storage/');
const load = async (name, tmp) => {
  writeFileSync(new URL(tmp, import.meta.url), swap(readFileSync(new URL(name, import.meta.url), 'utf8')));
  return (await import(new URL(tmp, import.meta.url).href)).default;
};
const apiWorker = await load('./cleverpay-api.js', './_gemma-worker.mjs');
const adminWorker = await load('./cleverpay-admin.js', './_gemma-admin.mjs');
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

/* ── 1. an applicant who sent nothing — the person Gemma is chasing ── */
console.log('\nAn applicant with no paperwork');
const login = await api('/team/login', { method: 'POST', body: JSON.stringify({ username: 'cleverg', password: PIN }) });
ok('Gemma signs in to the back office', login.status === 200 && !!login.body.token, login.body);
const TOKEN = login.body.token;
const auth = (body, method = 'POST') => ({ method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

const made = await api('/team/applications', auth({ type: 'driver', username: 'RH850505', fname: 'Rae', lname: 'Holt',
  phone: '07700900955', dob: '1985-05-05', email: 'rae@example.invalid', status: 'pending' }));
ok('the application exists and is pending', made.status === 200 && made.body.status === 'pending', made.body);
const REF = made.body.ref;
ok('it holds no documents at all', (made.body.docs || []).length === 0);

/* ── 2. the control: released while the paperwork is missing is refused ──
   This is the guard from 14 Aug. It has to still hold, or the rest of this
   test would prove nothing about the upload mattering. */
const early = await api(`/team/applications/${REF}`, auth({ confirm_access: true }, 'PATCH'));
ok('release is refused while required paperwork is missing', early.status === 409, early);
ok('and it names what is missing, so the reviewer knows what to chase',
  REQ_DOCS.every(d => (early.body.error || '').includes(d.name)), early.body);

/* ── 3. the dead door — the negative control this whole fix turns on ──
   If this ever starts answering, the fix below has stopped being the reason
   uploads work and this test has quietly become vacuous. */
console.log('\nThe door that was being knocked on');
const deadPath = await worker.fetch(new Request(
  `http://127.0.0.1:8799/team/doc-file?ref=${REF}&id=dl-front&filename=x.pdf`,
  { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/pdf' }, body: PDF }),
  { SB_KEY: 'stub' }, { waitUntil: p => p });
ok('/team/doc-file is served by nothing and answers Not found', deadPath.status === 404, deadPath.status);

const clientSrc = readFileSync(new URL('../team-edit.js', import.meta.url), 'utf8');
/* the dead path is still named in the comment above the fix, deliberately, so
   nobody re-points it there — so this looks at what is fetched, not at prose */
ok('the portal no longer asks for it', !/CP_API\s*\+\s*'\/team\/doc-file/.test(clientSrc));
ok('the portal posts the file to /docs/file instead', /CP_API\s*\+\s*'\/docs\/file\?'/.test(clientSrc));

/* ── 4. Gemma puts the paperwork on the record, in the portal, by hand ── */
console.log('\nGemma attaches the paperwork in the portal');
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
const page = await ctx2.newPage();
page.on('pageerror', e => console.log('  [page error] ' + e.message));
page.on('console', m => { if (m.type() === 'error') console.log('  [console] ' + m.text()); });

await page.goto(SITE + '/team.html');
await page.waitForTimeout(250);
await page.fill('#gate-user', 'cleverg');
await page.fill('#gate-pw', PIN);
await page.click('button.btn-full');
await page.waitForSelector('#shell.show', { timeout: 5000 });
ok('the compliance queue opens', await page.locator('#shell.show').count() === 1);

/* open the record the same way a click on it does */
await page.evaluate((ref) => {
  if (typeof toggleCard === 'function') toggleCard(ref);
  else if (typeof toggleRow === 'function') toggleRow(ref);
}, REF);
await page.waitForTimeout(300);

const firstId = files[0].id;
ok('the row for a missing document offers Add file',
  await page.locator(`#drow-${REF}-${firstId} .doc-add`).count() >= 1);

for (const f of files) {
  await page.setInputFiles(`#upl-${REF}-${f.id}`, f.path);
  await page.waitForTimeout(400);
}
await page.waitForTimeout(400);

const saved = apps.find(a => a.ref === REF);
ok('every required document is now on the record',
  REQ_DOCS.every(d => (saved.docs || []).some(x => x.id === d.id)), (saved.docs || []).map(d => d.id));
ok('each one points at a file really held in the store',
  (saved.docs || []).length > 0 && (saved.docs || []).every(d => STORE.has(d.path)), (saved.docs || []).map(d => d.path));
ok('the file names are the ones off the desk, not invented',
  (saved.docs || []).every(d => d.filename.endsWith('.pdf')), (saved.docs || []).map(d => d.filename));
ok('the record says the office added it, not the driver',
  (saved.docs || []).every(d => d.by_team === true && d.added_by === 'cleverg'), (saved.docs || []).map(d => d.added_by));
ok('and it arrives unticked, because nobody has read it yet',
  (saved.docs || []).every(d => !d.checked), (saved.docs || []).map(d => d.checked));

ok('the portal shows the file on the row without a reload',
  /\.pdf/.test(await page.locator(`#drow-${REF}-${firstId} .doc-row-file`).innerText()),
  await page.locator(`#drow-${REF}-${firstId} .doc-row-file`).innerText());

/* ── 5. and now the application goes all the way through ── */
console.log('\nThe application completes');
const released = await api(`/team/applications/${REF}`, auth({ confirm_access: true }, 'PATCH'));
ok('release is accepted now the paperwork is there', released.status === 200, released);
ok('the record is approved and access is confirmed',
  released.body.status === 'approved' && !!released.body.access_confirmed_at, released.body);
ok('with the reviewer named against it', released.body.access_confirmed_by === 'cleverg', released.body);
ok('and the network flag is on, so PLNA and KNECT will let them in', released.body.knect === true, released.body);

await browser.close();
siteSrv.close(); dbSrv.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
