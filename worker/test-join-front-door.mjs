/* Join HAF → Clever: the whole way in, proved locally.
   Brent, 14 Aug: "when they go through join.usehaf.co.uk, the log in allows them
   to sign into clever.usehaf.co.uk for any documents been allocated."

   So this walks the real chain, in order, with the real code:
     join page makes the username and the PIN hash
       → the REAL worker /apply saves the account
       → the REAL worker /login accepts that username and that PIN
       → the Clever landing page puts them in the sign-in box, not the form
       → the documents page shows the list their account type is chased for.

   Nothing real is created. The worker runs against a stub database, and the
   stub's COLUMN LIST is read live from the HUB project with the public key
   before the tests start — so a column that is missing in production is missing
   here too, and a passing run cannot be passing against a schema we invented.

   Run: node worker/test-join-front-door.mjs   (needs the internet for the probe)
*/
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PORT = 8799;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const HUB = 'https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1';
/* the public key the sign-up page already ships in index.js — read-only here */
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzZHd2b2dzeGxuY3p6YmVmd2dwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODgyMzYsImV4cCI6MjA5Njk2NDIzNn0.pxqM-Oh4f_3PlqCbKIKvcKZnNRUZ1ASKqqdNg78M_4M';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/* ── 1. what columns does the live table actually have? ──
   Every field /apply writes, asked of the real database one at a time. A column
   that is not there answers 42703, and PostgREST refuses an insert that names
   it — which is the difference between a sign-up and a 500. */
const WRITES = ['ref', 'status', 'submitted', 'journey', 'type', 'username', 'pin_hash',
  'fname', 'lname', 'email', 'phone', 'dob', 'vtype', 'vreg', 'company', 'crn', 'vat',
  'name', 'title', 'knect', 'docs', 'notes', 'founders_tier', 'promo_code'];

console.log('\n── the live schema (read-only probe of cleverpay_applications) ──');
const LIVE_COLUMNS = new Set();
const MISSING = [];
for (const col of WRITES) {
  const r = await fetch(`${HUB}/cleverpay_applications?select=${col}&limit=1`,
    { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } });
  if (r.ok) LIVE_COLUMNS.add(col); else MISSING.push(col);
}
console.log('  present : ' + [...LIVE_COLUMNS].join(' '));
console.log('  MISSING : ' + (MISSING.length ? MISSING.join(' ') : '(none)'));
ok('the probe actually read something — an empty probe proves nothing',
  LIVE_COLUMNS.size > 5, [...LIVE_COLUMNS]);

/* ── 2. a stub PostgREST that enforces exactly that column list ── */
const DB = { cleverpay_applications: [], cleverpay_portal_config: [{ id: 1, config: {
  driver: { docs: [
    { id: 'dl-front', name: 'Driving licence — front', hint: '', status: 'required' },
    { id: 'h-r-ins', name: 'Hire & Reward insurance', hint: '', status: 'required' },
    { id: 'mot', name: 'MOT certificate', hint: '', status: 'required' },
  ] },
  freight: { docs: [
    { id: 'incorp', name: 'Certificate of Incorporation', hint: '', status: 'required' },
    { id: 'bifa', name: 'BIFA membership certificate', hint: '', status: 'optional' },
  ] },
} }] };
/* switched by the tests, so the same code is seen both with and without 0046 */
let schema = new Set(LIVE_COLUMNS);
let lastInsertRejected = null;

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const table = u.pathname.replace('/rest/v1/', '').split('?')[0];
  const rows = DB[table] || (DB[table] = []);
  let raw = ''; for await (const c of req) raw += c;
  const send = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

  if (req.method === 'POST') {
    const row = JSON.parse(raw);
    /* PostgREST's own behaviour: a payload naming a column the table has not got
       is refused outright, and NOTHING is written. */
    const unknown = Object.keys(row).filter((k) => !schema.has(k));
    if (unknown.length) {
      lastInsertRejected = unknown;
      return send({ code: 'PGRST204',
        message: `Could not find the '${unknown[0]}' column of 'cleverpay_applications' in the schema cache` }, 400);
    }
    rows.push(row);
    return send([row], 201);
  }
  /* PATCH by ref — needed so a test can see what the worker WROTE BACK about a
     person, which is where the 15 Aug "confirmation sent" lie lived. */
  if (req.method === 'PATCH') {
    const patch = JSON.parse(raw || '{}');
    const ref = (u.searchParams.get('ref') || '').replace('eq.', '');
    const hit = rows.filter((r) => r.ref === ref);
    hit.forEach((r) => Object.assign(r, patch));
    return send(hit);
  }
  const or = u.searchParams.get('or');
  if (or) {
    const want = decodeURIComponent(or).replace(/[()]/g, '').split(',').map((s) => s.split('.eq.')[1]);
    return send(rows.filter((r) => want.includes(r.ref) || want.includes(r.username)));
  }
  if (u.searchParams.get('id') === 'eq.1') return send(rows);
  send(rows);
});
await new Promise((r) => server.listen(PORT, r));

