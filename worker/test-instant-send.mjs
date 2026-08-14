/* The sign-up emails now leave on the press instead of on a sweep. This drives
   the real worker with a stubbed network and asks the only questions that
   matter: does the right email go out on the right press, and do the four walls
   still refuse everything they are supposed to refuse?

   Nothing here reaches Mandrill, Supabase or a customer - every outbound call
   is caught and recorded, so a wall that leaks shows up as a send that should
   not be in the list.

   Run: node worker/test-instant-send.mjs                                    */

import worker from './cleverpay-api.js';

const JOIN = 'https://join.usehaf.co.uk';
let sent, patched, claims, state;

/* One application row, bent per case. */
const APP = (over = {}) => ({
  id: 1, ref: 'HAF-CP-TEST', username: 'DAVEF-4821', type: 'driver',
  status: 'pending', journey: 'v2', email: 'dave@example.com', name: 'Dave Ford',
  fname: 'Dave', docs: [], ...over,
});

function stubNetwork({ app = APP(), switches = {}, claimFails = false } = {}) {
  sent = []; patched = []; claims = [];
  /* `exists` is what stops a sign-up test tripping the duplicate-username check:
     before /apply runs there is genuinely no such record to find, and the worker
     asks. Every other case is an existing applicant, so it starts true. */
  state = { app, exists: true };
  /* every moment the set has, on. A moment missing from here reads exactly like
     a moment switched off, which once hid three buttons that send nothing. */
  const sw = { live: true, account_created: true, email_confirm_required: true,
    compliance_submission_complete: true, compliance_action_required: true,
    compliance_approved: true, compliance_rejected: true,
    compliance_application_cancelled: true, membership_upgraded: true,
    plna_allocated: true, ...switches };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const ok = (v) => new Response(JSON.stringify(v), { status: 200,
      headers: { 'Content-Type': 'application/json' } });

    if (u.includes('mandrillapp.com')) {
      sent.push(body);
      return ok([{ status: 'sent', _id: 'prov-1', email: body.message.to[0].email }]);
    }
    if (u.includes('/journey_switch')) {
      return ok(Object.keys(sw).map((k) => ({ key: k, on: sw[k] })));
    }
    if (u.includes('/haf_mail_log')) {
      if (init.method === 'POST') {
        claims.push(body);
        /* what the database does to a second press on the same button */
        if (claimFails) return new Response('{"code":"23505"}', { status: 409 });
        return new Response(JSON.stringify([body]), { status: 201 });
      }
      patched.push(body);
      return ok([body]);
    }
    if (u.includes('cleverpay_applications')) {
      /* A save has to actually change the record, or a test can never tell the
         difference between "the last document landed" and "it did not". */
      if (init.method === 'POST' || init.method === 'PATCH') {
        state.app = { ...state.app, ...body }; state.exists = true;
        return ok([state.app]);
      }
      return ok(state.exists ? [state.app] : []);
    }
    if (u.includes('cleverpay_portal_config')) return ok([{ config: { driver: { docs: [] } } }]);
    return ok([]);
  };
}

/* ctx.waitUntil is where the send actually happens - hold the promises so the
   test waits for the same work the customer's browser does not have to. */
function ctx() {
  const jobs = [];
  return { waitUntil: (p) => jobs.push(p), done: () => Promise.all(jobs) };
}

const ENV = (over = {}) => ({ SB_KEY: 'k', MAIL_KEY: 'md-test', ...over });

async function hit(req, env, c) {
  const res = await worker.fetch(req, env, c);
  await c.done();
  return res;
}

/* A back office reply that names a press, exactly as cleverpay-admin does. */
function adminSaying(ev, ref, item, snap) {
  return { fetch: async () => {
    const h = new Headers({ 'Content-Type': 'application/json' });
    if (ev) { h.set('x-cp-event', ev); h.set('x-cp-ref', ref); }
    if (item) h.set('x-cp-item', encodeURIComponent(item));
    if (snap) h.set('x-cp-snap', encodeURIComponent(JSON.stringify(snap)));
    return new Response('{"ok":true}', { status: 200, headers: h });
  } };
}

