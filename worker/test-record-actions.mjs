/* Proof for what Brent asked for on 4 Aug: "allow us to delete application off the
   portal or archive or clear and resend to the user".

   Real portal files, both real worker modules wired together the way they are in
   production, a stub database and document store. Screenshots go to worker/_shots/.
   Run: node worker/test-record-actions.mjs */
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
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
const sha = s => createHash('sha256').update(s).digest('hex');
const PIN = '1234';
const pw = u => sha('HAF-CP-TEAM|' + u + '|' + PIN);
const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));
const LIC = 'FORD9701104BF9AB', CODE = 'Ab12Cd34', NI = 'AB123456C';

const apps = [];
const DB = {
  cleverpay_portal_config: [{ id: 1, config: JSON.parse(JSON.stringify(LIVE_CONFIG)) }],
  cleverpay_applications: apps,
  cleverpay_team_users: [
    { username: 'bf638793', name: 'Brent Ford', role: 'admin', must_set_pin: false, pw_hash: pw('bf638793') },
    { username: 'cleverg', name: 'Gemma Vale', role: 'compliance', must_set_pin: false, pw_hash: pw('cleverg') },
    { username: 'sam', name: 'Sam Doyle', role: 'compliance', must_set_pin: false, pw_hash: pw('sam') },
  ],
  cleverpay_team_sessions: [],
  cleverpay_api_keys: [],
  cleverpay_farewells: [],
};
let FAIL_TABLE = null;
const STORE = new Map();
const TG = [];
let seq = 1;

/* the compliance group must never be reached for real from a test */
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const href = typeof input === 'string' ? input : input.url;
  if (href.includes('api.telegram.org')) {
    TG.push(JSON.parse(init.body));
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  }
  return realFetch(input, init);
};

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
    if (req.method === 'DELETE') {
      const had = STORE.delete(path);
      res.writeHead(had ? 200 : 404, { 'Content-Type': 'application/json', ...CORS });
      return res.end(JSON.stringify({ message: had ? 'deleted' : 'not found' }));
    }
    STORE.set(path, { bytes: raw, mime: (req.headers['content-type'] || '').split(';')[0] });
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ Key: path }));
  }

  const table = u.pathname.replace('/rest/v1/', '').split('?')[0];
  /* one table can be made to fail on demand, so the tests can ask what the
     portal does when the database is there but that write will not land */
  if (table === FAIL_TABLE) {
    res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ message: 'stub: this table is down' }));
  }
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
  if (req.method === 'DELETE') {
    const gone = rows.filter(r => match(r, params));
    DB[table] = rows.filter(r => !gone.includes(r));
    if (table === 'cleverpay_applications') { apps.length = 0; DB[table].forEach(r => apps.push(r)); DB[table] = apps; }
    return send(gone);
  }
  send([]);
});
await new Promise(r => dbSrv.listen(8796, r));

const swap = s => s
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8796/rest/v1')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/', 'http://127.0.0.1:8796/storage/');
const src = swap(readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8'));
const tmp = new URL('./_act-worker.mjs', import.meta.url);
writeFileSync(tmp, src);
const apiWorker = (await import(tmp.href)).default;
const adminSrc = swap(readFileSync(new URL('./cleverpay-admin.js', import.meta.url), 'utf8'));
const atmp = new URL('./_act-admin.mjs', import.meta.url);
writeFileSync(atmp, adminSrc);
const adminWorker = (await import(atmp.href)).default;
/* exactly the production wiring: the front door hands the back office the keys
   on the request, and holds the only copy of them */
const ENV = { SB_KEY: 'stub', TG_TOKEN: 'test-token', TG_CHAT: '-100999' };
const worker = { fetch: (req, env, ctx) => apiWorker.fetch(req,
  { ...ENV, ...env, ADMIN: { fetch: r => adminWorker.fetch(r, {}, ctx) } }, ctx) };

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
  const r = await worker.fetch(new Request('http://127.0.0.1:8797' + req.url, {
    method: req.method, headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
  }), {}, { waitUntil: p => p });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => siteSrv.listen(8797, r));