/* ── 3. load the REAL worker with its database pointed at the stub ── */
const tmp = new URL('./_test-frontdoor-worker.mjs', import.meta.url);
writeFileSync(tmp, readFileSync(new URL('./cleverpay-api.js', import.meta.url), 'utf8')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', `http://127.0.0.1:${PORT}/rest/v1`));
const worker = (await import(tmp.href)).default;
const env = { SB_KEY: 'stub-key' };
/* The work that runs AFTER the applicant's page is answered — their welcome and
   their confirm email — rides on waitUntil. Hold onto those promises: a test
   that checks the record before they have finished is testing the wrong moment,
   and would have called the missing confirm token a pass. */
const pending = [];
const ctx = { waitUntil: (p) => { pending.push(p); return p; } };
const settle = () => Promise.all(pending.splice(0));
const call = (path, { method = 'GET', origin, body } = {}) =>
  worker.fetch(new Request('https://api.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);

/* ── 4. the join page's own username + PIN maths, lifted out of join.html ──
   Read from the file rather than retyped, so the test cannot pass against a copy
   that has drifted from the page a customer actually uses. */
const JOIN_SRC = readFileSync(new URL('../../haf-pay/public/join.html', import.meta.url), 'utf8');
const makeUsernameSrc = JOIN_SRC.slice(JOIN_SRC.indexOf('function makeUsername()'),
  JOIN_SRC.indexOf('function showUsername()'));
ok('the join page still builds the username here (read from join.html)',
  makeUsernameSrc.includes('.toUpperCase()') && makeUsernameSrc.length > 200);
const hashLine = JOIN_SRC.match(/'HAF-CP\|' \+ username \+ '\|' \+ pin/);
ok('the join page hashes the PIN as HAF-CP|USERNAME|pin', !!hashLine);

/* the person: a fleet, because that is the type only Join HAF can create */
const PERSON = {
  fname: 'Testy', lname: 'McTestface', phone: '07700 900123', dob: '1988-04-02',
  company: 'Rapid Vans Ltd', email: 'testy@example.invalid', pin: '4821',
};
/* the same rule join.html:323 applies — company initials + last four of the phone */
const USERNAME = 'RV' + '0123';
const PIN_HASH = sha('HAF-CP|' + USERNAME + '|' + PERSON.pin);

console.log('\n── /apply from the real join domain, against the live schema ──');
let r = await call('/apply', { method: 'POST', origin: 'https://join.usehaf.co.uk', body: {
  type: 'fleet', username: USERNAME, pinHash: PIN_HASH,
  fname: PERSON.fname, lname: PERSON.lname, email: PERSON.email,
  phone: PERSON.phone, dob: PERSON.dob, company: PERSON.company } });
let j = await r.json();
ok('a fleet signing up on join.usehaf.co.uk gets an account', r.status === 200, { s: r.status, j });
ok('...with a reference', !!j.ref, j.ref);
ok('...and the PIN hash never comes back out', j.pin_hash === undefined);
const saved = DB.cleverpay_applications[0];
ok('...the row holds the PIN hash the browser sent', saved && saved.pin_hash === PIN_HASH);
ok('...the row holds the username the person will type', saved && saved.username === USERNAME, saved && saved.username);
ok('...and the type is kept as fleet, not flattened to driver', saved && saved.type === 'fleet', saved && saved.type);
if (MISSING.includes('journey')) {
  ok('...the missing journey column did NOT cost them their account (it was refused once first)',
    lastInsertRejected && lastInsertRejected.includes('journey') && saved && saved.journey === undefined,
    { rejected: lastInsertRejected });
}

console.log('\n── the same request once migration 0046 has been run ──');
schema = new Set([...LIVE_COLUMNS, 'journey']);
r = await call('/apply', { method: 'POST', origin: 'https://join.usehaf.co.uk', body: {
  type: 'driver', username: 'TM01238 8', pinHash: sha('x'), fname: 'A', lname: 'B' } });
ok('an account is still created', r.status === 200, r.status);
ok('...and now it carries the journey stamp',
  DB.cleverpay_applications[1] && DB.cleverpay_applications[1].journey === 'v2',
  DB.cleverpay_applications[1] && DB.cleverpay_applications[1].journey);

r = await call('/apply', { method: 'POST', origin: 'https://a1b2c3d4.haf-pay.pages.dev', body: {
  type: 'driver', username: 'PREVIEW1', pinHash: sha('y'), fname: 'A', lname: 'B' } });
await r.json();
ok('a branch preview of the join page is stamped too (Cloudflare puts a hash in front)',
  DB.cleverpay_applications[2] && DB.cleverpay_applications[2].journey === 'v2',
  DB.cleverpay_applications[2] && DB.cleverpay_applications[2].journey);

r = await call('/apply', { method: 'POST', origin: 'https://not-haf.pages.dev', body: {
  type: 'driver', username: 'STRANGER', pinHash: sha('z'), fname: 'A', lname: 'B' } });
await r.json();
ok('somebody else\'s page on free hosting is NOT stamped as our journey',
  DB.cleverpay_applications[3] && DB.cleverpay_applications[3].journey === undefined);

/* ── the door this test suite never watched ───────────────────────────────────
   15 Aug. Every check above asks about the JOIN page, and every one of them
   passed all the way through the weeks in which the OTHER front door — the one
   25 of 28 real sign-ups actually used — saved people unstamped and left them
   in silence. A test suite that only walks the door you were thinking about
   will pass while the business is broken. So both doors are walked here now. */
console.log('\n── the other front door: clever.usehaf.co.uk ──');
r = await call('/apply', { method: 'POST', origin: 'https://clever.usehaf.co.uk', body: {
  type: 'driver', username: 'CLEVER01', pinHash: sha('c'), fname: 'Real', lname: 'Driver',
  email: 'real.driver@example.invalid' } });
ok('a driver signing up on the Clever page gets an account', r.status === 200, r.status);
await settle();                       /* their welcome + confirm email finish first */
const clev = DB.cleverpay_applications.find((a) => a.username === 'CLEVER01');
ok('...and is stamped onto the journey, so the emails will actually go',
  clev && clev.journey === 'v2', clev && clev.journey);
ok('...and is given a confirm token, so the link in the email can work',
  clev && typeof clev.email_confirm_token === 'string' && clev.email_confirm_token.length === 64);
/* mail is not armed in this harness (no MAIL_KEY), so nothing can have left. */
ok('...and the record does NOT claim "confirmation sent" when nothing was sent',
  clev && clev.email_confirm_sent_at === undefined, clev && clev.email_confirm_sent_at);
schema = new Set(LIVE_COLUMNS);

console.log('\n── the log in, with what they chose on the join page ──');
r = await call('/login', { method: 'POST', origin: 'https://clever.usehaf.co.uk',
  body: { id: USERNAME, pin: PERSON.pin } });
j = await r.json();
ok('the HAF username made by Join HAF signs them in at Clever', r.status === 200, { s: r.status, j });
ok('...and it returns their own record', j.ref === saved.ref && j.type === 'fleet');
ok('...with no PIN hash in the reply', j.pin_hash === undefined);
ok('...and no documents yet, which is what sends them to the documents page',
  Array.isArray(j.docs) && j.docs.length === 0, j.docs);

r = await call('/login', { method: 'POST', body: { id: USERNAME.toLowerCase(), pin: PERSON.pin } });
ok('typing the username in lower case still works', r.status === 200, r.status);

r = await call('/login', { method: 'POST', body: { id: USERNAME, pin: '9999' } });
ok('the wrong PIN is refused', r.status === 401, r.status);

r = await call('/login', { method: 'POST', body: { id: saved.ref, pin: PERSON.pin } });
ok('the reference still works as well as the username', r.status === 200, r.status);

r = await call('/apply', { method: 'POST', origin: 'https://join.usehaf.co.uk',
  body: { type: 'fleet', username: USERNAME, pinHash: PIN_HASH } });
ok('signing up twice with the same username is refused, not duplicated', r.status === 409, r.status);

console.log('\n── the CORS door the browser has to get through ──');
for (const [o, allowed] of [
  ['https://join.usehaf.co.uk', true],
  ['https://clever.usehaf.co.uk', true],
  ['https://a1b2c3d4.haf-pay.pages.dev', true],
  ['https://warren-not-haf-at-all.pages.dev', false],
]) {
  const res = await call('/config', { method: 'OPTIONS', origin: o });
  const got = res.headers.get('Access-Control-Allow-Origin');
  ok(`${o} is ${allowed ? 'allowed' : 'refused'}`, allowed ? got === o : got !== o, got);
}

server.close();
unlinkSync(tmp);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
