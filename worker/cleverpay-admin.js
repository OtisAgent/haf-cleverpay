/* CleverPay back office — Cloudflare Worker (cleverpay-admin)

   Everything the HAF team does in the portal lives here: sign in, the queue, the
   documents on a record, corrections, and taking an application off the portal.
   The applicant-facing API is the other worker, cleverpay-api.

   Why it is a second worker. A deploy has to travel through a pipe that caps the
   whole upload at 20,000 characters, and the single worker had reached 21,579 —
   nothing could go live, or even to a preview, however small the change. The
   minifier had nothing left to give (measured: the biggest saving available from
   de-duplicating repeated text was 68 characters), so the back office moved out
   on its own. Each half now has years of room.

   It has no public address of its own: cleverpay-api reaches it over a private
   binding and hands it the database key on the request, so the secret still lives
   in exactly one place and this script holds nothing at rest. */


const SB = 'https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1';
const APPS = 'cleverpay_applications';
const OK_ORIGINS = ['https://clever.usehaf.co.uk', 'https://otisagent.github.io', 'https://plna.usehaf.co.uk'];
/* compliance files live in a PRIVATE bucket — reachable only with the service key, never by URL */
const DOCS = 'https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/';
const DOC_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];
const store = (env, path, init) => fetch(DOCS + path, { ...init,
  headers: { apikey: env.SB_KEY, Authorization: 'Bearer ' + env.SB_KEY, ...(init.headers || {}) } });

function corsHeaders(req) {
  const o = req.headers.get('Origin') || '';
  const ok = OK_ORIGINS.includes(o) || o.endsWith('.workers.dev') || o.endsWith('.pages.dev') || o.endsWith('.vercel.app');
  return {
    'Access-Control-Allow-Origin': ok ? o : OK_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Cache-Control': 'no-store',
  };
}
const J = (data, status, cors) =>
  new Response(S(data), { status, headers: { [CT]: AJ, ...cors } });

/* ── name the press, so the email leaves with it ──
   Brent, 14 Aug: an email must arrive within ten seconds of the button, not on
   the next sweep. The press happens in here; the sending key lives in the front
   worker, in one place and one place only. So this worker does not send - it
   writes the name of the moment onto its own reply, and the front worker reads
   it and sends on the same request. A reply with no name attached sends
   nothing, which is what every other button in this back office does.
   Anything a reviewer typed is URL-encoded: a header carries plain Latin
   characters only, and one accented name would otherwise take the whole
   response down with it. */
function named(res, ev, ref, item, snap) {
  const h = new Headers(res.headers);
  h.set('x-cp-event', ev);
  h.set('x-cp-ref', St(ref));
  if (item) h.set('x-cp-item', encodeURIComponent(St(item).slice(0, 300)));
  /* Deleting is the one press that destroys the thing the email is about. The
     front worker would find nothing to read, so the parts it needs travel with
     the reply instead - taken before the row went, never afterwards. */
  if (snap) h.set('x-cp-snap', encodeURIComponent(S(snap)));
  return new Response(res.body, { status: res.status, headers: h });
}

/* Only what an email actually needs: who they are, what they signed up as,
   which journey they are on. No documents, no licence number, no notes - a
   header is the wrong place for any of it and none of it is used. */
function snapshot(app) {
  return {
    ref: app.ref, email: app.email, type: app.type, journey: app.journey,
    fname: app.fname, name: app.name, company: app.company,
    plan: app.plan, tier: app.tier, username: app.username,
    may_reapply: app.may_reapply === true,
  };
}