const SITE = 'http://127.0.0.1:8797';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };
/* What the press hands the mail engine on its way out. Since 14 August the
   applicant's notice is not written into a table for a later sweep to collect:
   the button names its moment on the response, and the engine in front of this
   worker sends it there and then. So what is checked below is that name, the
   address it carries, and — for a delete — the copy of the record that travels
   with it, because a moment later there is nothing left to read. */
const moment = (r) => {
  const ev = r.headers.get('x-cp-event');
  if (!ev) return null;
  let snap = null;
  try { const s = r.headers.get('x-cp-snap'); if (s) snap = JSON.parse(decodeURIComponent(s)); } catch { snap = null; }
  let item = '';
  try { item = decodeURIComponent(r.headers.get('x-cp-item') || ''); } catch { item = ''; }
  return { event: ev, ref: r.headers.get('x-cp-ref'), item, snap };
};
const api = async (path, init = {}) => {
  const r = await worker.fetch(new Request('http://127.0.0.1:8797' + path, init), {}, { waitUntil: p => p });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b, moment: moment(r) };
};
const find = ref => apps.find(a => a.ref === ref);
const HIST = '— — record changes — —';

const login = async (u) => (await api('/team/login', { method: 'POST', body: JSON.stringify({ username: u, password: PIN }) })).body.token;
const BRENT = await login('bf638793');
const SAM = await login('sam');
const auth = (body, token) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + (token || BRENT) }, body: JSON.stringify(body) });

/* ── the records under test ── */
function seed(ref, extra) {
  const row = {
    id: seq++, ref, type: 'driver', username: 'TS0000' + apps.length, fname: 'Tess', lname: 'Rider',
    email: 'tess@example.com', phone: '07700900000', status: 'pending', submitted: new Date().toISOString(),
    docs: [], notes: '', pin_hash: sha('pin'), ...extra,
  };
  apps.push(row);
  return row;
}
const withDocs = (ref) => {
  ['hire-reward', 'licence-front'].forEach(id => STORE.set(`${ref}/${id}`, { bytes: Buffer.from('%PDF-1.4 test'), mime: 'application/pdf' }));
  return [
    { id: 'hire-reward', filename: 'insurance.pdf', path: `${ref}/hire-reward`, mime: 'application/pdf', checked: true, checked_by: 'cleverg' },
    { id: 'licence-front', filename: 'licence.pdf', path: `${ref}/licence-front`, mime: 'application/pdf' },
  ];
};

console.log('\nArchive: off the list, and nothing else touched');
const A = seed('HAF-CP-ARCH1', { status: 'approved', knect: true, access_confirmed_at: '2026-08-01T09:00:00.000Z',
  access_confirmed_by: 'cleverg', approved_at: '2026-08-01T08:00:00.000Z', notes: 'Spoke to her on the phone.',
  docs: withDocs('HAF-CP-ARCH1') });

const arch = await api('/team/archive', auth({ ref: 'HAF-CP-ARCH1' }));
ok('the team can archive a record', arch.status === 200 && arch.body.app.archived === true, arch.body);
ok('the status is untouched — an approved account stays approved', find('HAF-CP-ARCH1').status === 'approved');
ok('their access is untouched — archiving is not a way to switch somebody off',
  find('HAF-CP-ARCH1').knect === true && !!find('HAF-CP-ARCH1').access_confirmed_at);
ok('the documents are untouched', find('HAF-CP-ARCH1').docs.length === 2 && STORE.has('HAF-CP-ARCH1/hire-reward'));
ok('who archived it, and when, is on the record', /· bf638793 archived this application/.test(find('HAF-CP-ARCH1').notes));
ok("the team's own note is still above the history", find('HAF-CP-ARCH1').notes.split(HIST)[0].includes('Spoke to her on the phone.'));

const again = await api('/team/archive', auth({ ref: 'HAF-CP-ARCH1' }));
ok('archiving twice changes nothing and says so', again.status === 200 && again.body.changed === false, again.body);

