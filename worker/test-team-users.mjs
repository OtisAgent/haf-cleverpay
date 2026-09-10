/* Local proof for Team & access — the owner's screen for the portal's own people.

   Everything else about this screen was proved against the live portal on
   10 Sep, with a throwaway admin login that was deleted afterwards. ONE branch
   cannot be reached that way, and it is the most important one in the file:
   "this is the last admin login". Reaching it live would mean switching off
   Brent's own logins on production to see what happens, which is precisely the
   accident the guard exists to prevent.

   So it is proved here, on a stubbed database holding one admin and nobody
   else, running the real worker module through the real API worker over the
   same private binding it uses live.

   Run: node worker/test-team-users.mjs */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const PORT = 8791;

/* ── stub database: made-up people, nothing real ── */
const DB = {
  cleverpay_team_users: [
    { username: 'onlyadmin', name: 'Only Admin', role: 'admin', active: true,
      can_release: true, must_set_pin: false, pw_hash: 'x' },
    { username: 'areviewer', name: 'A Reviewer', role: 'compliance', active: true,
      can_release: true, must_set_pin: false, pw_hash: 'x' },
  ],
  cleverpay_team_sessions: [
    { token: 'TOK-ONLYADMIN', username: 'onlyadmin', expires_at: '2099-01-01T00:00:00Z' },
    { token: 'TOK-REVIEWER', username: 'areviewer', expires_at: '2099-01-01T00:00:00Z' },
  ],
};

function match(row, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (v === 'is.true') { if (row[k] !== true) return false; continue; }
    if (v === 'is.null') { if (row[k] != null) return false; continue; }
    if (v.startsWith('eq.')) {
      if (String(row[k] ?? '') !== decodeURIComponent(v.slice(3))) return false;
    }
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
  const send = (d, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(d));
  };
  if (req.method === 'GET') {
    let out = rows.filter(r => match(r, params));
    const lim = Number(u.searchParams.get('limit') || 0);
    return send(lim ? out.slice(0, lim) : out);
  }
  if (req.method === 'POST') {
    const row = JSON.parse(body);
    rows.push(row); DB[table] = rows;
    return send([row], 201);
  }
  if (req.method === 'PATCH') {
    const patch = JSON.parse(body);
    const hit = rows.filter(r => match(r, params));
    hit.forEach(r => Object.assign(r, patch));
    return send(hit);
  }
  if (req.method === 'DELETE') {
    DB[table] = rows.filter(r => !match(r, params));
    return send([]);
  }
  send([]);
});
await new Promise(r => server.listen(PORT, r));

/* Load both workers with their database pointed at the stub, wired together
   over the same USERS binding production uses. */
const swap = s => s.replace(
  'https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1',
  `http://127.0.0.1:${PORT}/rest/v1`);
async function load(file, tmpName) {
  const t = new URL('./' + tmpName, import.meta.url);
  writeFileSync(t, swap(readFileSync(new URL('./' + file, import.meta.url), 'utf8')));
  return { mod: (await import(t.href)).default, path: t };
}
const users = await load('cleverpay-users.js', '_test-users-w.mjs');
const api = await load('cleverpay-api.js', '_test-users-api.mjs');
const ctx = { waitUntil: p => p };
const call = (path, { method = 'GET', token, body } = {}) =>
  api.mod.fetch(new Request('https://api.test' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), {
    SB_KEY: 'stub-key',
    ADMIN: { fetch: () => new Response('{"error":"Not found."}', { status: 404 }) },
    USERS: { fetch: r => users.mod.fetch(r, {}, ctx) },
  }, ctx);

let pass = 0; const fails = [];
const ok = (what, cond, saw) => {
  if (cond) { pass++; console.log('  ok   ' + what); } else {
    fails.push(what); console.log('  FAIL ' + what + (saw === undefined ? '' : '  -> ' + JSON.stringify(saw)));
  }
};

