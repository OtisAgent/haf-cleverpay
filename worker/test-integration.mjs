/* Local proof for the back-office integration panel.
   Runs the real worker module against a stubbed database holding one made-up
   driver, so every route is exercised before anything real is touched.
   Run: node worker/test-integration.mjs */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PORT = 8788;
const sha = (s) => createHash('sha256').update(s).digest('hex');

/* ── stub database: one made-up driver, nothing real ── */
const DB = {
  cleverpay_applications: [{
    ref: 'HAF-CP-TEST01', type: 'driver', username: 'TD990101',
    fname: 'Testy', lname: 'McTestface', email: 'testy@example.invalid',
    phone: '07700900000', dob: '1990-01-01', vtype: 'Small van', vreg: 'TE57 ABC',
    status: 'approved', email_verified: true, submitted: '2026-07-31T09:00:00Z',
    approved_at: '2026-07-31T09:30:00Z', rejected_at: null, updated_at: '2026-07-31T09:30:00Z',
    /* the things that must NEVER cross to the back office */
    docs: [{ id: 'dl-front', filename: 'licence.pdf', path: 'HAF-CP-TEST01/dl-front', mime: 'application/pdf' }],
    notes: 'private internal note', pin_hash: sha('secret'), promo_code: 'H6PRO-ABCD',
  }],
  cleverpay_team_users: [
    { username: 'bf638793', name: 'Brent Ford', role: 'admin', must_set_pin: false, pw_hash: 'x' },
    { username: 'cleverg', name: 'Gemma Vale', role: 'compliance', must_set_pin: false, pw_hash: 'x' },
    { username: 'admin', name: 'Admin', role: 'admin', must_set_pin: false, pw_hash: 'x' },
  ],
  cleverpay_team_sessions: [
    { token: 'TOK-BRENT', username: 'bf638793', expires_at: '2099-01-01T00:00:00Z' },
    { token: 'TOK-GEMMA', username: 'cleverg', expires_at: '2099-01-01T00:00:00Z' },
    { token: 'TOK-OTHER', username: 'admin', expires_at: '2099-01-01T00:00:00Z' },
  ],
  cleverpay_api_keys: [],
};
let seq = 1;

/* a small PostgREST-alike: enough of eq./is.null/order/limit for these routes */
function match(row, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (v === 'is.null') { if (row[k] != null) return false; continue; }
    if (v.startsWith('eq.')) {
      const want = decodeURIComponent(v.slice(3));
      if (String(row[k] ?? '') !== want) return false;
      continue;
    }
    if (v.startsWith('or=(')) continue;
  }
  return true;
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const table = u.pathname.replace('/rest/v1/', '').split('?')[0];
  const params = [...u.searchParams.entries()];
  let body = '';
  for await (const c of req) body += c;
  const rows = DB[table] || [];
  const send = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

  /* the /apply+/login lookup uses or=(ref.eq.X,username.eq.X) */
  const or = u.searchParams.get('or');
  if (or) {
    const want = decodeURIComponent(or).replace(/[()]/g, '').split(',').map(s => s.split('.eq.')[1]);
    return send(rows.filter(r => want.includes(r.ref) || want.includes(r.username)));
  }

  if (req.method === 'GET') {
    let out = rows.filter(r => match(r, params));
    const lim = Number(u.searchParams.get('limit') || 0);
    if (lim) out = out.slice(0, lim);
    return send(out);
  }
  if (req.method === 'POST') {
    const row = { id: seq++, created_at: new Date().toISOString(), use_count: 0, revoked_at: null, ...JSON.parse(body) };
    rows.push(row); DB[table] = rows;
    return send([row], 201);
  }
  if (req.method === 'PATCH') {
    const patch = JSON.parse(body);
    const hit = rows.filter(r => match(r, params));
    hit.forEach(r => Object.assign(r, patch));
    return send(hit);
  }
  send([]);
});

await new Promise(r => server.listen(PORT, r));

/* load the worker with its database pointed at the stub */
const swap = s => s
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', `http://127.0.0.1:${PORT}/rest/v1`)
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/', `http://127.0.0.1:${PORT}/storage/`);
const src = swap(readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8'));
const tmp = new URL('./_test-worker.mjs', import.meta.url);
writeFileSync(tmp, src);
const apiWorker = (await import(tmp.href)).default;
/* The back office runs as its own worker in production, reached over a private
   binding because a single script no longer fits the 20,000-character deploy
   pipe. The harness wires the two together the same way, so what is tested here
   is the same path a request takes live. */
const adminSrc = swap(readFileSync(new URL('./cleverpay-admin.js', import.meta.url), 'utf8'));
const atmp = new URL('./_test-admin.mjs', import.meta.url);
writeFileSync(atmp, adminSrc);
const adminWorker = (await import(atmp.href)).default;
const worker = { fetch: (req, env, ctx) => apiWorker.fetch(req,
  { ...env, ADMIN: { fetch: r => adminWorker.fetch(r, {}, ctx) } }, ctx) };

const env = { SB_KEY: 'stub-key' };
const ctx = { waitUntil: (p) => p };
const call = (path, { method = 'GET', headers = {}, body } = {}) =>
  worker.fetch(new Request('https://api.test' + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + JSON.stringify(detail) : '')); }
};

console.log('\n── who can see the panel ──');
let r = await call('/team/integration', { headers: { Authorization: 'Bearer TOK-BRENT' } });
let j = await r.json();
ok('Brent (bf638793) gets the panel', r.status === 200 && !!j.endpoint, { s: r.status, j });
const endpointShown = j.endpoint;