const list1 = await api('/team/applications', { headers: { Authorization: 'Bearer ' + BRENT } });
ok('the list marks it as archived so the portal can hide it',
  list1.body.find(a => a.ref === 'HAF-CP-ARCH1').archived === true);
ok('and does not mark the others', list1.body.filter(a => a.archived).length === 1);

const back = await api('/team/archive', auth({ ref: 'HAF-CP-ARCH1', archived: false }));
ok('it can be put back', back.status === 200 && back.body.app.archived === false, back.body);
ok('and the restore is on the record too', /· bf638793 restored this application/.test(find('HAF-CP-ARCH1').notes));
await api('/team/archive', auth({ ref: 'HAF-CP-ARCH1' }));
ok('archiving after a restore archives again', find('HAF-CP-ARCH1').notes.trimEnd().endsWith('archived this application'));

/* a correction must still work on an archived record — it is a filed record, not a locked one */
const editArch = await api('/team/edit', auth({ ref: 'HAF-CP-ARCH1', fields: { phone: '07700900999' } }));
ok('an archived record can still be corrected', editArch.status === 200 && find('HAF-CP-ARCH1').phone === '07700900999');
ok('and correcting it does not un-archive it', editArch.body.app.archived === true);

console.log('\nClear and send back: everything they sent, gone, and the email queued');
const C = seed('HAF-CP-CLR01', { status: 'approved', knect: true, docs: withDocs('HAF-CP-CLR01'),
  approved_at: '2026-08-01T08:00:00.000Z', approved_by: 'cleverg',
  access_confirmed_at: '2026-08-01T09:00:00.000Z', access_confirmed_by: 'cleverg',
  dvla_licence_no: LIC, dvla_check_code: CODE, ni_number: NI,
  dvla_code_at: '2026-08-01T08:00:00.000Z', dvla_checked_at: '2026-08-01T08:30:00.000Z', dvla_checked_by: 'cleverg',
  notes: 'Sent the wrong documents twice.' });

const clr = await api('/team/clear', auth({ ref: 'HAF-CP-CLR01' }));
const c1 = find('HAF-CP-CLR01');
ok('the clear is accepted', clr.status === 200 && clr.body.ok === true, clr.body);
ok('every document is off the record', Array.isArray(c1.docs) && c1.docs.length === 0);
ok('and the files are out of the private bucket',
  !STORE.has('HAF-CP-CLR01/hire-reward') && !STORE.has('HAF-CP-CLR01/licence-front'));
ok('the driving record is cleared', !c1.dvla_licence_no && !c1.dvla_check_code && !c1.ni_number);
ok('and so is the check somebody ran against it', !c1.dvla_checked_at && !c1.dvla_checked_by && !c1.dvla_code_at);
ok('the account is back to pending', c1.status === 'pending');
ok('the approval and release stamps are cleared',
  !c1.approved_at && !c1.approved_by && !c1.access_confirmed_at && !c1.access_confirmed_by);
ok('network access goes off with the evidence for it', c1.knect === false);
ok('their login survives — they need it to come back in', !!c1.pin_hash && !!c1.username);
ok('the email is queued, not sent from here', !!c1.reminder_requested_at && !c1.reminder_sent_at);
ok('and it asks for everything, because everything is now outstanding',
  Array.isArray(c1.reminder_docs) && c1.reminder_docs.length >= 3 && clr.body.emailed === true);
ok('the chase names the driving-record items too, not just files',
  c1.reminder_docs.some(d => /check code/i.test(d.name)) && c1.reminder_docs.some(d => /National Insurance/i.test(d.name)));
ok('who cleared it is on the record', /· bf638793 cleared this application and sent it back/.test(c1.notes));
ok("and the team's note above the history survived", c1.notes.split(HIST)[0].includes('Sent the wrong documents twice.'));