const press = (ev, ref = 'HAF-CP-TEST', item) => new Request(
  'https://clever.usehaf.co.uk/team/applications/' + ref,
  { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

const T = [];
const test = (name, fn) => T.push([name, fn]);

/* ── 1. the account email leaves on the sign-up request itself ── */
test('sign-up sends the account-created email, from knect@', async () => {
  stubNetwork();
  state.exists = false;
  const c = ctx();
  await hit(new Request('https://clever.usehaf.co.uk/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: JOIN },
    body: JSON.stringify({ type: 'driver', username: 'DAVEF-4821', pinHash: 'x',
      email: 'dave@example.com', fname: 'Dave' }),
  }), ENV(), c);
  /* Two emails leave a sign-up, and the second one is the point of the first:
     the account exists, and here is how you prove the address is yours. Both
     are found by NAME rather than by position - which one wins the race to
     Mandrill is not something a customer can see, and not something a test
     should have an opinion about. */
  const created = sent.find((s) => s.template_name === 'haf-j1-account-created-driver');
  const confirm = sent.find((s) => s.template_name === 'haf-j2-confirm-email');
  check('two emails sent: the account, and how to confirm it',
    sent.length === 2, 'sent ' + sent.length);
  check('driver wording', !!created, sent.map((s) => s.template_name).join(', '));
  check('from knect@', created?.message.from_email === 'knect@usehaf.co.uk');
  check('signs off as HAF TEAM', created?.message.from_name === 'HAF TEAM');
  check('reply goes back to the same box',
    created?.message.headers['Reply-To'] === created?.message.from_email);

  /* The 4 August fault, written down as an assertion: an email that asks
     somebody to confirm their address must carry the thing that lets them do
     it. A bare homepage link confirms nobody, and it looked perfectly fine
     from our side for twenty-four days. */
  const cUrl = confirm?.message.global_merge_vars
    .find((v) => v.name === 'action_url')?.content;
  check('the confirm email goes at all', !!confirm);
  check('its button goes to the confirm page', !!cUrl && cUrl.includes('/confirm.html'), cUrl);
  check('its button carries this person\'s reference', !!cUrl && cUrl.includes('ref=HAF-CP-'), cUrl);
  check('its button carries a token long enough to be one',
    (cUrl?.match(/[?&]t=([^&]+)/)?.[1] || '').length >= 24, cUrl);
  /* Read from the RECORD, not from the ledger: the question is whether the
     database would recognise the token in that button, and only the record can
     answer it. A link whose token nothing has stored confirms nobody, and from
     the sending side it looks identical to one that works. */
  check('the token in the button is the one stored on the record',
    !!state.app?.email_confirm_token && !!cUrl
      && cUrl.includes('t=' + state.app.email_confirm_token),
    state.app?.email_confirm_token ? 'stored, but not the one sent' : 'nothing stored');
  check('and the record remembers when it was sent', !!state.app?.email_confirm_sent_at);

  check('ledger claimed before each send',
    claims.length === 2 && claims.every((k) => k.status === 'sending'),
    'claims ' + claims.length);
  check('ledger settled after them',
    patched.filter((p) => p.status === 'sent').length === 2);
});

/* ── 2. a freight forwarder gets their own wording and their own road ── */
test('freight sign-up goes to KNECT, never to the document site', async () => {
  stubNetwork({ app: APP({ type: 'freight' }) });
  state.exists = false;
  const c = ctx();
  await hit(new Request('https://clever.usehaf.co.uk/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: JOIN },
    body: JSON.stringify({ type: 'freight', username: 'FF-1', pinHash: 'x',
      email: 'f@example.com', company: 'Kite Freight' }),
  }), ENV(), c);
  const url = sent[0]?.message.global_merge_vars.find((v) => v.name === 'action_url');
  check('freight wording', sent[0]?.template_name === 'haf-j1-account-created-freight');
  check('button points at KNECT', url?.content === 'https://knect.usehaf.co.uk', url?.content);
});

/* ── 3. wall 3: approve alone tells nobody ── */
test('approved WITHOUT a named release sends nothing', async () => {
  stubNetwork({ app: APP({ status: 'approved', approved_by: 'gemma' }) });
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying('compliance_approved', 'HAF-CP-TEST') }), c);
  check('nothing sent', sent.length === 0, JSON.stringify(sent.map((s) => s.template_name)));
  check('nothing even claimed', claims.length === 0);
});

