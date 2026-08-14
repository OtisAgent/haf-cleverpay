/* Proof for what Brent asked for on 14 August:

     "The only time they should get access is when they get approval from being
      clever checked in the clever.usehaf.co.uk team portal — the only time —
      it's very important ... until that, under no circumstances the username
      and account gets a PLNA."

   He proved the hole himself: he signed up as a freight account, uploaded no
   documents at all, and was offered a HAF PLNA. Confirm & release never looked
   at the paperwork — it stamped the record, and the mail job copied the
   username onto PLNA's cleared list.

   This is the press itself under test. Real portal worker, real requirement set
   copied from live settings, stub database. What it has to show is both halves:
   an empty record cannot be released, and a complete one still can — a gate that
   only ever says no would break every real driver instead of the loophole.

   Run: node worker/test-release-needs-docs.mjs */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha = s => createHash('sha256').update(s).digest('hex');
const PIN = '1234';
const pw = u => sha('HAF-CP-TEAM|' + u + '|' + PIN);
const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));

/* the requirement sets exactly as the live portal holds them */
const REQ = t => LIVE_CONFIG[t].docs.filter(d => d.status === 'required').map(d => d.id);
const OPT = t => LIVE_CONFIG[t].docs.filter(d => d.status !== 'required').map(d => d.id);
const files = ids => ids.map(id => ({ id, req: true, filename: id + '.pdf', path: 'x/' + id }));

const apps = [];
const DB = {
  cleverpay_portal_config: [{ id: 1, config: JSON.parse(JSON.stringify(LIVE_CONFIG)) }],
  cleverpay_applications: apps,
  cleverpay_team_users: [
    { username: 'bf638793', name: 'Brent Ford', role: 'admin', must_set_pin: false, pw_hash: pw('bf638793') },
    { username: 'cleverg', name: 'Gemma Vale', role: 'compliance', must_set_pin: false, pw_hash: pw('cleverg') },
  ],
  cleverpay_team_sessions: [], cleverpay_api_keys: [], cleverpay_farewells: [],
};
let seq = 1;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const href = typeof input === 'string' ? input : input.url;
  /* the compliance group must never be reached for real from a test */
  if (href.includes('api.telegram.org')) return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
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
  const body = Buffer.concat(chunks).toString('utf8');
  if (u.pathname.startsWith('/storage/')) { res.writeHead(200, CORS); return res.end('{}'); }
  const table = u.pathname.replace('/rest/v1/', '').split('?')[0];
  const rows = DB[table] || [];
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
await new Promise(r => dbSrv.listen(8801, r));

const swap = s => s
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8801/rest/v1')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/', 'http://127.0.0.1:8801/storage/');
const w = async (name, out) => {
  const t = new URL(out, import.meta.url);
  writeFileSync(t, swap(readFileSync(new URL(name, import.meta.url), 'utf8')));
  return (await import(t.href)).default;
};
const apiWorker = await w('./cleverpay-api.js', './_rel-worker.mjs');
const adminWorker = await w('./cleverpay-admin.js', './_rel-admin.mjs');
const ENV = { SB_KEY: 'stub', TG_TOKEN: 'test-token', TG_CHAT: '-100999' };
const worker = { fetch: (req, env, ctx) => apiWorker.fetch(req, { ...ENV, ...env, ADMIN: { fetch: r => adminWorker.fetch(r, {}, ctx) } }, ctx) };

const api = async (path, init = {}) => {
  const r = await worker.fetch(new Request('http://127.0.0.1:8802' + path, init), {}, { waitUntil: p => p });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b, event: r.headers.get('x-cp-event') };
};
const login = async u => (await api('/team/login', { method: 'POST', body: JSON.stringify({ username: u, password: PIN }) })).body.token;

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };

const GEMMA = await login('cleverg');
const H = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