const noMail = seed('HAF-CP-CLR02', { docs: withDocs('HAF-CP-CLR02'), reminder_opt_out: true });
const clr2 = await api('/team/clear', auth({ ref: 'HAF-CP-CLR02' }));
ok('an applicant who opted out is still cleared', clr2.status === 200 && find('HAF-CP-CLR02').docs.length === 0);
ok('but the portal is told plainly that no email went', clr2.body.emailed === false && !find('HAF-CP-CLR02').reminder_requested_at, clr2.body);

seed('HAF-CP-CLR03', { type: 'business', company: 'Acme Ltd', email: 'ops@acme.test' });
const clr3 = await api('/team/clear', auth({ ref: 'HAF-CP-CLR03' }));
ok('a business enquiry has nothing to clear and is refused', clr3.status === 400, clr3.body);
seed('HAF-CP-CLR04', { email: null });
const clr4 = await api('/team/clear', auth({ ref: 'HAF-CP-CLR04' }));
ok('an application with no email cannot be sent back', clr4.status === 400, clr4.body);
const clr5 = await api('/team/clear', auth({ ref: 'HAF-CP-NOPE9' }));
ok('an unknown reference is a plain not-found', clr5.status === 404, clr5.body);

console.log('\nDelete: only two people, only on purpose');
const D = seed('HAF-CP-DEL01', { fname: 'Gone', lname: 'Soon', docs: withDocs('HAF-CP-DEL01') });

const bySam = await api('/team/delete', auth({ ref: 'HAF-CP-DEL01', confirm: 'HAF-CP-DEL01' }, SAM));
ok('a reviewer who is not Brent or the compliance lead is refused', bySam.status === 403, bySam.status);
ok('and told what to do instead', /[Aa]rchive it instead/.test(bySam.body.error || ''), bySam.body);
ok('nothing was deleted', !!find('HAF-CP-DEL01') && STORE.has('HAF-CP-DEL01/hire-reward'));

const noType = await api('/team/delete', auth({ ref: 'HAF-CP-DEL01' }));
ok('Brent without typing the reference is refused', noType.status === 400, noType.body);
const wrongType = await api('/team/delete', auth({ ref: 'HAF-CP-DEL01', confirm: 'HAF-CP-DEL02' }));
ok('and typing the wrong reference is refused', wrongType.status === 400, wrongType.body);
ok('still nothing deleted', !!find('HAF-CP-DEL01'));

const del = await api('/team/delete', auth({ ref: 'HAF-CP-DEL01', confirm: 'haf-cp-del01' }));
ok('typed out, in any case, it goes', del.status === 200 && del.body.ok === true, del.body);
ok('the record is gone from the table', !find('HAF-CP-DEL01'));
ok('the documents are gone from the bucket too',
  !STORE.has('HAF-CP-DEL01/hire-reward') && !STORE.has('HAF-CP-DEL01/licence-front'));
ok('the compliance group was told, with the name and who did it',
  TG.length === 1 && /HAF-CP-DEL01/.test(TG[0].text) && /Gone Soon/.test(TG[0].text) && /bf638793/.test(TG[0].text), TG[0]);
const after = await api('/team/applications', { headers: { Authorization: 'Bearer ' + BRENT } });
ok('and it is not in the queue any more', !after.body.some(a => a.ref === 'HAF-CP-DEL01'));
const delGone = await api('/team/delete', auth({ ref: 'HAF-CP-DEL01', confirm: 'HAF-CP-DEL01' }));
ok('deleting it a second time is a plain not-found', delGone.status === 404, delGone.status);

console.log('\nThe back office is reachable only through the front door');
const direct = await adminWorker.fetch(new Request('http://x/team/applications', {
  headers: { Authorization: 'Bearer ' + BRENT } }), {}, { waitUntil: p => p });
ok('without the key on the request the back office answers nothing', direct.status === 503, direct.status);
const noSession = await api('/team/archive', { method: 'POST', body: JSON.stringify({ ref: 'HAF-CP-ARCH1' }) });
ok('and a caller with no session gets nowhere', noSession.status === 401, noSession.status);