/* ── 4. ... and the release press does ── */
test('Confirm & release sends the approved email', async () => {
  stubNetwork({ app: APP({ status: 'approved', access_confirmed_at: '2026-08-14T06:00:00Z',
    access_confirmed_by: 'gemma' }) });
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying('compliance_approved', 'HAF-CP-TEST') }), c);
  check('one email sent', sent.length === 1);
  check('approved wording', sent[0]?.template_name === 'haf-j5-approved-driver');
  check('from knect@', sent[0]?.message.from_email === 'knect@usehaf.co.uk');
});

/* ── 5. wall 1: the people already in the system are unreachable ── */
test('someone who did not come through the new front door hears nothing', async () => {
  stubNetwork({ app: APP({ journey: null, access_confirmed_at: 'x', access_confirmed_by: 'gemma' }) });
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying('compliance_approved', 'HAF-CP-TEST') }), c);
  check('nothing sent', sent.length === 0);
});

/* ── 6. wall 2: the master switch ── */
test('master switch off stops everything', async () => {
  stubNetwork({ app: APP({ access_confirmed_at: 'x', access_confirmed_by: 'gemma' }),
    switches: { live: false } });
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying('compliance_approved', 'HAF-CP-TEST') }), c);
  check('nothing sent', sent.length === 0);
});

test('one moment can be switched off without touching the rest', async () => {
  stubNetwork({ app: APP({ access_confirmed_at: 'x', access_confirmed_by: 'gemma' }),
    switches: { compliance_approved: false } });
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying('compliance_approved', 'HAF-CP-TEST') }), c);
  check('nothing sent', sent.length === 0);
});

/* ── 7. wall 4: two presses in the same second ── */
test('a second press on the same button sends nothing', async () => {
  stubNetwork({ app: APP({ access_confirmed_at: 'x', access_confirmed_by: 'gemma' }),
    claimFails: true });
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying('compliance_approved', 'HAF-CP-TEST') }), c);
  check('claim attempted', claims.length === 1);
  check('nothing sent', sent.length === 0);
});

/* ── 8. a freight account can never be pulled into the document journey ── */
test('freight never receives a compliance email', async () => {
  stubNetwork({ app: APP({ type: 'freight', access_confirmed_at: 'x', access_confirmed_by: 'gemma' }) });
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying('compliance_approved', 'HAF-CP-TEST') }), c);
  check('nothing sent', sent.length === 0);
});

/* ── 9. chasing a document says WHICH document ── */
test('the chase names the missing document', async () => {
  stubNetwork();
  const c = ctx();
  await hit(new Request('https://clever.usehaf.co.uk/team/remind', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  ENV({ ADMIN: adminSaying('compliance_action_required', 'HAF-CP-TEST',
    'Goods in Transit insurance') }), c);
  const item = sent[0]?.message.global_merge_vars.find((v) => v.name === 'item_name');
  const why = sent[0]?.message.global_merge_vars.find((v) => v.name === 'item_reason');
  check('one email sent', sent.length === 1);
  check('action-required wording', sent[0]?.template_name === 'haf-j4-action-required');
  check('names the document', item?.content === 'Goods in Transit insurance', item?.content);
  check('tells them what to do', (why?.content || '').includes('upload it'));
});

/* ── 10. a rejection offers no way back unless a reviewer opened one ── */
test('rejection carries no way back by default', async () => {
  stubNetwork({ app: APP({ status: 'rejected', reject_reason: 'Insurance expired' }) });
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying('compliance_rejected', 'HAF-CP-TEST') }), c);
  check('closed wording, not the reapply one',
    sent[0]?.template_name === 'haf-j6-not-approved-closed', sent[0]?.template_name);
});

test('a reviewer CAN open one deliberately', async () => {
  /* route_back is the column the migration, the copy set and the backstop
     engine all use. This test asked for `reject_route` - a name nothing ever
     writes - and it passed against a worker reading that same wrong name. The
     two agreed with each other and neither agreed with the database, which is
     how a decline would have gone out as the closed version however hard a
     reviewer tried to open a way back. */
  stubNetwork({ app: APP({ status: 'rejected', route_back: 'fix' }) });
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying('compliance_rejected', 'HAF-CP-TEST') }), c);
  check('fix-and-resend wording', sent[0]?.template_name === 'haf-j6-not-approved-fix');
});