r = await call('/team/integration', { headers: { Authorization: 'Bearer TOK-GEMMA' } });
ok('Gemma (cleverg) gets the panel', r.status === 200);

r = await call('/team/integration', { headers: { Authorization: 'Bearer TOK-OTHER' } });
j = await r.json();
ok('a third team login is refused server-side', r.status === 404, { s: r.status, j });
ok('...and the refusal leaks nothing', JSON.stringify(j) === JSON.stringify({ error: 'Not found.' }), j);

r = await call('/team/integration', {});
ok('no session at all is refused', r.status === 401);

console.log('\n── generating and rotating the key ──');
r = await call('/team/integration/key', { method: 'POST', headers: { Authorization: 'Bearer TOK-OTHER' }, body: {} });
ok('a third team login cannot generate a key', r.status === 404);

r = await call('/team/integration/key', { method: 'POST', headers: { Authorization: 'Bearer TOK-BRENT' }, body: {} });
j = await r.json();
const KEY1 = j.key;
ok('Brent generates a key', r.status === 200 && /^cpk_[a-f0-9]{40}$/.test(KEY1 || ''), j);
ok('the key is stored only as a hash', DB.cleverpay_api_keys.every(k => k.key_hash !== KEY1 && !JSON.stringify(k).includes(KEY1)));
ok('who created it is recorded', DB.cleverpay_api_keys[0].created_by === 'bf638793');

r = await call('/team/integration', { headers: { Authorization: 'Bearer TOK-BRENT' } });
j = await r.json();
ok('the panel shows the key prefix, never the key', j.key?.prefix === KEY1.slice(0, 12) && !JSON.stringify(j).includes(KEY1), j.key);
ok('the panel reports the live status line', j.live === true && !!j.checked_at, j);

console.log('\n── the back-office endpoint ──');
r = await fetchPartner(KEY1, '/partner/compliance');
j = await r.json();
ok('a valid key reads the list', r.status === 200 && j.count === 1, j);

const acct = j.accounts[0];
const ALLOWED = ['reference', 'name', 'account_type', 'compliance_status', 'email_confirmed',
  'submitted_at', 'approved_at', 'rejected_at', 'updated_at'];
ok('only the agreed fields cross', JSON.stringify(Object.keys(acct).sort()) === JSON.stringify([...ALLOWED].sort()), Object.keys(acct));
const leaked = ['docs', 'pin_hash', 'notes', 'email', 'phone', 'dob', 'promo_code', 'vreg', 'username'];
ok('no documents, contact or payment details cross', leaked.every(k => !(k in acct)), Object.keys(acct).filter(k => leaked.includes(k)));
ok('the made-up driver reads correctly', acct.reference === 'HAF-CP-TEST01' && acct.name === 'Testy McTestface' && acct.compliance_status === 'approved', acct);

r = await fetchPartner(KEY1, '/partner/compliance?ref=HAF-CP-TEST01');
j = await r.json();
ok('a single lookup by reference works', r.status === 200 && j.reference === 'HAF-CP-TEST01', j);

r = await fetchPartner(KEY1, '/partner/compliance?status=rejected');
j = await r.json();
ok('filtering by status works', r.status === 200 && j.count === 0, j);

r = await fetchPartner('cpk_' + 'f'.repeat(40), '/partner/compliance');
ok('a wrong key is refused', r.status === 401);
r = await fetchPartner('', '/partner/compliance');
ok('no key at all is refused', r.status === 401);

r = await call('/partner/compliance', { headers: { Origin: 'https://clever.usehaf.co.uk' } });
ok('the endpoint gives no CORS, so no browser page can read it',
  !r.headers.get('Access-Control-Allow-Origin'), r.headers.get('Access-Control-Allow-Origin'));

console.log('\n── usage tracking and rotation ──');
r = await call('/team/integration', { headers: { Authorization: 'Bearer TOK-BRENT' } });
j = await r.json();
ok('"last talked to us" is recorded', !!j.key.last_used_at && j.key.use_count > 0, j.key);

r = await call('/team/integration/key', { method: 'POST', headers: { Authorization: 'Bearer TOK-GEMMA' }, body: {} });
j = await r.json();
const KEY2 = j.key;
ok('Gemma can rotate the key', r.status === 200 && j.rotated === true && KEY2 !== KEY1, j);

r = await fetchPartner(KEY1, '/partner/compliance');
ok('the old key stops working immediately', r.status === 401);
r = await fetchPartner(KEY2, '/partner/compliance');
ok('the new key works', r.status === 200);

r = await call('/team/integration/revoke', { method: 'POST', headers: { Authorization: 'Bearer TOK-BRENT' }, body: {} });
ok('Brent can switch the key off', r.status === 200);
r = await fetchPartner(KEY2, '/partner/compliance');
ok('after switch-off the endpoint is closed', r.status === 401);

r = await call('/team/integration', { headers: { Authorization: 'Bearer TOK-BRENT' } });
j = await r.json();
ok('the panel then shows no active key', j.key === null || j.key === undefined, j.key);

console.log('\n── nothing else changed ──');
r = await call('/config');
ok('the public config still answers', r.status === 200);
r = await call('/team/applications', { headers: { Authorization: 'Bearer TOK-OTHER' } });
j = await r.json();
ok('a normal team member still sees the queue', r.status === 200 && Array.isArray(j) && j.length === 1, j);
ok('the queue still strips the PIN hash', !('pin_hash' in j[0]), Object.keys(j[0]));
r = await call('/nope');
ok('unknown routes still 404', r.status === 404);

function fetchPartner(key, path) {
  return call(path, key ? { headers: { 'X-API-Key': key } } : {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
unlinkSync(tmp);
server.close();
process.exit(fail ? 1 : 0);