/* ── the portal on screen ── */
if (!CHROME) { console.log('\n(no chromium on this box — screen checks skipped)'); }
else {
  console.log('\nThe portal on screen');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', e => { fail++; console.log('  FAIL  ' + label + ': a script error on the page → ' + e.message); });
    await page.goto(SITE + '/team.html');
    await page.fill('#gate-user', 'bf638793');
    await page.fill('#gate-pw', PIN);
    await page.click('.gate button.btn-full');
    await page.waitForSelector('.tab-bar', { timeout: 8000 });
    await page.waitForTimeout(600);

    ok(`${label}: there is an Archived tab`, await page.locator('#tab-archived').count() === 1);
    /* the working tabs must not show what somebody has filed away */
    await page.click('#tab-all');
    await page.waitForTimeout(400);
    const allText = await page.locator('#main-content').innerText();
    ok(`${label}: an archived record is out of the working tabs`, !allText.includes('HAF-CP-ARCH1'), allText.slice(0, 200));
    await page.click('#tab-archived');
    await page.waitForTimeout(400);
    const archText = await page.locator('#main-content').innerText();
    ok(`${label}: and it is in Archived`, archText.includes('HAF-CP-ARCH1'), archText.slice(0, 200));
    /* Not a fixed number: the desktop pass archives a record of its own before the
       phone pass runs, so the only honest expectation is what the back office says
       is archived at this moment. */
    const tcArch = (await page.locator('#tc-archived').innerText()).trim();
    const trueArch = String((await api('/team/applications',
      { headers: { Authorization: 'Bearer ' + BRENT } })).body.filter(a => a.archived).length);
    ok(`${label}: the tab counts what is in there`, tcArch === trueArch, `tab said "${tcArch}", back office says "${trueArch}"`);

    /* open the record and read the manage row */
    await page.click('#tab-pending');
    await page.waitForTimeout(400);
    const card = page.locator('.app-card').filter({ hasText: 'HAF-CP-CLR01' }).first();
    await card.click();
    await page.waitForTimeout(500);
    const cardText = await card.innerText();
    ok(`${label}: the record offers Archive`, cardText.includes('Archive'), cardText.slice(-300));
    ok(`${label}: the record offers Clear & send back`, /Clear & send back/.test(cardText));
    ok(`${label}: Brent is offered Delete`, cardText.includes('Delete'));

    await card.getByRole('button', { name: /Clear & send back/ }).click();
    await page.waitForSelector('#cl-ov.open', { timeout: 4000 });
    const clText = await page.locator('#cl-ov .modal').innerText();
    ok(`${label}: the clear box says the files are deleted`, /delete the files/.test(clText), clText.slice(0, 300));
    ok(`${label}: it says the codes go`, /DVLA check code/.test(clText));
    ok(`${label}: it says they are emailed`, /tess@example\.com/.test(clText));
    ok(`${label}: and it offers archive as the softer option`, /archive it instead/i.test(clText));
    const clBox = await page.locator('#cl-ov .modal').boundingBox();
    ok(`${label}: the clear box fits the screen`, clBox.x >= 0 && clBox.x + clBox.width <= width + 1, clBox);
    await page.screenshot({ path: new URL(`./actions-clear-${width}.png`, SHOTS).pathname });
    await page.click('#cl-ov .mbt-gh');
    await page.waitForTimeout(300);

    await card.getByRole('button', { name: /^Delete$/ }).click();
    await page.waitForSelector('#dl-ov.open', { timeout: 4000 });
    ok(`${label}: delete will not fire until the reference is typed`, await page.locator('#dl-go').isDisabled());
    await page.fill('#dl-confirm', 'HAF-CP-WRONG');
    await page.waitForTimeout(150);
    ok(`${label}: and not for the wrong one either`, await page.locator('#dl-go').isDisabled());
    await page.fill('#dl-confirm', 'HAF-CP-CLR01');
    await page.waitForTimeout(150);
    ok(`${label}: typed correctly, the button wakes up`, !(await page.locator('#dl-go').isDisabled()));
    const dlBox = await page.locator('#dl-ov .modal').boundingBox();
    ok(`${label}: the delete box fits the screen`, dlBox.x >= 0 && dlBox.x + dlBox.width <= width + 1, dlBox);
    await page.screenshot({ path: new URL(`./actions-delete-${width}.png`, SHOTS).pathname });
    await page.click('#dl-ov .mbt-gh');
    await page.waitForTimeout(300);

    /* the real press, from the screen, on a record made for it */
    const target = 'HAF-CP-SCR' + (label === 'desktop' ? '1' : '2');
    seed(target, { fname: 'Screen', lname: 'Test' });
    await page.click('#tab-all'); await page.waitForTimeout(200);
    await page.click('#tab-pending'); await page.waitForTimeout(200);
    await page.evaluate(() => loadQueue());
    await page.waitForTimeout(500);
    const t = page.locator('.app-card').filter({ hasText: target }).first();
    await t.click();
    await page.waitForTimeout(400);
    await t.getByRole('button', { name: /^Archive$/ }).click();
    await page.waitForTimeout(600);
    ok(`${label}: archiving from the screen reaches the record`, /archived this application/.test(find(target).notes || ''), find(target).notes);
    const pendText = await page.locator('#main-content').innerText();
    ok(`${label}: and it leaves the working tab straight away`, !pendText.includes(target));

    await page.close();
  }

  /* somebody who may not delete must not be shown the button */
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page2.goto(SITE + '/team.html');
  await page2.fill('#gate-user', 'sam'); await page2.fill('#gate-pw', PIN);
  await page2.click('.gate button.btn-full');
  await page2.waitForSelector('.tab-bar', { timeout: 8000 });
  await page2.waitForTimeout(600);
  const c2 = page2.locator('.app-card').filter({ hasText: 'HAF-CP-CLR01' }).first();
  await c2.click();
  await page2.waitForTimeout(500);
  const samText = await c2.innerText();
  ok('a reviewer without the right sees no Delete button', !/Delete/.test(samText), samText.slice(-260));
  ok('but still sees Archive and Clear', /Archive/.test(samText) && /Clear & send back/.test(samText));
  await page2.close();
  await browser.close();
}