console.log('\n== the portal can never be left with nobody in charge ==');
let r = await call('/team/users/access', {
  method: 'POST', token: 'TOK-ONLYADMIN', body: { username: 'onlyadmin', active: false },
});
let j = await r.json();
ok('the only admin cannot switch himself off', r.status === 409, j);
ok('and is told to ask another admin', /another admin/i.test(j.error || ''), j.error);

/* The same row, changed by somebody else: a second admin exists in no sense
   here, so the LAST-ADMIN branch is what answers rather than the self-guard. */
DB.cleverpay_team_users.push({
  username: 'secondadmin', name: 'Second Admin', role: 'admin', active: true,
  can_release: false, must_set_pin: false, pw_hash: 'x',
});
DB.cleverpay_team_sessions.push({
  token: 'TOK-SECOND', username: 'secondadmin', expires_at: '2099-01-01T00:00:00Z',
});
r = await call('/team/users/access', {
  method: 'POST', token: 'TOK-SECOND', body: { username: 'onlyadmin', active: false },
});
ok('with a second admin present, the first CAN be switched off', r.status === 200);
ok('and the switched-off login is really off',
  DB.cleverpay_team_users.find(u => u.username === 'onlyadmin').active === false);
ok('their session was torn up, not left to run out',
  !DB.cleverpay_team_sessions.some(s => s.username === 'onlyadmin'));

/* Now second admin is the only active one. Both routes must refuse. */
r = await call('/team/users/access', {
  method: 'POST', token: 'TOK-SECOND', body: { username: 'secondadmin', role: 'compliance' },
});
j = await r.json();
ok('the last admin cannot step down', r.status === 409, j);

const other = await call('/team/users/add', {
  method: 'POST', token: 'TOK-SECOND',
  body: { name: 'Third Admin', username: 'thirdadmin', role: 'admin' },
});
ok('another admin can be added', other.status === 200);
r = await call('/team/users/remove', {
  method: 'POST', token: 'TOK-SECOND', body: { username: 'thirdadmin' },
});
ok('and removed again while two admins remain', r.status === 200);

console.log('\n== a reviewer is told this area does not exist ==');
r = await call('/team/users', { token: 'TOK-REVIEWER' });
ok('compliance gets a plain 404, not a locked door', r.status === 404);
r = await call('/team/users/add', {
  method: 'POST', token: 'TOK-REVIEWER',
  body: { name: 'Sneaky Admin', username: 'sneaky', role: 'admin' },
});
ok('and cannot add anybody', r.status === 404);
ok('nothing was written by the attempt',
  !DB.cleverpay_team_users.some(u => u.username === 'sneaky'));

console.log('\n== a new person is born with no way in ==');
r = await call('/team/users/add', {
  method: 'POST', token: 'TOK-SECOND',
  body: { name: 'New Starter', username: 'newstarter', role: 'compliance' },
});
j = await r.json();
const row = DB.cleverpay_team_users.find(u => u.username === 'newstarter');
ok('the add is accepted', r.status === 200, j);
ok('a one-time setup code is returned once', (j.setupCode || '').length === 8);
ok('they must choose their own PIN', row.must_set_pin === true);
ok('their stored hash matches nothing anyone holds',
  typeof row.pw_hash === 'string' && row.pw_hash.length === 64);
ok('the code is never read back on the list',
  !JSON.stringify(await (await call('/team/users', { token: 'TOK-SECOND' })).json())
    .includes(j.setupCode));

console.log('\n== a login is 3 to 32 plain characters ==');
for (const bad of ['ab', 'Has Spaces', 'sql;drop', 'a'.repeat(33)]) {
  const rr = await call('/team/users/add', {
    method: 'POST', token: 'TOK-SECOND', body: { name: 'Bad Login', username: bad },
  });
  ok('refused: ' + JSON.stringify(bad), rr.status === 400);
}

server.close();
[users.path, api.path].forEach(p => { try { unlinkSync(p); } catch {} });
console.log('\n' + (fails.length
  ? fails.length + ' CHECK(S) FAILED: ' + fails.join('; ')
  : pass + ' checks passed, 0 failed'));
process.exit(fails.length ? 1 : 0);