async function sb(env, path, init = {}) {
  const r = await fetch(SB + path, {
    ...init,
    headers: {
      apikey: env.SB_KEY,
      Authorization: 'Bearer ' + env.SB_KEY,
      [CT]: AJ,
      Prefer: init.method === 'POST' || init.method === 'PATCH' ? 'return=representation' : undefined,
      ...init.headers,
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

/* Two shorthands that exist for size as much as for reading: the deployable worker
   goes up through a pipe that caps the whole upload at 20,000 characters, and these
   two expressions appeared 15 and 6 times respectively. */
const nowIso = () => new Date().toISOString();
/* Same reason: the built worker must fit a 20,000-character upload, and a minifier
   cannot shorten a built-in's name — only ours. */
const S = JSON.stringify;
const E = encodeURIComponent;
const St = String;
const NOTFOUND = 'Not found.';
/* Event names repeat across the button handlers; naming them once keeps the
   built artifact inside the 20,000-byte upload envelope. */
const EV_ACT = 'compliance_action_required';
const EV_CANX = 'compliance_application_cancelled';
/* Said in two places, so it is written once - same reason as the event names. */
const NOCFG = 'Could not read the document settings — try again in a moment.';
const NOAUTH = 'Not authorised.';
const CT = 'Content-Type';
const AJ = 'application/json';

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const strip = a => { if (!a) return a; const { pin_hash, ...rest } = a; return rest; };
const newRef = () => 'HAF-CP-' + [...crypto.getRandomValues(new Uint8Array(4))].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

async function findApp(env, id) {
  const q = E(id.toUpperCase());
  const r = await sb(env, `/${APPS}?or=(ref.eq.${q},username.eq.${q})&limit=1`);
  return r.ok && r.body && r.body[0] ? r.body[0] : null;
}

/* ── the driving-record check ──
   A photo of a photocard only proves the card exists. It says nothing about what
   is actually on the record — points, disqualifications, or whether the licence
   is still valid at all. GOV.UK "View or share your driving licence information"
   lets the driver turn their own record into a check code the compliance team can
   look up, which is the only lawful way we can see it.

   Three things are taken together because none of them works alone: the code is
   useless without the licence number, and the driver cannot generate the code
   without their National Insurance number (which payroll needs in any case).
   The code also dies after 21 days — CODE_LIFE_DAYS — so it is stamped when it
   arrives and the portal shows its age rather than letting somebody try a dead one. */
const NI_LABEL = 'National Insurance number';
const CODE_LIFE_DAYS = 21;
const NI_RE = /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/;
const DL_RE = /^[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}$/;
const CODE_RE = /^[A-Za-z0-9]{8}$/;

/* Validates what the driver typed and returns the columns to write.
   The check code is deliberately NOT upper-cased — DVLA codes are case
   sensitive, and "helpfully" tidying the case would break every lookup. */
function readDvla(d, app) {
  const lic = St(d.licence || '').toUpperCase().replace(/[\s-]/g, '');
  const code = St(d.code || '').replace(/[\s-]/g, '');
  const ni = St(d.ni || '').toUpperCase().replace(/[\s-]/g, '');
  if (lic && !DL_RE.test(lic))
    return { error: 'That driving licence number doesn’t look right — it is the 16 characters printed at 5 on the front of your photocard.' };
  if (code && !CODE_RE.test(code))
    return { error: 'A DVLA check code is 8 letters and numbers — check it and enter it exactly as GOV.UK showed it.' };
  if (ni && !NI_RE.test(ni))
    return { error: 'That National Insurance number doesn’t look right — two letters, six numbers, then one letter, like AB123456C.' };
  const patch = { dvla_licence_no: lic || null, dvla_check_code: code || null, ni_number: ni || null };
  /* a new code is a new check: whoever confirmed the old one confirmed a different record */
  const fresh = code && code !== (app && app.dvla_check_code);
  if (fresh) { patch.dvla_code_at = nowIso(); patch.dvla_checked_at = null; patch.dvla_checked_by = null; }
  if (!code) { patch.dvla_code_at = null; patch.dvla_checked_at = null; patch.dvla_checked_by = null; }
  return { patch };
}

/* ── what the team may correct by hand, in the words the record shows ──
   The label is what goes in the change history, so it reads as a sentence a
   non-technical reviewer understands months later. Anything not on this list
   cannot be edited through the portal at all: the username (their login to
   three systems), the status and release stamps (decisions, made elsewhere,
   with their own audit), the payment record and every PIN. */
const EDIT_FIELDS = {
  fname: 'first name', lname: 'last name', email: 'email address', phone: 'phone number',
  dob: 'date of birth', vtype: 'vehicle type', vreg: 'vehicle reg',
  company: 'company name', crn: 'company number', vat: 'VAT number',
  name: 'contact name', title: 'job title',
};
const DVLA_LABELS = {
  dvla_licence_no: 'driving licence number', dvla_check_code: 'DVLA check code', ni_number: NI_LABEL,
};

/* No column exists for an audit trail and the applications table is not mine to
   alter, so the history lives at the foot of the record notes behind a marker:
   free notes above it are the team's, everything below is written by the portal.
   Twenty entries is the ceiling — enough to see a pattern, not enough to bury
   what somebody actually wrote. */
const HIST_MARK = '— — record changes — —';
const freeNotes = n => { const s = St(n || ''); const i = s.indexOf(HIST_MARK); return i === -1 ? s : s.slice(0, i); };
function recordHistory(freeIn, oldNotes, who, phrase) {
  const s = St(oldNotes || '');
  const i = s.indexOf(HIST_MARK);
  const prior = i === -1 ? [] : s.slice(i + HIST_MARK.length).split('\n').map(l => l.trim()).filter(Boolean);
  const free = St(freeIn === undefined || freeIn === null ? freeNotes(s) : freeIn).replace(/\s+$/, '');
  const when = nowIso().slice(0, 16).replace('T', ' ');
  const kept = prior.concat(`${when} · ${who} ${phrase}`).slice(-20);
  return (free ? free + '\n\n' : '') + HIST_MARK + '\n' + kept.join('\n');
}

/* Which required documents are still outstanding on this application.
   Worked out from the config the team saved — the same list the portal shows —
   so a reminder can never ask for a document the settings no longer require.
   The driving-record check rides alongside: it is not a file, but it is
   compliance, so a chase that ignored it would ask for half of what we need. */
function missingRequired(cfg, app) {
  const set = app.type === 'freight' ? (cfg && cfg.freight) : (cfg && cfg.driver);
  const defs = (set && Array.isArray(set.docs) ? set.docs : []).filter(d => d.status === 'required');
  const have = (Array.isArray(app.docs) ? app.docs : []).map(d => d.id);
  const out = defs.filter(d => !have.includes(d.id)).map(d => ({ id: d.id, name: d.name, hint: d.hint || '' }));
  if (app.type === 'driver') {
    if (!app.dvla_licence_no) out.push({ id: 'dvla-licence-no', name: 'Driving licence number',
      hint: 'The 16 characters printed at 5 on the front of your photocard.' });
    if (!app.dvla_check_code) out.push({ id: 'dvla-check-code', name: 'DVLA check code',
      hint: 'Create one at https://www.gov.uk/view-driving-licence — it lets us see your driving record without you sending anything else. It expires after ' + CODE_LIFE_DAYS + ' days.' });
    if (!app.ni_number) out.push({ id: 'ni-number', name: NI_LABEL,
      hint: 'You need it to create the check code, and we need it to set your payments up.' });
  }
  return out;
}

/* One sentence, ten places. Every one of these is the same apology and the
   same instruction, and ten copies of it is ten chances for one to drift. */
const TRY = ' \u2014 please try again.';

/* every write to an application goes through here */
const patchApp = (env, ref, patch) =>
  sb(env, `/${APPS}?ref=eq.${E(ref)}`, { method: 'PATCH', body: S(patch) });

/* The document requirement set, read in one place. Three routes need it and
   each spelled the same fetch out longhand; a fourth would have been a fourth
   copy of a line that has to stay identical to be correct. */
const readCfg = async (env) => {
  const r = await sb(env, '/cleverpay_portal_config?id=eq.1&limit=1');
  return r.ok && r.body && r.body[0] ? r.body[0].config : null;
};

/* Who this office may write to. There are exactly three silences and they are
   the same three everywhere: nobody left an address, they asked us not to, or
   they are blocked. Written once so a route cannot quietly honour two of them. */
const canMail = (a) => !!(a && a.email && !a.reminder_opt_out && !a.blocked_at);

async function teamUser(env, req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  const r = await sb(env, `/cleverpay_team_sessions?token=eq.${E(m[1])}&limit=1`);
  const s = r.ok && r.body && r.body[0];
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return s.username;
}

const APP_FIELDS = ['type','username','pin_hash','fname','lname','email','phone','dob','vtype','vreg',
  'company','crn','vat','name','title','knect','docs','status','notes','founders_tier','promo_code'];
function pickFields(b) {
  const row = {};
  for (const k of APP_FIELDS) if (b[k] !== undefined) row[k] = b[k];
  if (b.pinHash) row.pin_hash = b.pinHash;
  return row;
}

const INTEGRATION_USERS = ['bf638793', 'cleverg'];
const canIntegrate = (u) => INTEGRATION_USERS.includes(St(u || '').toLowerCase().trim());

const newApiKey = () =>
  'cpk_' + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('');
const keyHash = (k) => sha256('HAF-CP-KEY|' + k);

/* ── taking an application off the portal ──
   Brent, 4 Aug: "allow us to delete application off the portal or archive or
   clear and resend to the user". Three different jobs, and the difference
   between them matters more than the buttons do.

   ARCHIVE is a view, not a decision. It must not touch the status: 'approved'
   is a compliance judgement that other systems read — the access door, the
   email engine, the back-office API — so quietly rewriting it to tidy a list
   would revoke somebody's access as a side effect of housekeeping. There is no
   column to add (the table is not mine to alter), so an archive is written into
   the same portal-owned history block as every other change and the list simply
   hides whatever was archived last. Nothing else about the record changes, and
   it comes back exactly as it was.

   CLEAR sends somebody back to the start: their paperwork is taken off the
   record and out of the private bucket, the driving-record entries and both
   ticks go with it, and the account drops back to pending with the approval and
   release stamps cleared. Network access goes off with it — a person whose
   evidence has just been thrown away must not stay inside the door on the
   strength of it. Their login survives, because they need it to come back in.
   The chase email that is already live then goes out listing everything now
   outstanding, which after a clear is everything.

   DELETE is the only one that cannot be undone, so it is the only one that is
   not for everybody: Brent and the compliance lead, and only after typing the
   reference out. The files go from the bucket, the row goes from the table, and
   a line goes to the compliance group on Telegram — once the row is gone there
   is nowhere left to keep the history, and a destructive act with no record of
   it is exactly what a compliance file exists to prevent. */
const ARCHIVED = 'archived this application';
const RESTORED = 'restored this application';
const CLEARED = 'cleared this application and sent it back to the applicant';
function isArchived(notes) {
  const s = St(notes || '');
  const i = s.indexOf(HIST_MARK);
  if (i === -1) return false;
  const marks = s.slice(i).split('\n').filter(l => l.endsWith(ARCHIVED) || l.endsWith(RESTORED));
  return marks.length ? marks[marks.length - 1].endsWith(ARCHIVED) : false;
}
/* the record as the portal sees it: never the PIN, always whether it is archived */
const view = a => a && { ...strip(a), archived: isArchived(a.notes) };

/* Compliance files live in a private bucket keyed by the reference, so they
   outlive the row unless they are taken out with it. Failure to remove a file
   must not abandon the operation half-done — the record is what people act on. */
async function dropFiles(env, app) {
  for (const d of (Array.isArray(app.docs) ? app.docs : [])) {
    if (d && d.path) { try { await store(env, d.path, { method: 'DELETE' }); } catch {} }
  }
}

/* One plain line to the compliance group. No markup, no mention: this is a
   record that something irreversible happened, and it must not be the thing
   that fails. */
async function tellTeam(env, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { [CT]: AJ },
      body: S({ chat_id: env.TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch {}
}

/* The farewell queue that used to live here is gone. It wrote the applicant's
   notice into a table for an engine to collect on its next pass — and Brent's
   14 August instruction is that these arrive within ten seconds of the button,
   not on a sweep. Every one of its three buttons now names its moment on the
   way out instead, which is the same road every other press already takes.
   Nothing reads cleverpay_farewells any more; the table is left alone because
   what it holds is a record of what was sent. */

export default {
  async fetch(req, bound, ctx) {
    const cors = corsHeaders(req);
    const bad = (error, status) => J({ error }, status, cors);
    const M = req.method;
    if (M === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    /* the keys arrive on the request from cleverpay-api and are never stored here */
    const env = {
      SB_KEY: req.headers.get('x-cp-key') || bound.SB_KEY,
      TG_TOKEN: req.headers.get('x-cp-tg') || bound.TG_TOKEN,
      TG_CHAT: req.headers.get('x-cp-tgchat') || bound.TG_CHAT,
    };
    if (!env.SB_KEY) return bad('The back office could not reach the records — please tell HAF.', 503);
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const R = (path, method) => p === path && M === method;
    let b = {};
    if (M !== 'GET') { try { b = await req.json(); } catch {} }

    try {
      /* ── team: log in ──
         First-time members have must_set_pin set: they sign in once with the one-time
         setup code they were given, then choose their own PIN (see /team/set-pin). */
      if (R('/team/login', 'POST')) {
        const u = (b.username || '').toLowerCase().trim();
        const hash = await sha256('HAF-CP-TEAM|' + u + '|' + (b.password || ''));
        const r = await sb(env, `/cleverpay_team_users?username=eq.${E(u)}&limit=1`);
        const user = r.ok && r.body && r.body[0];
        if (!user) return bad('Wrong username or password.', 401);
        const first = !!user.must_set_pin;
        const ok = first
          ? !!user.setup_code && (b.password || '').trim().toUpperCase() === user.setup_code.toUpperCase()
          : user.pw_hash === hash;
        if (!ok) return bad(first ? 'That setup code is not right.' : 'Wrong username or password.', 401);
        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
        const expires = new Date(Date.now() + (first ? 36e5 : 7 * 864e5)).toISOString();
        await sb(env, '/cleverpay_team_sessions', { method: 'POST', body: S({ token, username: u, expires_at: expires }) });
        return J({ token, username: u, name: user.name, role: user.role, mustSetPin: first }, 200, cors);
      }

      /* ── everything below needs a session ── */
      const who = await teamUser(env, req);
      if (!who) return bad('Session expired — sign in again.', 401);
      const ur = await sb(env, `/cleverpay_team_users?username=eq.${E(who)}&limit=1`);
      const me = ur.ok && ur.body && ur.body[0];
      if (!me) return bad('Session expired — sign in again.', 401);

      /* choose / change your own PIN — nobody else ever sets it for you */
      if (R('/team/set-pin', 'POST')) {
        const pin = (b.pin || '').trim();
        if (!/^\d{4,6}$/.test(pin)) return bad('Your PIN must be 4 to 6 numbers.', 400);
        if (!me.must_set_pin) {
          const current = await sha256('HAF-CP-TEAM|' + who + '|' + (b.currentPin || ''));
          if (current !== me.pw_hash) return bad('Your current PIN is not right.', 401);
        }
        const pw = await sha256('HAF-CP-TEAM|' + who + '|' + pin);
        const r = await sb(env, `/cleverpay_team_users?username=eq.${E(who)}`,
          { method: 'PATCH', body: S({ pw_hash: pw, must_set_pin: false, setup_code: null }) });
        if (!r.ok) return bad('Could not save your PIN' + TRY, 500);
        const tk = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
        await sb(env, `/cleverpay_team_sessions?token=eq.${E(tk)}`,
          { method: 'PATCH', body: S({ expires_at: new Date(Date.now() + 7 * 864e5).toISOString() }) });
        return J({ ok: true }, 200, cors);
      }

      /* a first-time member sees nothing else until their PIN is set */
      if (me.must_set_pin) return bad('Choose your PIN first.', 403);

      if (R('/team/applications', 'GET')) {
        const r = await sb(env, `/${APPS}?order=submitted.desc&limit=500`);
        return J((r.body || []).map(view), 200, cors);
      }

      /* ── the sign-up email switchboard ──
         The switch that starts customer emails going is never reachable with
         a public key from a browser, so the console asks for it here instead
         and this worker reads it with the service role. Every flip records
         who made it, because "the emails came back on" must always have a
         name against it. */
      if (R('/team/journey', 'GET')) {
        const [sw, log] = await Promise.all([
          sb(env, '/journey_switch?select=key,on,updated_at,updated_by'),
          sb(env, '/haf_mail_log?select=event,email,status,created_at'
                + '&order=created_at.desc&limit=50')
        ]);
        if (!sw.ok) return bad('Cannot reach the switchboard right now.', 502);
        return J({ switches: sw.body || [], recent: log.ok ? (log.body || []) : [] },
          200, cors);
      }

      if (R('/team/journey', 'PATCH')) {
        /* The switchboard itself is the list of switches. This used to carry its
           own copy of the ten names, which is two lists that have to agree - and
           the one that quietly stops agreeing is the one nobody reads. A key
           that is not in the table updates no rows and is refused here. */
        const key = St(b.key || '').trim();
        const on = b.on === true;
        const r = await sb(env, `/journey_switch?key=eq.${E(key)}`, {
          method: 'PATCH',
          body: S({ on, updated_at: nowIso(), updated_by: who })
        });
        if (!r.ok) return bad('Could not save that' + TRY, 500);
        if (!(r.body || []).length) return bad('That is not a switch.', 404);
        return J({ ok: true, key, on, updated_by: who }, 200, cors);
      }

      /* manual add by team (drivers or freight) */
      if (R('/team/applications', 'POST')) {
        if (!b.type || !b.username) return bad('Missing required fields.', 400);
        const dupe = await findApp(env, b.username);
        if (dupe) return bad(`${b.username} already exists (ref ${dupe.ref}, status ${dupe.status}).`, 409);
        const row = pickFields(b);
        row.ref = newRef(); row.added_by = who; row.docs = b.docs || [];
        row.status = b.status === 'approved' ? 'approved' : 'pending';
        if (row.status === 'approved') row.approved_at = nowIso();
        const r = await sb(env, `/${APPS}`, { method: 'POST', body: S(row) });
        return r.ok ? J(view(r.body[0]), 200, cors) : bad('Could not add' + TRY, 500);
      }

      /* status / docs updates from the queue */
      const m = p.match(/^\/team\/applications\/([A-Za-z0-9-]+)$/);
      if (m && M === 'PATCH') {
        /* Read the record as it stands BEFORE the press. Blocking and
           unblocking are the same button in two states, and which one just
           happened is a fact about the record, not about the request - a
           reviewer's browser holding a stale row must not be able to decide
           that somebody was unblocked. */
        const before = await findApp(env, m[1]);
        const patch = { updated_at: nowIso() };
        if (b.status) {
          patch.status = b.status;
          if (b.status === 'approved') { patch.approved_at = nowIso(); patch.approved_by = who; }
          if (b.status === 'rejected') {
            patch.rejected_at = nowIso();
            patch.reject_reason = b.rejectReason || null;
            /* Brent's standing rule: a declined applicant is not re-onboarded
               without his written yes. The way back in is therefore something a
               reviewer has to choose, one decline at a time - 'fix' (correct
               this one and resend) or 'new' (start a fresh application).
               Anything else, and anything not chosen at all, closes it with no
               way back, which is the version of the email the set calls closed
               and the version this sends unless somebody deliberately says
               otherwise. */
            patch.route_back = ['fix', 'new'].includes(b.routeBack) ? b.routeBack : 'none';
          }
          /* ── Block ──
             Brent, 14 Aug: "they get an email with the notes we add to the
             block and reason - they get the notes and the opportunity to go
             into the clever.usehaf.co.uk - sign in and fix any problems".

             So the reason is not optional here, and it is not optional
             anywhere else either: a pause with nothing written on it is a
             locked door with no sign on it, and the person on the other side
             of it has no idea what to fix. The press is refused without one
             rather than sent with an empty reason, because an email whose
             only content is "we have paused your account" is worse than no
             email at all.

             blocked_at is what the mail engine reads to hold every OTHER
             email back (canMail), so the two must not fight: it is stamped
             here and cleared the moment somebody is unblocked, or a restored
             account would go silent for good. */
          if (b.status === 'blocked') {
            const why = St(b.blockReason || '').trim();
            if (why.length < 4)
              return bad('Say why this account is being blocked — your words are what they are sent.', 400);
            patch.block_reason = why.slice(0, 1000);
            patch.blocked_at = nowIso();
            patch.blocked_by = who;
            patch.unblocked_at = null;
            patch.unblocked_by = null;
          } else if (before && before.status === 'blocked') {
            /* a move OFF blocked is the unblock — and it is read from the
               record as it stands, never from the button, so approving an
               account that was never blocked does not quietly count as one */
            patch.blocked_at = null;
            patch.unblocked_at = nowIso();
            patch.unblocked_by = who;
          }
        }
        if (b.docs !== undefined) patch.docs = b.docs;
        /* ── Confirm & release access ──
           Brent, 3 Aug: "only send when cleverpay team - gemma confirms them
           / once gemma approves - allow them into the network and PLNA
           system". Approving moves a record through the queue; THIS is the
           separate, deliberate press that says a named compliance reviewer
           has looked at the person and is happy for them to be let in. It
           stamps who and when, switches the HAF KNECT network on, and is the
           only thing the email engine will accept as permission to send
           somebody their login details. */
        /* ── the paperwork has to exist before the press can open anything ──
           Brent, 14 Aug: a freight account with an empty document list was
           released and PLNA let it straight in. Nothing here ever looked at
           the documents — Confirm & release stamped the record, the mail job
           copied the username into PLNA's cleared list, and the door opened
           for somebody who had uploaded nothing.

           So the press now reads the same requirement set the applicant is
           shown, and refuses while anything marked required is missing. It
           names the missing documents rather than saying no, because the
           reviewer's next move is to go and get them — and documents that
           arrived by email are added on this same record, which clears the
           block honestly. Approve and reject are untouched; only the press
           that OPENS a door is gated on the paperwork behind it. */
        if (b.confirm_access) {
          patch.status = 'approved';
          patch.approved_at = patch.approved_at || nowIso();
          patch.approved_by = patch.approved_by || who;
          patch.access_confirmed_at = nowIso();
          patch.access_confirmed_by = who;
          patch.knect = true;
        }
        const r = await patchApp(env, m[1], patch);
        if (!(r.ok && r.body[0])) return bad('Update failed.', 500);
        const out = J(view(r.body[0]), 200, cors);
        /* Confirm & release is the only press that may tell somebody they are in.
           Approve on its own still says nothing to anybody, exactly as it has
           since 3 August - it names no moment here, so no email exists to send. */
        const ev = b.confirm_access ? 'compliance_approved'
          : b.status === 'rejected' ? 'compliance_rejected'
          : b.status === 'blocked' ? 'account_paused'
          : (before && before.status === 'blocked') ? 'account_restored' : null;
        return ev ? named(out, ev, r.body[0].ref) : out;
      }

      /* ── reviewer opens the actual file — bytes proxied through this session, never a public link ── */
      if (R('/team/doc', 'GET')) {
        const app = await findApp(env, url.searchParams.get('ref') || '');
        const id = (url.searchParams.get('id') || '').replace(/[^a-z0-9_-]/gi, '');
        const d = app && (Array.isArray(app.docs) ? app.docs : []).find(x => x.id === id);
        if (!d) return bad('No such document on this application.', 404);
        if (!d.path) return bad('no_file', 404);
        const f = await store(env, d.path, { method: 'GET' });
        if (!f.ok) return bad('That file could not be opened.', 502);
        return new Response(f.body, { status: 200, headers: { ...cors,
          [CT]: d.mime || f.headers.get('Content-Type') || 'application/octet-stream',
          'Content-Disposition': `inline; filename="${St(d.filename || id).replace(/["\r\n]/g, '')}"` } });
      }

      /* ── team takes a file back off the record ──
         A file attached to the wrong person is worse than a missing one, so
         whoever added it must be able to undo it in the same place. */
      if (R('/team/doc-remove', 'POST')) {
        const app = await findApp(env, b.ref || '');
        if (!app) return bad(NOTFOUND, 404);
        const id = St(b.id || '').replace(/[^a-z0-9_-]/gi, '');
        const held = (Array.isArray(app.docs) ? app.docs : []);
        if (!held.some(d => d.id === id)) return bad('No such document on this application.', 404);
        const docs = held.filter(d => d.id !== id);
        const r = await patchApp(env, app.ref, { docs, updated_at: nowIso() });
        if (!r.ok || !r.body[0]) return bad('Could not remove that document.', 500);
        return J({ ok: true, app: view(r.body[0]) }, 200, cors);
      }

      /* ── reviewer ticks a document off — recorded on the application with who and when ── */
      if (R('/team/doc-check', 'POST')) {
        const app = await findApp(env, b.ref || '');
        if (!app) return bad(NOTFOUND, 404);
        const now = nowIso();
        const docs = (Array.isArray(app.docs) ? app.docs : []).map(d => d.id !== b.id ? d
          : { ...d, checked: !!b.checked, checked_by: b.checked ? who : null, checked_at: b.checked ? now : null });
        const r = await patchApp(env, app.ref, { docs, updated_at: now });
        return r.ok ? J({ ok: true, docs }, 200, cors) : bad('Could not save that tick.', 500);
      }

      /* ── reviewer confirms they have actually run the driving record on GOV.UK ──
         Recorded with who and when, the same as a document tick, so "checked"
         always has a name against it. Re-checking is expected: if the driver
         supplies a newer code the confirmation is cleared automatically. */
      if (R('/team/dvla-check', 'POST')) {
        const app = await findApp(env, b.ref || '');
        if (!app) return bad(NOTFOUND, 404);
        if (!app.dvla_check_code) return bad('There is no check code on this application yet — chase it first.', 400);
        const now = nowIso();
        const patch = b.checked === false
          ? { dvla_checked_at: null, dvla_checked_by: null, updated_at: now }
          : { dvla_checked_at: now, dvla_checked_by: who, updated_at: now };
        const r = await patchApp(env, app.ref, patch);
        return r.ok && r.body[0] ? J({ ok: true, app: view(r.body[0]) }, 200, cors) : bad('Could not save that check.', 500);
      }

      /* ── team corrects what is held on the record ──
         Brent, 4 Aug: "allow us to edit information if we need to", and
         "NI number, licence number & DVLA mainly". A surname typed wrong at
         sign-up, a dead email, a transposed digit in a licence number — none of
         that should mean starting the person's application again. Only what a
         human can legitimately correct is writable here: the status, the
         approval and release stamps, the payment record and anybody's PIN are
         all deliberately out of reach, because those are decisions, not
         details. The username is out of reach too — it is how they sign in to
         CleverPay, KNECT and PLNA, so changing it would lock them out of all
         three.

         Two consequences are handled rather than hidden. A new email address
         has not been confirmed by the person who owns it, so the confirmation
         is cleared and they must confirm again — otherwise a typo becomes a
         way past the access door. And a new check code is a new record, so
         the driving-record tick clears itself (readDvla already does this).
         Every save writes its own line of history into the record notes: no
         column exists for an audit trail, and a compliance file that cannot
         say who changed it is worth less than one nobody touched. */
      if (R('/team/edit', 'POST')) {
        const app = await findApp(env, b.ref || '');
        if (!app) return bad(NOTFOUND, 404);
        const f = b.fields && typeof b.fields === 'object' ? b.fields : {};
        const patch = {}, changed = [];
        for (const k of Object.keys(EDIT_FIELDS)) {
          if (f[k] === undefined) continue;
          let v = St(f[k]).trim();
          if (k === 'vreg') v = v.toUpperCase();
          const next = v === '' ? null : v;
          if ((app[k] == null ? null : app[k]) === next) continue;
          patch[k] = next; changed.push(EDIT_FIELDS[k]);
        }
        if (patch.email !== undefined) {
          if (patch.email === null) return bad('An account needs an email address — it is how they are told anything.', 400);
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.email)) return bad('That email address doesn’t look right.', 400);
          /* the new owner of this address has confirmed nothing yet */
          patch.email_verified = false; patch.email_verified_at = null;
          patch.email_confirm_token = null; patch.email_confirm_sent_at = null;
        }
        if (b.dvla) {
          const v = readDvla(b.dvla, app);
          if (v.error) return bad(v.error, 400);
          for (const [k, val] of Object.entries(v.patch)) {
            if ((app[k] == null ? null : app[k]) === val) continue;
            patch[k] = val;
            if (DVLA_LABELS[k]) changed.push(DVLA_LABELS[k]);
          }
        }
        /* notes carry the history block, so they are compared on their free text alone */
        if (f.notes !== undefined && St(f.notes).trim() !== freeNotes(app.notes).trim()) changed.push('the notes');
        if (!changed.length) return J({ ok: true, app: view(app), changed: [] }, 200, cors);
        patch.notes = recordHistory(f.notes, app.notes, who, 'changed ' + changed.join(', '));
        patch.updated_at = nowIso();
        const r = await patchApp(env, app.ref, patch);
        if (!r.ok || !r.body[0]) return bad('Could not save those changes' + TRY, 500);
        return J({ ok: true, app: view(r.body[0]), changed }, 200, cors);
      }

      /* ── take it off the list, or put it back ──
         Reversible, and deliberately so: the row, the documents, the status and
         every stamp are untouched. Anyone signed in can do this, because the
         worst case is a record nobody can see for a minute. */
      if (R('/team/archive', 'POST')) {
        const app = await findApp(env, b.ref || '');
        if (!app) return bad(NOTFOUND, 404);
        const want = b.archived !== false;
        /* Silent unless the office says otherwise. Archiving is filing, not a
           decision, and "your application has been archived" lands on someone
           who has done nothing wrong as though it were one. The tick is there
           for the case where they genuinely should be told — and it is handled
           before the state check, because telling an already-archived applicant
           is exactly when the office reaches for it. */
        const told = !!(want && b.notify === true && canMail(app));
        /* Already in the state being asked for means there is nothing to write,
           but the reply and the email are the same either way — so it is one
           exit, not two nearly-identical ones that have to be kept in step. */
        const changed = isArchived(app.notes) !== want;
        let row = app;
        if (changed) {
          const r = await patchApp(env, app.ref, {
            notes: recordHistory(undefined, app.notes, who, want ? ARCHIVED : RESTORED),
            updated_at: nowIso(),
          });
          if (!r.ok || !r.body[0]) return bad('Could not save that' + TRY, 500);
          row = r.body[0];
        }
        const out = J({ ok: true, app: view(row), changed, emailed: told,
          email: told ? app.email : null }, 200, cors);
        return told ? named(out, EV_CANX, app.ref) : out;
      }

      /* ── clear it and send it back to the applicant ──
         The chase email that already goes out every half hour is the one that
         fits: it tells them the application is paused rather than closed, lists
         what is outstanding — after a clear, everything — and gives them the
         button back into the portal. Queuing it here rather than sending from
         here means one email engine, one record of what was sent. */
      if (R('/team/clear', 'POST')) {
        const app = await findApp(env, b.ref || '');
        if (!app) return bad(NOTFOUND, 404);
        if (app.type === 'business') return bad('Business enquiries have no documents to clear.', 400);
        if (!app.email) return bad('There is no email address on this application to send it back to.', 400);
        const cfg = await readCfg(env);
        if (!cfg) return bad(NOCFG, 503);
        await dropFiles(env, app);
        const now = nowIso();
        const missing = missingRequired(cfg, { ...app, docs: [], dvla_licence_no: null, dvla_check_code: null, ni_number: null });
        /* an applicant who has asked not to be emailed, or who is blocked, is
           still cleared — but the portal must say plainly that nothing was sent */
        const mailable = canMail(app);
        const patch = {
          docs: [], status: 'pending', updated_at: now,
          approved_at: null, approved_by: null, rejected_at: null, reject_reason: null,
          access_confirmed_at: null, access_confirmed_by: null, knect: false,
          dvla_licence_no: null, dvla_check_code: null, ni_number: null,
          dvla_code_at: null, dvla_checked_at: null, dvla_checked_by: null,
          notes: recordHistory(undefined, app.notes, who, CLEARED),
        };
        if (mailable) {
          patch.reminder_requested_at = now; patch.reminder_sent_at = null; patch.reminder_by = who;
          patch.reminder_docs = missing; patch.reminder_count = (app.reminder_count || 0) + 1;
        }
        const r = await patchApp(env, app.ref, patch);
        if (!r.ok || !r.body[0]) return bad('Could not clear that application' + TRY, 500);
        /* Clearing takes an applicant's documents away. They are owed the
           reason on the same press, not on a sweep: this is the one moment
           where silence looks exactly like the office losing their paperwork. */
        const cleared = J({ ok: true, app: view(r.body[0]), emailed: mailable, email: app.email,
          missing: missing.map(x => x.name) }, 200, cors);
        return mailable
          ? named(cleared, EV_ACT, app.ref, missing.map(x => x.name).join(', '))
          : cleared;
      }

      /* ── delete, and it is gone ──
         Brent and the compliance lead only, and only when the reference has been
         typed out: everyone else is told to archive instead. A deleted person may
         still exist in KNECT and PLNA — this removes the CleverPay record, not
         their account elsewhere. */
      if (R('/team/delete', 'POST')) {
        if (!canIntegrate(who))
          return bad('Only Brent or the compliance lead can delete an application. Archive it instead — that hides it from the list and keeps the record.', 403);
        const app = await findApp(env, b.ref || '');
        if (!app) return bad(NOTFOUND, 404);
        if (St(b.confirm || '').toUpperCase().trim() !== St(app.ref).toUpperCase())
          return bad('Type the reference exactly to confirm you meant to delete it.', 400);
        /* taken first, on purpose: a moment after the DELETE below there is no
           name, no address and no reference left to write to. Someone who has
           asked not to be emailed, or who is blocked, is not told — an
           application ending is not a reason to override either, and that is a
           deliberate silence rather than a failure. */
        const mailable = canMail(app);
        const snap = mailable ? snapshot(app) : null;
        await dropFiles(env, app);
        const r = await sb(env, `/${APPS}?ref=eq.${E(app.ref)}`, { method: 'DELETE' });
        if (!r.ok) return bad('Could not delete that application' + TRY, 500);
        const name = [app.fname, app.lname].filter(Boolean).join(' ') || app.company || app.username || '';
        await tellTeam(env, `CleverPay: application ${app.ref} (${name}) was deleted by ${who} on ${nowIso().slice(0, 16).replace('T', ' ')}. Documents removed with it. ${snap ? 'The applicant has been emailed to say it is closed.' : 'The applicant has NOT been emailed.'} This cannot be undone.`);
        const gone = J({ ok: true, ref: app.ref, name, emailed: !!snap,
          email: snap ? app.email : null }, 200, cors);
        return snap ? named(gone, EV_CANX, app.ref, '', snap) : gone;
      }

      /* ── Confirm email ──
         This press used to go straight from the portal page to the database and
         never touch a worker at all. It saved fine, but a press that does not
         come through here cannot name a moment, so it was the one button in the
         portal that could never send anything — and it is pressed at exactly the
         moment somebody stops being stuck and starts being able to move.

         What it says depends on where they actually are, which is Brent's rule
         for the whole set: if the office is still waiting on paperwork, they get
         the list of what is outstanding, because confirming the address is what
         makes that email reachable in the first place. If nothing is outstanding
         they hear nothing here — "we have your documents" has already gone, and
         a second email saying the same thing is noise. Business enquiries have
         no document conversation at all, so they are silent too. */
      if (R('/team/confirm-email', 'POST')) {
        const app = await findApp(env, b.ref || '');
        if (!app) return bad(NOTFOUND, 404);
        const now = nowIso();
        const r = await patchApp(env, app.ref, {
          email_verified: true, email_verified_at: app.email_verified_at || now, updated_at: now,
        });
        if (!r.ok || !r.body[0]) return bad('Could not confirm that email' + TRY, 500);
        const fresh = r.body[0];
        /* Same three silences the rest of this office keeps: no address to write
           to, asked not to be emailed, or blocked. Each is reported back rather
           than hidden, so the portal can say plainly that nothing was sent. */
        let missing = [];
        if (canMail(fresh) && fresh.type !== 'business') {
          const cfg = await readCfg(env);
          if (cfg) missing = missingRequired(cfg, fresh);
        }
        const names = missing.map(x => x.name);
        const out = J({ ok: true, app: view(fresh), emailed: names.length > 0,
          email: names.length ? fresh.email : null, missing: names }, 200, cors);
        return names.length
          ? named(out, EV_ACT, fresh.ref, names.join(', '))
          : out;
      }

      /* ── chase the documents we are still waiting on ──
         Nothing can be processed until the paperwork is in, so the queue needs a
         one-click nudge. The click is recorded here with who sent it and exactly
         which documents were outstanding at that moment; the email itself goes out
         from the HAF mailbox on the next reminder run. One per applicant per day —
         a chase that lands twice in an afternoon reads as harassment. */
      if (R('/team/remind', 'POST')) {
        const app = await findApp(env, b.ref || '');
        if (!app) return bad(NOTFOUND, 404);
        if (app.type === 'business') return bad('Business enquiries do not have compliance documents.', 400);
        if (!app.email) return bad('There is no email address on this application.', 400);
        const cfg = await readCfg(env);
        if (!cfg) return bad(NOCFG, 503);
        const out = missingRequired(cfg, app);
        if (!out.length) return bad('Every required document is already in — there is nothing to chase.', 400);
        /* Brent, 3 Sep: ask for CERTAIN documents, not always all of them. The
           reviewer ticks what they actually want and only those are named in the
           email and written to the record. Nothing ticked means everything
           outstanding, which is what the button did before and what most chases
           still want. Ids that are not genuinely outstanding are ignored rather
           than trusted, so this can never invent a document to ask for. */
        const only = Array.isArray(b.ids) ? b.ids : [];
        const pick = only.length ? out.filter(d => only.includes(d.id)) : [];
        const missing = pick.length ? pick : out;
        const last = app.reminder_requested_at || app.reminder_sent_at;
        if (last && Date.now() - Date.parse(last) < 20 * 3600e3)
          return bad('This applicant has already been reminded today — you can send another tomorrow.', 429);
        const now = nowIso();
        const r = await sb(env, `/${APPS}?ref=eq.${E(app.ref)}`, {
          method: 'PATCH',
          body: S({
            reminder_requested_at: now, reminder_by: who, reminder_docs: missing,
            reminder_count: (app.reminder_count || 0) + 1, updated_at: now,
          }),
        });
        if (!r.ok || !r.body || !r.body[0]) return bad('Could not send that reminder' + TRY, 500);
        /* This used to write "please chase them" onto the record and wait for a
           job to notice. It goes now, naming the documents the reviewer is
           actually waiting on, so the applicant reads the same list the office
           is looking at. */
        return named(
          J({ ok: true, email: app.email, missing: missing.map(x => x.name), app: view(r.body[0]) }, 200, cors),
          EV_ACT, app.ref, missing.map(x => x.name).join(', '));
      }

      /* ── the integration panel — Brent and Gemma only ──
         Anyone else gets exactly the same 404 as a route that does not exist. */
      if (p.startsWith('/team/integration')) {
        if (!canIntegrate(who)) return bad(NOTFOUND, 404);
        const kr = await sb(env, '/cleverpay_api_keys?revoked_at=is.null&order=created_at.desc&limit=1');
        const active = kr.ok && kr.body && kr.body[0] ? kr.body[0] : null;
        const summary = (k) => k && {
          prefix: k.key_prefix, label: k.label, created_at: k.created_at, created_by: k.created_by,
          last_used_at: k.last_used_at, use_count: k.use_count || 0,
        };

        if (R('/team/integration', 'GET')) {
          /* a real check, not a guess: if we cannot read the table the back office
             reads, the panel must say so rather than show a comforting green line */
          const probe = await sb(env, `/${APPS}?select=ref&limit=1`);
          return J({
            endpoint: (req.headers.get('x-cp-origin') || url.origin) + '/partner/compliance',
            key: summary(active),
            live: probe.ok,
            checked_at: nowIso(),
            shares: ['reference', 'name', 'account type', 'compliance status', 'dates'],
          }, 200, cors);
        }

        /* generate or rotate — the plaintext key is returned this once and never again */
        if (R('/team/integration/key', 'POST')) {
          const key = newApiKey();
          const row = {
            label: St(b.label || 'Back office').slice(0, 60),
            key_hash: await keyHash(key), key_prefix: key.slice(0, 12), created_by: who,
          };
          const ins = await sb(env, '/cleverpay_api_keys', { method: 'POST', body: S(row) });
          if (!ins.ok) return bad('Could not create the key' + TRY, 500);
          /* rotate: the old key stops working the moment the new one exists */
          if (active) await sb(env, `/cleverpay_api_keys?id=eq.${active.id}`, {
            method: 'PATCH', body: S({ revoked_at: nowIso(), revoked_by: who }) });
          return J({ key, rotated: !!active, summary: summary(ins.body[0]) }, 200, cors);
        }

        if (R('/team/integration/revoke', 'POST')) {
          if (!active) return bad('There is no active key to switch off.', 400);
          const r = await sb(env, `/cleverpay_api_keys?id=eq.${active.id}`, {
            method: 'PATCH', body: S({ revoked_at: nowIso(), revoked_by: who }) });
          return r.ok ? J({ ok: true }, 200, cors) : bad('Could not switch the key off.', 500);
        }

        return bad(NOTFOUND, 404);
      }

      if (R('/team/config', 'PUT')) {
        const r = await sb(env, '/cleverpay_portal_config?id=eq.1', { method: 'PATCH', body: S({ config: b }) });
        return r.ok ? J({ ok: true }, 200, cors) : bad('Could not save settings.', 500);
      }

      return bad(NOTFOUND, 404);
    } catch (e) {
      return bad('Server error.', 500);
    }
  },
};