/* ── Brent, 4 Aug: "it needs a trigger building on the buttons for the
   notification to the users / applicants", and 14 Aug: "within 10 seconds of
   the action being completed" ──
   Until 14 August the portal wrote the applicant's notice into a table and an
   engine collected it on its next pass. It does not any more: the press names
   its moment on the way out and the mail engine in front of this worker sends
   it there and then. So the promise being checked here has moved — from "it is
   written down where something will find it" to "it is named, addressed, and
   for a delete it carries a copy of the record, because a moment later there
   is nothing left to read." The sending itself is proven separately, against a
   real template and a stubbed Mandrill, in test-instant-send.mjs. */
console.log('\nThe buttons tell the applicant');

seed('HAF-CP-NOTE1', { fname: 'Ade', email: 'ade@example.com' });
const silent = await api('/team/archive', auth({ ref: 'HAF-CP-NOTE1' }));
ok('archiving on its own emails nobody', silent.status === 200 && silent.body.emailed === false && silent.moment === null, silent.moment);

const telling = await api('/team/archive', auth({ ref: 'HAF-CP-NOTE1', archived: true, notify: true }));
ok('the on-hold notice can be sent for a record already archived',
  telling.status === 200 && telling.body.emailed === true && telling.body.email === 'ade@example.com', telling.body);
ok('and it leaves named as the application-cancelled moment, with their reference',
  telling.moment && telling.moment.event === 'compliance_application_cancelled'
  && telling.moment.ref === 'HAF-CP-NOTE1', telling.moment);
ok('and the press is still recorded against whoever made it',
  /bf638793/.test(find('HAF-CP-NOTE1').notes), find('HAF-CP-NOTE1').notes.slice(-160));