/* ── 11. no key, no send - a preview must be safe to walk through ── */
test('a deployment with no sending key cannot email anyone', async () => {
  stubNetwork({ app: APP({ access_confirmed_at: 'x', access_confirmed_by: 'gemma' }) });
  const c = ctx();
  await hit(press(), ENV({ MAIL_KEY: '', ADMIN: adminSaying('compliance_approved', 'HAF-CP-TEST') }), c);
  check('nothing sent', sent.length === 0);
  check('nothing claimed either', claims.length === 0);
});

/* ── 12. a press with no email attached stays silent ── */
test('an ordinary edit in the back office sends nothing', async () => {
  stubNetwork();
  const c = ctx();
  await hit(press(), ENV({ ADMIN: adminSaying(null) }), c);
  check('nothing sent', sent.length === 0);
});

/* ── 13. a Mandrill failure is recorded, and never breaks the press ── */
test('a rejected send is written down, not swallowed', async () => {
  stubNetwork({ app: APP({ access_confirmed_at: 'x', access_confirmed_by: 'gemma' }) });
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes('mandrillapp')
    ? new Response(JSON.stringify([{ status: 'rejected', reject_reason: 'hard-bounce' }]), { status: 200 })
    : real(u, i));
  const c = ctx();
  const res = await hit(press(), ENV({ ADMIN: adminSaying('compliance_approved', 'HAF-CP-TEST') }), c);
  check('the button still answered 200', res.status === 200);
  check('the failure is on the ledger',
    patched[0]?.status === 'failed' && String(patched[0]?.error).includes('hard-bounce'),
    JSON.stringify(patched[0]));
});

/* ── 14. the last document in sends "we have got them" ── */
test('the last required document sends the acknowledgement', async () => {
  stubNetwork({ app: APP({ docs: [{ id: 'dl-front', path: 'p' }] }) });
  /* the office wants two things; the applicant has just sent the second */
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes('cleverpay_portal_config')
    ? new Response(JSON.stringify([{ config: { driver: { docs: [
        { id: 'dl-front', status: 'required' }, { id: 'gi', status: 'required' },
        { id: 'dbs', status: 'optional' }] } } }]), { status: 200 })
    : real(u, i));
  const c = ctx();
  await hit(new Request('https://clever.usehaf.co.uk/docs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'HAF-CP-TEST',
      docs: [{ id: 'dl-front', path: 'p' }, { id: 'gi', path: 'p' }] }) }), ENV(), c);
  check('one email sent', sent.length === 1, JSON.stringify(sent.map((x) => x.template_name)));
  check('documents-received wording', sent[0]?.template_name === 'haf-j3-documents-received');
  check('from updates@', sent[0]?.message.from_email === 'updates@usehaf.co.uk');
});