let n = 0;
/* one applicant, made directly in the stub so the test is about the press only */
function makeApp(type, docs) {
  const ref = 'HAF-CP-T' + String(++n).padStart(3, '0');
  const row = {
    id: seq++, ref, type, username: 'ZZ' + String(n).padStart(6, '0'),
    status: 'pending', docs: docs || [], email: 'x' + n + '@example.com',
    email_verified: true, access_confirmed_at: null, access_confirmed_by: null, knect: false,
  };
  apps.push(row);
  return row;
}
const release = (ref, extra) => api('/team/applications/' + ref, {
  method: 'PATCH', headers: H(GEMMA), body: JSON.stringify({ confirm_access: true, ...(extra || {}) }),
});

console.log('\n── the hole Brent found: freight, nothing uploaded ──');
{
  const a = makeApp('freight', []);
  const r = await release(a.ref);
  ok('release is refused', r.status === 409, r.status);
  ok('the reason names the missing documents', /missing 5 required documents/.test(r.body?.error || ''), r.body);
  ok('nothing was stamped', a.access_confirmed_at === null, a.access_confirmed_at);
  ok('HAF KNECT was not switched on', a.knect !== true, a.knect);
  ok('no "you are in" email was named', !r.event, r.event);
  ok('the record was not silently approved', a.status === 'pending', a.status);
}

console.log('\n── a driver with nothing uploaded ──');
{
  const a = makeApp('driver', []);
  const r = await release(a.ref);
  ok('release is refused', r.status === 409, r.status);
  ok('all seven are named', /missing 7 required documents/.test(r.body?.error || ''), r.body);
}

console.log('\n── one required document short ──');
{
  const short = REQ('driver').slice(0, -1);
  const a = makeApp('driver', files(short));
  const r = await release(a.ref);
  ok('still refused on the last one', r.status === 409, r.status);
  ok('exactly one is named', /missing 1 required document:/.test(r.body?.error || ''), r.body);
}

console.log('\n── optional paperwork is not a blocker ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  ok('the optional set really is non-empty', OPT('driver').length > 0, OPT('driver'));
  const r = await release(a.ref);
  ok('a complete record is released', r.status === 200, [r.status, r.body]);
  /* the stamp carries the login that pressed it — cleverg is Gemma's compliance
     account — because that is what an audit needs, not a display name */
  ok('it is stamped with who pressed it', /cleverg/.test(a.access_confirmed_by || ''), a.access_confirmed_by);
  ok('HAF KNECT is switched on', a.knect === true, a.knect);
  ok('the applicant is told', r.event === 'compliance_approved', r.event);
}

console.log('\n── freight, complete ──');
{
  const a = makeApp('freight', files(REQ('freight')));
  const r = await release(a.ref);
  ok('a complete freight record is released', r.status === 200, [r.status, r.body]);
  ok('stamped', !!a.access_confirmed_at, a.access_confirmed_at);
}

console.log('\n── documents that arrive by email, saved and released in one press ──');
{
  const a = makeApp('driver', []);
  const r = await release(a.ref, { docs: files(REQ('driver')) });
  ok('the same press that adds them may release', r.status === 200, [r.status, r.body]);
  ok('the files are on the record', (a.docs || []).length === REQ('driver').length, (a.docs || []).length);
}

console.log('\n── approve on its own is untouched, and still opens nothing ──');
{
  const a = makeApp('driver', []);
  const r = await api('/team/applications/' + a.ref, {
    method: 'PATCH', headers: H(GEMMA), body: JSON.stringify({ status: 'approved' }),
  });
  ok('an empty record may still be approved', r.status === 200, r.status);
  ok('but approval opens no door', !a.access_confirmed_at, a.access_confirmed_at);
  ok('and tells the applicant nothing', !r.event, r.event);
}

console.log('\n── reject still works with nothing uploaded ──');
{
  const a = makeApp('driver', []);
  const r = await api('/team/applications/' + a.ref, {
    method: 'PATCH', headers: H(GEMMA),
    body: JSON.stringify({ status: 'rejected', rejectReason: 'No documents supplied.', routeBack: 'fix' }),
  });
  ok('reject is not blocked by the new gate', r.status === 200, r.status);
  ok('the applicant is told', r.event === 'compliance_rejected', r.event);
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
dbSrv.close();
process.exit(fail ? 1 : 0);