seed('HAF-CP-NOTE2', { fname: 'Ola', email: 'ola@example.com', reminder_opt_out: true });
const optedOut = await api('/team/archive', auth({ ref: 'HAF-CP-NOTE2', notify: true }));
ok('somebody who asked not to be emailed is not emailed',
  optedOut.status === 200 && optedOut.body.emailed === false && optedOut.moment === null, optedOut.moment);

seed('HAF-CP-NOTE3', { fname: 'Priya', email: 'priya@example.com', blocked_at: '2026-08-01T00:00:00.000Z' });
const blocked = await api('/team/archive', auth({ ref: 'HAF-CP-NOTE3', notify: true }));
ok('a blocked applicant is not emailed either',
  blocked.status === 200 && blocked.body.emailed === false && blocked.moment === null, blocked.moment);

seed('HAF-CP-NOTE4', { fname: 'Wes', email: 'wes@example.com', docs: withDocs('HAF-CP-NOTE4') });
const killed = await api('/team/delete', auth({ ref: 'HAF-CP-NOTE4', confirm: 'HAF-CP-NOTE4' }));
ok('deleting tells the applicant it is closed',
  killed.status === 200 && killed.body.emailed === true && killed.body.email === 'wes@example.com', killed.body);
const closed = killed.moment;
ok('the closure leaves named, with the address the record held',
  closed && closed.event === 'compliance_application_cancelled'
  && closed.ref === 'HAF-CP-NOTE4' && closed.snap && closed.snap.email === 'wes@example.com', closed);
ok('and it survives the record it came from', !apps.some(a => a.ref === 'HAF-CP-NOTE4'), apps.map(a => a.ref));
ok('the compliance group is told the applicant was emailed',
  /has been emailed to say it is closed/.test(TG[TG.length - 1].text), TG[TG.length - 1].text);

seed('HAF-CP-NOTE5', { fname: 'Ivy', email: 'ivy@example.com', reminder_opt_out: true });
const quietKill = await api('/team/delete', auth({ ref: 'HAF-CP-NOTE5', confirm: 'HAF-CP-NOTE5' }));
ok('an opted-out applicant is still deleted, just not emailed',
  quietKill.status === 200 && quietKill.body.emailed === false
  && !apps.some(a => a.ref === 'HAF-CP-NOTE5'), quietKill.body);
ok('and the compliance group is told plainly that nobody was written to',
  /has NOT been emailed/.test(TG[TG.length - 1].text), TG[TG.length - 1].text);

/* The one that matters most: losing the record AND the person's notice is the
   single outcome this whole change exists to prevent. It used to be prevented
   by refusing the delete unless the notice could be written down first. The
   notice is no longer written down, so it is prevented a different way: the
   copy that the email is built from is taken BEFORE the row goes, and travels
   with the moment — so the message can still be composed in full when there is
   nothing left in the database to look up. */
seed('HAF-CP-NOTE6', { fname: 'Ned', lname: 'Okafor', email: 'ned@example.com',
  journey: 'v2', docs: withDocs('HAF-CP-NOTE6') });
const gone = await api('/team/delete', auth({ ref: 'HAF-CP-NOTE6', confirm: 'HAF-CP-NOTE6' }));
ok('the record and its documents really are gone',
  gone.status === 200 && !apps.some(a => a.ref === 'HAF-CP-NOTE6')
  && !STORE.has('HAF-CP-NOTE6/licence-front'), apps.map(a => a.ref));
const carried = gone.moment && gone.moment.snap;
ok('yet the notice still carries everything it needs to be written',
  !!carried && carried.email === 'ned@example.com' && carried.ref === 'HAF-CP-NOTE6'
  && /Ned/.test(String(carried.name || carried.fname || '')), carried);
ok('and it is stamped as having come through the new front door, or it would not send',
  carried && carried.journey === 'v2', carried && carried.journey);

console.log(`\n${pass} passed, ${fail} failed`);
if (CHROME) console.log('screenshots → worker/_shots/');
dbSrv.close(); siteSrv.close();
process.exit(fail ? 1 : 0);