test('a half-finished upload says nothing', async () => {
  stubNetwork({ app: APP({ docs: [] }) });
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes('cleverpay_portal_config')
    ? new Response(JSON.stringify([{ config: { driver: { docs: [
        { id: 'dl-front', status: 'required' }, { id: 'gi', status: 'required' }] } } }]), { status: 200 })
    : real(u, i));
  const c = ctx();
  await hit(new Request('https://clever.usehaf.co.uk/docs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'HAF-CP-TEST', docs: [{ id: 'dl-front', path: 'p' }] }) }), ENV(), c);
  check('nothing sent', sent.length === 0);
});

test('a freight account uploading anything is never acknowledged as a driver', async () => {
  stubNetwork({ app: APP({ type: 'freight' }) });
  const c = ctx();
  await hit(new Request('https://clever.usehaf.co.uk/docs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'HAF-CP-TEST', docs: [{ id: 'incorp', path: 'p' }] }) }), ENV(), c);
  check('nothing sent', sent.length === 0);
});

/* ── the three presses that used to say nothing ──
   Archive-with-notify, Clear and Delete all wrote into a queue that an engine
   collected later. That engine is off, so each of them told the applicant
   nothing at all. They name their moment now, like every other button. */

/* the back office having pressed Delete: the record is genuinely gone by the
   time the front worker gets its turn, which is the whole point of the case */
const deleted = () => { stubNetwork(); state.app = null; state.exists = false; };
const teamPress = (path = '/team/delete') => new Request('https://clever.usehaf.co.uk' + path,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

test('deleting an application still tells the person, after the record has gone', async () => {
  deleted();
  const c = ctx();
  await hit(teamPress(), ENV({ ADMIN: adminSaying('compliance_application_cancelled', 'HAF-CP-TEST', '', {
    ref: 'HAF-CP-TEST', email: 'driver@example.com', type: 'driver', journey: 'v2', fname: 'Sam',
  }) }), c);
  check('one email sent', sent.length === 1, 'sent ' + sent.length);
  check('the cancelled wording', sent[0]?.template_name === 'haf-j7-application-cancelled',
    sent[0]?.template_name);
  check('from updates@', sent[0]?.message.from_email === 'updates@usehaf.co.uk');
  check('addressed to the person who was deleted',
    sent[0]?.message.to[0].email === 'driver@example.com');
});

test('a deleted freight account is not dragged into the document journey', async () => {
  deleted();
  const c = ctx();
  await hit(teamPress(), ENV({ ADMIN: adminSaying('compliance_application_cancelled', 'HAF-CP-TEST', '', {
    ref: 'HAF-CP-TEST', email: 'freight@example.com', type: 'freight', journey: 'v2', fname: 'Ada',
  }) }), c);
  check('nothing sent', sent.length === 0);
});

test('a snapshot cannot walk an old applicant past the front-door wall', async () => {
  deleted();
  const c = ctx();
  await hit(teamPress(), ENV({ ADMIN: adminSaying('compliance_application_cancelled', 'HAF-CP-OLD', '', {
    ref: 'HAF-CP-OLD', email: 'old@example.com', type: 'driver', journey: null, fname: 'Pat',
  }) }), c);
  check('nothing sent', sent.length === 0);
});

test('a snapshot cannot switch itself on when the switchboard is off', async () => {
  stubNetwork({ switches: { live: false } });
  state.app = null; state.exists = false;
  const c = ctx();
  await hit(teamPress(), ENV({ ADMIN: adminSaying('compliance_application_cancelled', 'HAF-CP-TEST', '', {
    ref: 'HAF-CP-TEST', email: 'driver@example.com', type: 'driver', journey: 'v2', fname: 'Sam',
  }) }), c);
  check('nothing sent', sent.length === 0);
});

test('a mangled snapshot falls back to the record rather than sending nonsense', async () => {
  stubNetwork();
  const c = ctx();
  const admin = { fetch: async () => new Response('{"ok":true}', { status: 200, headers: new Headers({
    'Content-Type': 'application/json', 'x-cp-event': 'compliance_application_cancelled',
    'x-cp-ref': 'HAF-CP-TEST', 'x-cp-snap': '%%%not-json%%%' }) }) };
  await hit(teamPress(), ENV({ ADMIN: admin }), c);
  check('the real record was used', sent.length === 1, 'sent ' + sent.length);
  check('addressed from the record', sent[0]?.message.to[0].email === 'dave@example.com');
});

test('clearing an application tells them what to send back', async () => {
  stubNetwork();
  const c = ctx();
  await hit(teamPress('/team/clear'),
    ENV({ ADMIN: adminSaying('compliance_action_required', 'HAF-CP-TEST',
      'Driving licence, Proof of address') }), c);
  check('one email sent', sent.length === 1);
  check('action-required wording', sent[0]?.template_name === 'haf-j4-action-required');
  const item = sent[0]?.message.global_merge_vars.find((v) => v.name === 'item_name');
  check('names what is outstanding', item?.content === 'Driving licence, Proof of address', item?.content);
});

test('archiving with the tick tells them, archiving silently does not', async () => {
  stubNetwork();
  let c = ctx();
  await hit(teamPress('/team/archive'),
    ENV({ ADMIN: adminSaying('compliance_application_cancelled', 'HAF-CP-TEST') }), c);
  check('the tick sends one', sent.length === 1 && sent[0].template_name === 'haf-j7-application-cancelled',
    sent[0]?.template_name);
  stubNetwork();
  c = ctx();
  await hit(teamPress('/team/archive'), ENV({ ADMIN: adminSaying(null) }), c);
  check('filing quietly sends nothing', sent.length === 0);
});

console.log('\nThe sign-up emails, sent on the press\n');
for (const [name, fn] of T) {
  console.log('- ' + name);
  try { await fn(); } catch (e) { fail++; console.log('  FAIL threw -- ' + e.message); }
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
