/* Brent, 14 August: "confirm all the buttons in the clever.usehaf.co.uk portal
   is linked to an email when pressed."

   This is that confirmation, and it is a test rather than a list because a list
   goes stale the first time somebody edits a button. Every action in the portal
   is pressed here for real — real worker, real routing, stub database — and what
   comes back is the name of the email moment that press hands to the sending
   worker. No name on the reply means nothing is sent to that person, ever.

   A silence is not automatically a fault. Five presses are deliberately silent
   and each is asserted as silent ON PURPOSE, so that if somebody later wires one
   up by accident this test says so.

   Nothing is open any more. Block and Unblock were the last two without a verdict
   and Brent settled them on 14 August: a blocked account is told, in the
   reviewer's own words, and invited to sign in and put things right.

   Run: node worker/test-every-button-emails.mjs */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha = s => createHash('sha256').update(s).digest('hex');
const PIN = '1234';
const pw = u => sha('HAF-CP-TEAM|' + u + '|' + PIN);
const LIVE_CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));
const REQ = t => LIVE_CONFIG[t].docs.filter(d => d.status === 'required').map(d => d.id);
const files = ids => ids.map(id => ({ id, req: true, filename: id + '.pdf', path: 'x/' + id }));

const apps = [];
const DB = {
  cleverpay_portal_config: [{ id: 1, config: JSON.parse(JSON.stringify(LIVE_CONFIG)) }],
  cleverpay_applications: apps,
  cleverpay_team_users: [
    { username: 'cleverg', name: 'Gemma Vale', role: 'compliance', must_set_pin: false, pw_hash: pw('cleverg') },
  ],
  cleverpay_team_sessions: [], cleverpay_api_keys: [], cleverpay_farewells: [],
};
let seq = 1;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const href = typeof input === 'string' ? input : input.url;
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
  /* spliced in place, not reassigned: the test holds a reference to this same
     array, and a row that is only gone from the stub's copy is not gone */
  if (req.method === 'DELETE') {
    const hit = rows.filter(r => match(r, params));
    hit.forEach(r => rows.splice(rows.indexOf(r), 1));
    return send(hit);
  }
  send([]);
});
await new Promise(r => dbSrv.listen(8811, r));

const swap = s => s
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1', 'http://127.0.0.1:8811/rest/v1')
  .replace('https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/', 'http://127.0.0.1:8811/storage/');
const w = async (name, out) => {
  const t = new URL(out, import.meta.url);
  writeFileSync(t, swap(readFileSync(new URL(name, import.meta.url), 'utf8')));
  return (await import(t.href)).default;
};
const apiWorker = await w('./cleverpay-api.js', './_btn-worker.mjs');
const adminWorker = await w('./cleverpay-admin.js', './_btn-admin.mjs');
const ENV = { SB_KEY: 'stub', TG_TOKEN: 'test-token', TG_CHAT: '-100999' };
const worker = { fetch: (req, env, ctx) => apiWorker.fetch(req, { ...ENV, ...env, ADMIN: { fetch: r => adminWorker.fetch(r, {}, ctx) } }, ctx) };

const api = async (path, init = {}) => {
  const r = await worker.fetch(new Request('http://127.0.0.1:8812' + path, init), {}, { waitUntil: p => p });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b, event: r.headers.get('x-cp-event') };
};
const GEMMA = (await api('/team/login', { method: 'POST', body: JSON.stringify({ username: 'cleverg', password: PIN }) })).body.token;
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GEMMA };

let pass = 0, fail = 0;
const rows = [];
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };

let n = 0;
function makeApp(type, docs, extra) {
  const ref = 'HAF-CP-B' + String(++n).padStart(3, '0');
  const row = {
    id: seq++, ref, type, username: 'ZZ' + String(n).padStart(6, '0'),
    status: 'pending', docs: docs || [], email: 'b' + n + '@example.com', journey: 'v2',
    email_verified: true, access_confirmed_at: null, access_confirmed_by: null, knect: false,
    ...(extra || {}),
  };
  apps.push(row);
  return row;
}
const patch = (ref, body) => api('/team/applications/' + ref, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
const post = (path, body) => api(path, { method: 'POST', headers: H, body: JSON.stringify(body) });

/* Every press below records what the applicant would hear, so the table at the
   end is generated from the presses and cannot disagree with them. */
const record = (button, event, intent) => rows.push({ button, event: event || null, intent });

console.log('\n══ ACTIONS ══');

console.log('\n── Edit details ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const r = await patch(a.ref, { name: 'Corrected Name' });
  ok('the correction saves', r.status === 200, r.status);
  ok('silent on purpose — a typo fixed by the team is not news for the applicant', !r.event, r.event);
  record('Edit details', r.event, 'silent on purpose — an internal correction');
}

console.log('\n── Mark in review ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const r = await patch(a.ref, { status: 'reviewing' });
  ok('the record moves to In Review', r.status === 200 && a.status === 'reviewing', a.status);
  ok('silent on purpose — "we have your documents" already went automatically', !r.event, r.event);
  record('Mark in review', r.event, 'silent on purpose — the documents-received email already covers it');
}

console.log('\n── Send document reminder ──');
{
  const a = makeApp('driver', []);
  const r = await post('/team/remind', { ref: a.ref });
  ok('the reminder is accepted', r.status === 200, r.status);
  ok('it names the "something is missing" email', r.event === 'compliance_action_required', r.event);
  record('Send document reminder', r.event, 'tells them exactly which document is still missing');
}

console.log('\n── Confirm email, paperwork still outstanding ──');
{
  const a = makeApp('driver', [], { email_verified: false });
  const r = await post('/team/confirm-email', { ref: a.ref });
  ok('the confirmation saves', r.status === 200 && a.email_verified === true, a.email_verified);
  ok('it names the "something is missing" email', r.event === 'compliance_action_required', r.event);
  ok('and it names what is actually outstanding', (r.body.missing || []).length > 0, r.body.missing);
  record('Confirm email', r.event, 'confirms the address, then asks for whatever is still outstanding');
}

console.log('\n── Confirm email, nothing outstanding ──');
{
  const a = makeApp('driver', files(REQ('driver')), {
    email_verified: false, dvla_licence_no: 'X', dvla_check_code: 'Y', ni_number: 'Z',
  });
  const r = await post('/team/confirm-email', { ref: a.ref });
  ok('the confirmation still saves', r.status === 200 && a.email_verified === true, a.email_verified);
  ok('silent — "we have your documents" already went', !r.event, r.event);
  ok('and the portal is not told an email went', r.body.emailed === false, r.body);
}

console.log('\n── Confirm email on a business enquiry ──');
{
  const a = makeApp('business', [], { email_verified: false });
  const r = await post('/team/confirm-email', { ref: a.ref });
  ok('it saves', r.status === 200 && a.email_verified === true, a.email_verified);
  ok('silent — a business enquiry has no document conversation', !r.event, r.event);
}

console.log('\n── Approve ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const r = await patch(a.ref, { status: 'approved' });
  ok('approve still works', r.status === 200, r.status);
  ok('silent BY DESIGN — only Confirm & release may tell anyone they are in', !r.event, r.event);
  ok('and it opens no door', a.access_confirmed_at == null && a.knect !== true, [a.access_confirmed_at, a.knect]);
  record('Approve', r.event, 'silent BY DESIGN — moves the record along, opens nothing');
}

console.log('\n── Reject ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const r = await patch(a.ref, { status: 'rejected', rejectReason: 'Licence does not match the name given', routeBack: 'fix' });
  ok('the decline saves', r.status === 200, r.status);
  ok('it names the "not approved" email', r.event === 'compliance_rejected', r.event);
  ok('the reason the reviewer typed is on the record', a.reject_reason === 'Licence does not match the name given', a.reject_reason);
  record('Reject', r.event, 'tells them it was declined, with the reviewer\'s reason');
}

/* Brent, 14 August: "they get an email with the notes we add to the block and
   reason — they get the notes and the opportunity to go into the
   clever.usehaf.co.uk — sign in and fix any problems". The notes ARE the email,
   so the press is refused without them rather than sent with an empty reason. */
console.log('\n── Block with no reason typed ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const r = await patch(a.ref, { status: 'blocked' });
  ok('the press is refused', r.status === 400, r.status);
  ok('the record is untouched', a.status === 'pending', a.status);
  ok('and nothing is sent', !r.event, r.event);
}

console.log('\n── Block ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const WHY = 'The insurance certificate is in a different name to your licence.';
  const r = await patch(a.ref, { status: 'blocked', blockReason: WHY });
  ok('the block saves', r.status === 200 && a.status === 'blocked', a.status);
  ok('it names the "we have paused your account" email', r.event === 'account_paused', r.event);
  ok('the reviewer\'s words are on the record', a.block_reason === WHY, a.block_reason);
  ok('it is stamped with who pressed it', a.blocked_by === 'cleverg', a.blocked_by);
  ok('and when', !!a.blocked_at, a.blocked_at);
  record('Block', r.event, 'tells them WHY, in your words, and where to go and fix it');
}

/* A freight forwarder hands over no documents, so every other compliance email
   is deliberately withheld from them — but anyone can be blocked, and anyone
   blocked must be told what to put right. */
console.log('\n── Block a freight account ──');
{
  const a = makeApp('freight', []);
  const r = await patch(a.ref, { status: 'blocked', blockReason: 'Company number does not match Companies House.' });
  ok('the block saves', r.status === 200 && a.status === 'blocked', a.status);
  ok('it names the same email — a pause is not a document conversation', r.event === 'account_paused', r.event);
}

/* The pause email says "sign in and put this right". If the door it points at
   is shut, the email is a locked door with a knock on it — the exact failure
   that cost twenty-four days in August. So the door is pressed, not assumed. */
console.log('\n── A paused account can still get in and fix it ──');
{
  const a = makeApp('driver', []);
  await patch(a.ref, { status: 'blocked', blockReason: 'Insurance certificate has expired.' });
  const login = await api('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: a.ref }) });
  ok('they can still sign in', login.status === 200, login.status);
  ok('and the page can read the reason they were paused',
    login.body.block_reason === 'Insurance certificate has expired.', login.body.block_reason);
  const up = await api('/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: a.ref, docs: files(REQ('driver')) }) });
  ok('they can upload the corrected paperwork', up.status === 200, up.status);
  ok('and it lands on the record', (a.docs || []).length === REQ('driver').length, (a.docs || []).length);
  ok('the pause is untouched until a reviewer lifts it', a.status === 'blocked', a.status);
}

console.log('\n── Unblock ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  await patch(a.ref, { status: 'blocked', blockReason: 'Licence photo is unreadable.' });
  const r = await patch(a.ref, { status: 'pending' });
  ok('the unblock saves', r.status === 200 && a.status === 'pending', a.status);
  ok('it names the "active again" email', r.event === 'account_restored', r.event);
  ok('the hold on their email comes off', a.blocked_at === null, a.blocked_at);
  ok('and it is stamped with who lifted it', a.unblocked_by === 'cleverg', a.unblocked_by);
  record('Unblock', r.event, 'tells them the pause is lifted — and promises no access');
}

/* The unblock email is read off the record, never off the button: a press on
   somebody who was never blocked is an ordinary status change and says nothing. */
console.log('\n── A status change on an account that was never blocked ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const r = await patch(a.ref, { status: 'reviewing' });
  ok('it saves', r.status === 200 && a.status === 'reviewing', a.status);
  ok('and does NOT count as an unblock', !r.event, r.event);
  ok('nothing is stamped', a.unblocked_at == null, a.unblocked_at);
}

console.log('\n── Confirm & release access ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const r = await patch(a.ref, { confirm_access: true });
  ok('the release goes through', r.status === 200, r.status);
  ok('it names the full approval email', r.event === 'compliance_approved', r.event);
  ok('it is stamped with who pressed it', a.access_confirmed_by === 'cleverg', a.access_confirmed_by);
  ok('HAF KNECT is switched on', a.knect === true, a.knect);
  record('Confirm & release access', r.event, 'the full approval — account open, KNECT and PLNA both named');
}

console.log('\n── Confirm & release access, paperwork missing ──');
{
  const a = makeApp('freight', []);
  const r = await patch(a.ref, { confirm_access: true });
  ok('the press is refused', r.status === 409, r.status);
  ok('and NO approval email is named', !r.event, r.event);
}

console.log('\n══ MANAGE THIS RECORD ══');

/* Archiving is filing, not a decision. The portal presses it with no notify
   flag on purpose, and offers "Tell them it's on hold" as its own separate
   press once the record is actually archived. Both are tested, because the
   design only holds if the silent one really is silent. */
console.log('\n── Archive ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const r = await post('/team/archive', { ref: a.ref, archived: true });
  ok('the archive is accepted', r.status === 200, r.status);
  ok('silent on purpose — filing somebody is not news for them', !r.event, r.event);
  record('Archive', r.event, 'silent on purpose — filing, reversible, nothing decided');
}

console.log('\n── Tell them it\'s on hold ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  await post('/team/archive', { ref: a.ref, archived: true });
  const r = await post('/team/archive', { ref: a.ref, archived: true, notify: true });
  ok('the press is accepted', r.status === 200, r.status);
  ok('it names the "on hold / closed" email', r.event === 'compliance_application_cancelled', r.event);
  ok('the portal is told an email really went', r.body && r.body.emailed === true, r.body);
}

console.log('\n── Restore to the queue ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  await post('/team/archive', { ref: a.ref, archived: true });
  const r = await post('/team/archive', { ref: a.ref, archived: false });
  ok('the restore is accepted', r.status === 200, r.status);
  ok('silent on purpose — putting a record back is not news either', !r.event, r.event);
  record('Restore to the queue', r.event, 'silent on purpose — puts the record back in the working tabs');
}

console.log('\n── Clear & send back ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  const r = await post('/team/clear', { ref: a.ref, docs: [REQ('driver')[0]] });
  ok('the clear is accepted', r.status === 200, r.status);
  ok('it names the "something is missing" email', r.event === 'compliance_action_required', r.event);
  record('Clear & send back', r.event, 'names what was cleared and asks for it again');
}

console.log('\n── Delete ──');
{
  const a = makeApp('driver', files(REQ('driver')));
  /* the portal makes the reviewer type the reference out before this is live */
  const bare = await post('/team/delete', { ref: a.ref });
  ok('a delete without the reference typed is refused', bare.status === 400, bare.status);
  ok('and that refusal sends nothing', !bare.event, bare.event);
  const r = await post('/team/delete', { ref: a.ref, confirm: a.ref });
  ok('the delete is accepted', r.status === 200, r.status);
  ok('it names the "application closed" email', r.event === 'compliance_application_cancelled', r.event);
  ok('the row really is gone', !apps.some(x => x.ref === a.ref), a.ref);
  record('Delete', r.event, 'tells them before the record goes — sent from a snapshot');
}

console.log('\n══ WHAT EACH BUTTON SENDS ══\n');
const NAMES = {
  compliance_approved: 'Approved — you are in (KNECT + PLNA)',
  compliance_rejected: 'Not approved, with the reason',
  compliance_action_required: 'Something is missing',
  compliance_application_cancelled: 'Your application is closed',
  account_paused: 'Paused — your notes, and how to fix it',
  account_restored: 'Your account is active again',
};
const wide = Math.max(...rows.map(r => r.button.length));
for (const r of rows) {
  const label = r.event ? NAMES[r.event] : '— no email —';
  console.log('  ' + r.button.padEnd(wide) + '   ' + label.padEnd(40) + r.intent);
}

/* Nothing is OPEN any more. Brent settled the last two on 14 August: a blocked
   account is told, in the reviewer's own words, and invited to sign in and put
   things right — so Block and Unblock are tested above like every other press. */
console.log('\n══ SILENT ON PURPOSE ══');
console.log('  Five presses tell the applicant nothing, and each is asserted silent above.');
console.log('  Approve is the one that matters: it moves a record along and opens no door,');
console.log('  so only Confirm & release may ever tell somebody they are in.');

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'ALL ' + pass + ' CHECKS PASS'));
dbSrv.close();
process.exit(fail ? 1 : 0);
