/* CleverPay API — Cloudflare Worker
   Storage: HUB Supabase (cleverpay_* tables), service key via SB_KEY secret.
   Serves: applicant sign-up/login/docs/status + team portal (auth, queue, manual add, config). */

const SB = 'https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1';
const APPS = 'cleverpay_applications';
/* join.usehaf.co.uk is the front door: it makes the HAF login before it records
   the membership, so it calls this worker from the customer's own browser. It
   was missing here, which meant the door worked on its preview address (that
   ends .pages.dev and slips through the rule below) and would have been refused
   on its real one. Named explicitly now. */
const JOIN_ORIGIN = 'https://join.usehaf.co.uk';
const OK_ORIGINS = [JOIN_ORIGIN, 'https://clever.usehaf.co.uk', 'https://otisagent.github.io', 'https://plna.usehaf.co.uk'];
/* Everywhere the join page can legitimately be speaking from. Cloudflare puts a
   hash in front of a branch preview — abc123.haf-pay.pages.dev — so a preview has
   to be matched on the SUFFIX. Matching the bare project name alone meant no
   preview sign-up was ever stamped, which is exactly why nobody saw what the
   stamp does to a real one until it reached the live domain. */
const isJoinOrigin = (o) =>
  o === JOIN_ORIGIN || o === 'https://haf-pay.pages.dev'
  || (o.startsWith('https://') && o.endsWith('.haf-pay.pages.dev'));
/* compliance files live in a PRIVATE bucket — reachable only with the service key, never by URL */
const DOCS = 'https://jsdwvogsxlnczzbefwgp.supabase.co/storage/v1/object/cleverpay-docs/';
const DOC_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];
const store = (env, path, init) => fetch(DOCS + path, { ...init,
  headers: { apikey: env.SB_KEY, Authorization: 'Bearer ' + env.SB_KEY, ...(init.headers || {}) } });

/* Our own preview hostnames, named. NOT a wildcard — see below. */
const OK_PREVIEWS = [
  'https://cleverpay-live.pages.dev',
  'https://haf-storefront.pages.dev',
  'https://haf-pay.pages.dev',
  'https://plna-live.pages.dev',
  'https://cleverpay-admin-preview.pages.dev',
];

/* 13 Aug — the wildcards are gone, and Warren proved why with a hostname he
   invented: `warren-not-haf-at-all.pages.dev` was allowed and reflected straight
   back. pages.dev, workers.dev and vercel.app are free public hosting — anyone
   can hold a subdomain on any of them within minutes, so "any *.pages.dev" never
   meant "our previews", it meant "anybody's".

   It matters more under V2 than it did before: V2 moved the account call into the
   browser and sends the PIN hash to this service directly. A counterfeit join
   page on free hosting could therefore call the real account service, create real
   HAF accounts and read the answers, with this API endorsing the origin.

   Stated plainly so nobody over-reads it: CORS is a browser control, not the
   API's authentication. A server-side caller ignores it entirely. What this
   closes is the browser-shaped half — which is exactly the half V2 started
   using. */
/* Cloudflare gives a branch preview a hostname like <hash>.<project>.pages.dev, so an
   exact match on the bare project name would refuse every preview we actually use —
   which is how a security fix quietly becomes an outage for the people testing it.
   Caught before shipping by reading how the V2 flag matches its own previews, four
   lines further down, rather than trusting the list I had just written.

   This is project-scoped, NOT a wildcard: the hostname must END with one of our own
   project names. `warren-not-haf-at-all.pages.dev` still fails, because it does not
   end with `.cleverpay-live.pages.dev` or any of the others. */
const PREVIEW_SUFFIXES = OK_PREVIEWS.map((u) => '.' + u.replace('https://', ''));
function isOurPreview(o) {
  if (OK_PREVIEWS.includes(o)) return true;
  return PREVIEW_SUFFIXES.some((s) => o.startsWith('https://') && o.endsWith(s));
}

function corsHeaders(req) {
  const o = req.headers.get('Origin') || '';
  const ok = OK_ORIGINS.includes(o) || isOurPreview(o);
  return {
    'Access-Control-Allow-Origin': ok ? o : OK_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Cache-Control': 'no-store',
  };
}
const J = (data, status, cors) =>
  new Response(S(data), { status, headers: { [CT]: AJ, ...cors } });

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
  dvla_licence_no: 'driving licence number', dvla_check_code: 'DVLA check code', ni_number: 'National Insurance number',
};

/* No column exists for an audit trail and the applications table is not mine to
   alter, so the history lives at the foot of the record notes behind a marker:
   free notes above it are the team's, everything below is written by the portal.
   Twenty entries is the ceiling — enough to see a pattern, not enough to bury
   what somebody actually wrote. */
const HIST_MARK = '— — record changes — —';
const freeNotes = n => { const s = St(n || ''); const i = s.indexOf(HIST_MARK); return i === -1 ? s : s.slice(0, i); };
function recordHistory(freeIn, oldNotes, who, changed) {
  const s = St(oldNotes || '');
  const i = s.indexOf(HIST_MARK);
  const prior = i === -1 ? [] : s.slice(i + HIST_MARK.length).split('\n').map(l => l.trim()).filter(Boolean);
  const free = St(freeIn === undefined || freeIn === null ? freeNotes(s) : freeIn).replace(/\s+$/, '');
  const when = nowIso().slice(0, 16).replace('T', ' ');
  const kept = prior.concat(`${when} · ${who} changed ${changed.join(', ')}`).slice(-20);
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
    if (!app.ni_number) out.push({ id: 'ni-number', name: 'National Insurance number',
      hint: 'You need it to create the check code, and we need it to set your payments up.' });
  }
  return out;
}

/* every write to an application goes through here */
const patchApp = (env, ref, patch) =>
  sb(env, `/${APPS}?ref=eq.${E(ref)}`, { method: 'PATCH', body: S(patch) });

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

/* ── new-enquiry alert → handed to Henry, who sends it ──
   Until 12 Aug this worker sent the alert to the "HAF Sign ups - Enquiries"
   group itself, and the message carried the customer's name, phone and email.
   That never actually ran: the bot token was never set, so not one alert has
   ever been delivered. Which is the only reason this is a design decision
   rather than an incident.

   The July design and its mention ladder are gone with it. Read the git history
   if you need them; leaving them here as dead code would keep a working route
   to Telegram one edit away from being reachable again, and that route is
   exactly what this worker must no longer have. */
const TYPE_LABELS = {
  driver: 'Owner Driver',
  fleet: 'Fleet / Courier Company',
  freight: 'Freight Forwarder',
  business: 'Business Account',
};
const esc = (s) => St(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ukStamp(d = new Date()) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'short' }).format(d);
  return `${time}, ${day}`;
}



/* 12 Aug — REWRITTEN, and the reason matters more than the code.
   This worker no longer talks to Telegram at all. It hands the enquiry to
   Henry, who sends it with his own credential, and it hands over THREE FIELDS:
   the reference, the account type and the time. No name. No phone. No email.

   Why the fields went, when the old version had been signed off in July: that
   group contains someone whose status inside HAF nobody has confirmed, and a
   message in a group chat cannot be taken back or its readers known. Trimming
   at the source rather than in the message means no later edit — by me or
   anyone — can start leaking details by writing a different sentence. Henry's
   end drops anything beyond these three as well, so both ends refuse.

   Why the relay rather than a token: a bot token here would be a second copy of
   a credential in a place its owner cannot see, to do a job his side can
   already do. This way the worker holds no Telegram credential at all.

   Fire-and-forget as before: an alert failure must never break a sign-up. */
async function sendEnquiryAlert(env, row) {
  if (!env.ALERT_URL || !env.ALERT_SECRET) return;
  const r = await fetch(env.ALERT_URL, {
    method: 'POST',
    headers: { [CT]: AJ, 'X-HAF-Alert-Secret': env.ALERT_SECRET },
    body: S({
      reference: row.ref,
      account_type: TYPE_LABELS[row.type] || 'New account',
      at: ukStamp(),
    }),
  });
  if (!r.ok) console.log('enquiry alert rejected', r.status, await r.text().catch(() => ''));
  return r.ok;
}

function alertNewEnquiry(env, ctx, row) {
  if (!row) return;
  const p = sendEnquiryAlert(env, row).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

/* ── back-office integration — Brent and Gemma only ──
   One key-authenticated endpoint the CleverPay back office reads compliance from.
   Nothing about it is public: it is never linked from the sign-up site, there is no
   docs page, and /team/integration answers a plain 404 to any other team member, so
   a login outside the list cannot even tell the panel exists. Hiding the tab in the
   browser is presentation; THIS is the security.

   What crosses is deliberately narrow (Brent's call, 31 Jul): reference, name,
   compliance status and dates. No documents, no bank or payment details, no
   contact details. PARTNER_VIEW is the whole contract — if a field is not built
   here it cannot leave, whatever the caller asks for. */
const INTEGRATION_USERS = ['bf638793', 'cleverg'];
const canIntegrate = (u) => INTEGRATION_USERS.includes(St(u || '').toLowerCase().trim());

const newApiKey = () =>
  'cpk_' + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('');
const keyHash = (k) => sha256('HAF-CP-KEY|' + k);

function PARTNER_VIEW(a) {
  return {
    reference: a.ref,
    name: a.type === 'driver' ? [a.fname, a.lname].filter(Boolean).join(' ') : (a.company || a.name || null),
    account_type: a.type,
    compliance_status: a.status,
    email_confirmed: !!a.email_verified,
    submitted_at: a.submitted || null,
    approved_at: a.approved_at || null,
    rejected_at: a.rejected_at || null,
    updated_at: a.updated_at || null,
  };
}

/* the key itself is never stored — only its hash, so a database leak cannot be replayed */
async function apiKeyRow(env, req) {
  const raw = req.headers.get('X-API-Key') || (req.headers.get('Authorization') || '').replace(/^Bearer /i, '');
  const key = St(raw || '').trim();
  if (!/^cpk_[a-f0-9]{40}$/.test(key)) return null;
  const r = await sb(env, `/cleverpay_api_keys?key_hash=eq.${await keyHash(key)}&revoked_at=is.null&limit=1`);
  return r.ok && r.body && r.body[0] ? r.body[0] : null;
}

/* "when it last talked to us" on the panel comes from this — never let it break a reply */
function noteKeyUse(env, ctx, row, path) {
  const p = sb(env, `/cleverpay_api_keys?id=eq.${row.id}`, {
    method: 'PATCH',
    body: S({ last_used_at: nowIso(), last_used_path: path, use_count: (row.use_count || 0) + 1 }),
  }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

/* ── the sign-up emails, sent on the press ───────────────────────────────────
   Until today every one of these left on a sweep: a scheduled job woke every
   half hour, asked who had moved since last time, and wrote to them. Brent,
   14 Aug: they must arrive within ten seconds of the thing that caused them. No
   timer worth running does that, so the send happens HERE, on the same request
   as the press, and there is no timer left to fall behind.

   It rides on ctx.waitUntil, so the applicant's page and the reviewer's button
   never wait for Mandrill. The four walls still bite, in the order they always
   did - they are the rules, not the plumbing:

     1. journey='v2'       nobody who signed up before the rebuild is reachable
     2. the switchboard    the master switch AND this moment's switch, both on
     3. the named release  the approved email needs a real person's press
     4. one per moment     claimed in the ledger BEFORE the send

   Wall 4 is the database's job and not this code's: haf_mail_log holds one row
   per (ref, event) and the second insert loses. Two reviewers pressing the same
   button in the same second is exactly what sent twelve applicants a duplicate
   on 4 August, and a check written in JavaScript would lose that race again.
   Whoever claims, sends.

   No MAIL_KEY means this deployment cannot send at all - deliberately, so a
   preview can be walked end to end without a customer ever hearing from it. */
const MANDRILL = 'https://mandrillapp.com/api/1.0/messages/send-template.json';
const KNECT_URL = 'https://knect.usehaf.co.uk';
const PLNA_URL = 'https://plna.usehaf.co.uk';
const CLEVER_URL = 'https://clever.usehaf.co.uk';
const NEEDS_DOCS = ['driver', 'fleet'];
const BOX_TYPES = ['driver', 'fleet', 'freight', 'business'];
const WHY_MISSING = 'We cannot finish your application until this reaches us. '
  + 'Sign in to your HAF application, upload it, and we will pick the check '
  + 'straight back up.';
/* Which box each moment leaves from. One line per moment ON PURPOSE: there is
   no default, because a fallback address is precisely how every HAF email ended
   up coming from the same place. A moment missing here does not send. */
/* Brent's walkthrough, 14 Aug, sets the allocation and it is not mine to
   improve on: knect@ is the network itself - joining it, being let into it,
   what you pay for inside it. updates@ is the application: where it has got to
   and what it needs from you. accounts@ is money. He asked for a customer to
   recognise WHY a mailbox is writing to them, and that only works if the split
   holds for every email, so hello@ is out of this journey entirely.

   Approved sits under knect@ rather than updates@ deliberately: it is the one
   that says welcome to the network, not the one that says where your paperwork
   has got to. Say the word and it moves - it is this line and nothing else. */
const BOXES = {
  account_created: 'knect@usehaf.co.uk',
  email_confirm_required: 'knect@usehaf.co.uk',
  compliance_submission_complete: 'updates@usehaf.co.uk',
  compliance_action_required: 'updates@usehaf.co.uk',
  compliance_approved: 'knect@usehaf.co.uk',
  compliance_rejected: 'updates@usehaf.co.uk',
  compliance_application_cancelled: 'updates@usehaf.co.uk',
  membership_upgraded: 'accounts@usehaf.co.uk',
  plna_allocated: 'knect@usehaf.co.uk',
};
/* The six a freight forwarder or business account must never receive: they hand
   over no documents, so there is no document conversation to have with them. */
const COMPLIANCE_ONLY = ['compliance_submission_complete', 'compliance_action_required',
  'compliance_approved', 'compliance_rejected', 'compliance_application_cancelled',
  'plna_allocated'];

/* One moment, one template - the role is a version OF the moment, never a
   moment of its own. Henry switches the moment; this picks the wording. */
function slugFor(row, ev) {
  const t = row.type;
  if (ev === 'account_created')
    return 'haf-j1-account-created-' + (BOX_TYPES.includes(t) ? t : 'business');
  if (ev === 'email_confirm_required') return 'haf-j2-confirm-email';
  if (ev === 'compliance_submission_complete') return 'haf-j3-documents-received';
  if (ev === 'compliance_action_required') return 'haf-j4-action-required';
  /* Brent, 14 Aug: the release press tells them the account is open and that
     access is granted across BOTH systems. Freight and business get their own
     version - they are released to HAF KNECT and to nothing else, and the
     driver wording would promise them a PLNA they were never checked for. */
  if (ev === 'compliance_approved')
    return 'haf-j5-approved-' + (t === 'fleet' ? 'fleet' : t === 'driver' ? 'driver' : 'freight');
  /* Brent's standing rule: a declined applicant is never re-onboarded without
     his written yes. So a rejection offers no way back unless a reviewer has
     deliberately opened one - and a missing column reads as no way back, which
     is the safe way for a column to be absent. */
  /* The column is route_back — the name the migration, the copy set and the
     backstop engine all use. This read `reject_route`, a name nothing writes,
     so every decline would have quietly come out as the closed version no
     matter what a reviewer chose. It failed safe, which is exactly why it
     would have gone unnoticed. */
  if (ev === 'compliance_rejected')
    return 'haf-j6-not-approved-' + (row.route_back === 'fix' ? 'fix'
      : row.route_back === 'new' ? 'new' : 'closed');
  if (ev === 'compliance_application_cancelled')
    return 'haf-j7-application-cancelled' + (row.may_reapply === true ? '-reapply' : '');
  if (ev === 'membership_upgraded') return 'haf-j8-upgrade-active';
  if (ev === 'plna_allocated') return 'haf-j9-plna-allocated';
  return null;
}

/* Where the one button in the email takes them. A driver's road runs through
   the document site; a freight forwarder's runs straight into KNECT, because
   they have nothing to upload and no queue to sit in. */
function actionUrl(row, ev) {
  /* The approval email names both doors in its panel and carries one button,
     as every HAF email does. The button goes to the door that just opened for
     THEM: a driver's own app, a fleet's dashboard, KNECT for everyone else.
     The label in each template is written to match, so the two cannot drift. */
  if (ev === 'compliance_approved')
    return row.type === 'driver' ? PLNA_URL
         : row.type === 'fleet'  ? KNECT_URL + '/fleet'
         : KNECT_URL;
  if (ev === 'membership_upgraded' || ev === 'plna_allocated')
    return KNECT_URL;
  if (ev === 'account_created' && !NEEDS_DOCS.includes(row.type)) return KNECT_URL;
  return CLEVER_URL;
}

function mergeFor(row, ev, extra) {
  const m = {
    fname: St(row.fname || St(row.name || '').split(' ')[0] || 'there'),
    role_label: TYPE_LABELS[row.type] || 'HAF account',
    plan_name: St(row.plan || row.tier || 'HAF'),
    company: St(row.company || ''),
    username: St(row.username || row.ref || ''),
    action_url: actionUrl(row, ev),
    reason: St(row.reject_reason || ''),
    item_name: '',
    item_reason: '',
    ...(extra || {}),
  };
  return Object.keys(m).map((name) => ({ name, content: m[name] }));
}

/* `snap` is a copy of the application taken a moment BEFORE it stopped
   existing. Only the delete button uses it: by the time this code runs the row
   is gone, and "your application is closed" is precisely the email that must
   still arrive. Every wall below is read from the snapshot exactly as it would
   have been read from the record, so a deleted applicant is not a way past any
   of them. Nothing else passes one — the ordinary path re-reads the record so
   it sends on what is true now, not on what a button believed. */
async function journeyMail(env, ref, ev, extra, snap) {
  if (!env.MAIL_KEY) return 'not-armed';
  const row = snap || await findApp(env, ref);
  if (!row) return 'no-record';
  if (row.journey !== 'v2') return 'not-v2';          /* wall 1 */
  if (!row.email) return 'no-address';
  const box = BOXES[ev];
  const slug = slugFor(row, ev);
  if (!box || !slug) return 'no-such-moment';
  /* compliance_approved is deliberately NOT in this wall. Every other
     compliance moment belongs to the two roles that send documents, but the
     release press is pressed on freight and business accounts too, and when
     it is, that person has just been let in and must be told. */
  if (COMPLIANCE_ONLY.includes(ev) && ev !== 'compliance_approved'
      && !NEEDS_DOCS.includes(row.type)) return 'not-their-journey';
  /* wall 3 - approving moves a record through a queue; only a named Confirm &
     release opens a door, and only it may send this one. */
  if (ev === 'compliance_approved' && !(row.access_confirmed_at && row.access_confirmed_by))
    return 'awaiting-release';
  /* wall 2 - the switchboard, which is Henry's page and not a code change. */
  const sw = await sb(env, `/journey_switch?select=key,on&key=in.(live,${E(ev)})`);
  const on = (k) => (sw.body || []).some((s) => s.key === k && s.on === true);
  if (!on('live')) return 'master-switch-off';
  if (!on(ev)) return 'moment-switch-off';
  /* wall 4 - claim it, then send it. */
  const claim = await sb(env, '/haf_mail_log', { method: 'POST', body: S({
    ref: row.ref, event: ev, email: row.email, template: slug,
    status: 'sending', sender: box }) });
  if (!claim.ok) return 'already-sent';
  let status = 'sent';
  let provider = null;
  let error = null;
  try {
    const r = await fetch(MANDRILL, { method: 'POST', headers: { [CT]: AJ }, body: S({
      key: env.MAIL_KEY, template_name: slug, template_content: [],
      message: {
        to: [{ email: row.email, name: St(row.name || row.company || ''), type: 'to' }],
        from_email: box, from_name: 'HAF TEAM', headers: { 'Reply-To': box },
        merge_language: 'handlebars', global_merge_vars: mergeFor(row, ev, extra),
        track_opens: true, track_clicks: true,
      } }) });
    const out = await r.json().catch(() => null);
    const first = Array.isArray(out) ? out[0] : null;
    if (!r.ok || !first || (first.status !== 'sent' && first.status !== 'queued')) {
      status = 'failed';
      error = St((first && (first.reject_reason || first.status))
        || (out && out.message) || r.status).slice(0, 300);
    } else { status = first.status; provider = first._id || null; }
  } catch (e) { status = 'failed'; error = St(e).slice(0, 300); }
  await sb(env, `/haf_mail_log?ref=eq.${E(row.ref)}&event=eq.${E(ev)}`,
    { method: 'PATCH', body: S({ status, provider_id: provider, error }) });
  return status;
}

/* Fire and forget. A Mandrill outage must never make a sign-up fail or a
   reviewer's button hang - the ledger records what happened either way. */
function mailNow(env, ctx, ref, ev, extra, snap) {
  const p = journeyMail(env, ref, ev, extra, snap).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

/* ── "please confirm your email", with something to press ─────────────────────
   Confirming the address is a WALL: an unconfirmed account cannot be released
   into the network. On 4 August that wall stood for twenty-four days and every
   one of the twenty real applicants was behind it, because the email asking
   them to confirm carried no link and no token - there was no way over it from
   their side at all. The lesson is not "remember to send the email". It is that
   the ask and the means must be built in the same breath, or the ask is a
   closed door with a knock on it.

   So the token is minted HERE, on the request that creates the account, and it
   travels inside the button. The moment the account exists is the moment
   confirming it becomes possible. Nothing about this runs on a later sweep.

   It is written to the record BEFORE the email leaves: a link whose token the
   database has never heard of confirms nobody, and that is the failure that
   would look exactly like success from this side. If the write fails there is
   no point sending, so it does not. */
async function confirmMailNow(env, ctx, row) {
  if (!row || !row.ref || !row.email || row.email_verified) return;
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const job = (async () => {
    const w = await sb(env, `/${APPS}?ref=eq.${E(row.ref)}`, { method: 'PATCH',
      body: S({ email_confirm_token: token, email_confirm_sent_at: nowIso() }) });
    if (!w.ok) return;
    await journeyMail(env, row.ref, 'email_confirm_required', {
      action_url: `${CLEVER_URL}/confirm.html?ref=${E(row.ref)}&t=${E(token)}`,
    });
  })().catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
}

/* "We have your documents" is the email that stops an application going quiet
   on somebody, so it leaves the moment the last required file lands - not when
   a reviewer next opens the queue and remembers.

   What "complete" means is read from the office's own requirement list and
   never taken from the page. A page is held by the applicant and can be edited
   by whoever is holding it; the requirement list cannot. Freight and business
   are not in this at all - they hand over nothing, so there is nothing to
   acknowledge. Wall 4 means a later upload cannot send it a second time. */
async function mailWhenDocsComplete(env, ctx, app) {
  if (!app || !NEEDS_DOCS.includes(app.type)) return;
  const c = await sb(env, '/cleverpay_portal_config?id=eq.1&limit=1');
  const cfg = c.ok && c.body && c.body[0] ? c.body[0].config : null;
  const want = ((cfg && cfg.driver && cfg.driver.docs) || [])
    .filter((d) => d.status === 'required').map((d) => d.id);
  const have = new Set((app.docs || []).filter((d) => d && (d.path || d.filename)).map((d) => d.id));
  if (!want.length || !want.every((id) => have.has(id))) return;
  await journeyMail(env, app.ref, 'compliance_submission_complete');
}

function mailDocsCheck(env, ctx, app) {
  const p = mailWhenDocsComplete(env, ctx, app).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    const bad = (error, status) => J({ error }, status, cors);
    const M = req.method;                 /* read once — it is tested on every route */
    if (M === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    /* every route below is a path+method pair — read once, tested cheaply */
    const R = (path, method) => p === path && M === method;
    let b = {};
    /* /docs/file carries raw file bytes, so it must not be read as JSON */
    if (M !== 'GET' && p !== '/docs/file' && !p.startsWith('/team/')) { try { b = await req.json(); } catch {} }

    try {
      /* ── public: config (doc requirements + rebates) ── */
      if (R('/config', 'GET')) {
        const r = await sb(env, '/cleverpay_portal_config?id=eq.1&limit=1');
        return J(r.body && r.body[0] ? r.body[0].config : null, 200, cors);
      }

      /* ── applicant: sign up ── */
      if (R('/apply', 'POST')) {
        if (!b.type || !b.username || !b.pinHash) return bad('Missing required fields.', 400);
        const dupe = await findApp(env, b.username);
        if (dupe) return bad('An application already exists for this username. Log in instead, or contact the HAF team.', 409);
        const row = pickFields(b);
        row.ref = newRef(); row.status = 'pending'; row.docs = b.docs || [];
        row.submitted = nowIso();
        /* ── the journey stamp ──
           Brent, 13 Aug: everyone starts at join.usehaf.co.uk, and nobody
           already in the system hears anything until the new journey is
           finished. Only the join page hands over a signup id, so carrying one
           is the proof a person came through the new front door.

           The email engine reads stamped rows and NOTHING else. That is what
           holds the existing crowd back - not nine scheduled jobs switched off
           by hand, which anybody could switch on again by accident. */
        if (isJoinOrigin(req.headers.get('Origin') || '')) row.journey = 'v2';
        let r = await sb(env, `/${APPS}`, { method: 'POST', body: S(row) });
        /* The stamp is bookkeeping. The account is the person's only way in.
           The journey column arrives with migration 0046, and until somebody runs
           that migration the database refuses the WHOLE insert over that one
           field — so a reporting flag quietly becomes a front door that will not
           open, and only on the live domain, because only the live domain sets it.
           If the column is the single thing wrong, save the account without the
           stamp and leave a line in the log saying so. Nobody loses their account
           to a column that is not there yet. */
        if (!r.ok && row.journey && S(r.body).includes('journey')) {
          console.log('journey column missing — application saved unstamped; run migration 0046');
          delete row.journey;
          r = await sb(env, `/${APPS}`, { method: 'POST', body: S(row) });
        }
        if (!r.ok) return bad('Could not save your application. Please try again.', 500);
        alertNewEnquiry(env, ctx, r.body[0]);
        /* Their first email leaves now, on this request - not on the next sweep. */
        mailNow(env, ctx, r.body[0].ref, 'account_created');
        /* And the one that lets them over the email wall, with the token in it. */
        confirmMailNow(env, ctx, r.body[0]);
        return J(strip(r.body[0]), 200, cors);
      }

      /* ── public: business account enquiry (no login created — HAF team follows up) ── */
      if (R('/enquiry', 'POST')) {
        if (!b.company || !b.name || !b.email || !b.phone) return bad('Please fill in company, contact name, email and mobile.', 400);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return bad('That email address doesn’t look right.', 400);
        const row = {
          type: 'business', status: 'enquiry', ref: newRef(), docs: [],
          company: St(b.company).slice(0, 120), name: St(b.name).slice(0, 120),
          email: St(b.email).slice(0, 160), phone: St(b.phone).slice(0, 40),
          notes: St(b.notes || '').slice(0, 1500),
        };
        const r = await sb(env, `/${APPS}`, { method: 'POST', body: S(row) });
        if (!r.ok) return bad('Could not send your enquiry. Please try again.', 500);
        alertNewEnquiry(env, ctx, row);
        return J({ ok: true, ref: row.ref }, 200, cors);
      }

      /* ── applicant: log in ── */
      if (R('/login', 'POST')) {
        const app = await findApp(env, b.id || '');
        if (!app) return bad('No application found with that username or reference.', 404);
        if (app.pin_hash) {
          const attempt = b.pinHash || await sha256('HAF-CP|' + app.username + '|' + (b.pin || ''));
          if (attempt !== app.pin_hash) return bad('Incorrect PIN.', 401);
        }
        return J(strip(app), 200, cors);
      }

      /* ── applicant: save docs / poll status (needs ref + matching pin) ── */
      if (R('/docs', 'POST')) {
        const app = await findApp(env, b.ref || '');
        if (!app || (app.pin_hash && app.pin_hash !== b.pinHash)) return bad(NOAUTH, 401);
        const patch = { docs: b.docs || [], updated_at: nowIso() };
        if (b.dvla) {
          const v = readDvla(b.dvla, app);
          if (v.error) return bad(v.error, 400);
          Object.assign(patch, v.patch);
        }
        const r = await patchApp(env, app.ref, patch);
        if (!r.ok) return bad('Could not save documents.', 500);
        mailDocsCheck(env, ctx, r.body[0]);
        return J(strip(r.body[0]), 200, cors);
      }
      /* ── one real file onto a record (raw bytes; ref/doc id/pin in the query) ──
         Two people use this door. The applicant sends their own paperwork with
         their PIN, and the page writes the document list itself afterwards. The
         team sends paperwork that reached us another way — by email, on WhatsApp,
         handed over on a job (Brent, 4 Aug) — authorised by their session instead,
         and because they have no PIN to write the list with, the record is updated
         here. A file the office put on says so: it is not the same evidence as one
         the driver sent, and the row should never pretend otherwise. */
      if (R('/docs/file', 'POST')) {
        const q = url.searchParams;
        const app = await findApp(env, q.get('ref') || '');
        /* only pay for the session lookup when a team member is actually asking */
        const team = req.headers.get('Authorization') ? await teamUser(env, req) : null;
        if (!app || (!team && app.pin_hash && app.pin_hash !== q.get('k'))) return bad(NOAUTH, 401);
        const id = (q.get('id') || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
        if (!id) return bad('Missing document type.', 400);
        const mime = (req.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
        if (!DOC_MIME.includes(mime)) return bad('Please upload a PDF or a photo (JPG, PNG or HEIC).', 415);
        const bytes = await req.arrayBuffer();
        if (!bytes.byteLength) return bad('That file looks empty.', 400);
        if (bytes.byteLength > 15728640) return bad('That file is over 15MB — please upload a smaller copy.', 413);
        const path = `${app.ref}/${id}`;
        const up = await store(env, path, { method: 'POST', body: bytes,
          headers: { [CT]: mime, 'x-upsert': 'true' } });
        if (!up.ok) return bad('Could not store that file — please try again.', 502);
        if (!team) return J({ ok: true, path, size: bytes.byteLength, mime }, 200, cors);
        /* one row per document type: a replacement supersedes what was there, and it
           arrives unticked because nobody has read the new file yet */
        const docs = (Array.isArray(app.docs) ? app.docs : []).filter(d => d.id !== id);
        docs.push({ id, filename: St(q.get('filename') || id).slice(0, 120), path, mime,
          size: bytes.byteLength, added_by: team, added_at: nowIso(), by_team: true });
        const r = await patchApp(env, app.ref, { docs, updated_at: nowIso() });
        return r.ok && r.body[0] ? J({ ok: true, app: strip(r.body[0]) }, 200, cors)
          : bad('The file was stored but the record did not update — please try again.', 500);
      }

      if (R('/application', 'GET')) {
        const app = await findApp(env, url.searchParams.get('ref') || '');
        if (!app || (app.pin_hash && app.pin_hash !== url.searchParams.get('k'))) return bad(NOTFOUND, 404);
        return J(strip(app), 200, cors);
      }

      /* ── PLNA: redeem a Founders code for free Pro months (single-use, atomic) ── */
      if (R('/promo/redeem', 'POST')) {
        const code = St(b.code || '').toUpperCase().trim();
        const user = St(b.username || '').toUpperCase().trim();
        if (!user) return bad('Missing username.', 400);
        if (!/^H[631K]PRO-[A-Z0-9]{4,10}$/.test(code)) return bad('That code doesn’t look right — check it and try again.', 400);
        const MONTHS = { H6: 6, H3: 3, H1: 1 };
        const months = MONTHS[code.slice(0, 2)];
        if (!months) return bad('This code doesn’t include free PLNA Pro time.', 400);
        const r = await sb(env, `/${APPS}?promo_code=eq.${E(code)}&limit=1`);
        const app = r.ok && r.body && r.body[0];
        if (!app) return bad('Code not recognised — check it matches the code from your sign-up.', 404);
        if (app.username && app.username.toUpperCase() !== user) return bad('This code belongs to a different account.', 403);
        if (app.promo_redeemed_at) {
          if ((app.promo_redeemed_by || '').toUpperCase() === user)
            return J({ ok: true, months, redeemed_at: app.promo_redeemed_at, already: true }, 200, cors);
          return bad('This code has already been used.', 409);
        }
        const now = nowIso();
        const u2 = await sb(env, `/${APPS}?promo_code=eq.${E(code)}&promo_redeemed_at=is.null`, {
          method: 'PATCH', body: S({ promo_redeemed_at: now, promo_redeemed_by: user }) });
        if (!u2.ok || !u2.body || !u2.body[0]) return bad('Could not redeem just now — please try again.', 500);
        return J({ ok: true, months, redeemed_at: now }, 200, cors);
      }

      /* ── back office: read compliance status with an API key ──
         Deliberately NOT given CORS headers — this is server-to-server only, so no
         web page in any browser can read it even if somebody pasted a key into one. */
      if (R('/partner/compliance', 'GET')) {
        const bare = { [CT]: AJ, 'Cache-Control': 'no-store' };
        const key = await apiKeyRow(env, req);
        if (!key) return new Response(S({ error: NOAUTH }), { status: 401, headers: bare });
        noteKeyUse(env, ctx, key, p);
        const ref = (url.searchParams.get('ref') || '').trim();
        if (ref) {
          const app = await findApp(env, ref);
          if (!app) return new Response(S({ error: NOTFOUND }), { status: 404, headers: bare });
          return new Response(S(PARTNER_VIEW(app)), { status: 200, headers: bare });
        }
        const status = (url.searchParams.get('status') || '').replace(/[^a-z]/gi, '');
        const q = status ? `&status=eq.${E(status)}` : '';
        const r = await sb(env, `/${APPS}?order=submitted.desc&limit=500${q}`);
        const rows = (r.body || []).map(PARTNER_VIEW);
        return new Response(S({ count: rows.length, accounts: rows }), { status: 200, headers: bare });
      }

      /* ── team back office: a worker of its own ──
         Everything under /team/ now runs in cleverpay-admin. The reason is the
         pipe: a deploy of this script has to fit inside 20,000 characters, the
         single worker had reached 21,579, and no change of any size could go
         live or even to a preview. The back office is where the work happens,
         so it moved out.

         It has no public address — it is reachable only through this binding —
         and it holds no secret at rest: the database key travels on the request
         and is used for that request only. So the key still lives in exactly one
         place, which is here. */
      if (p.startsWith('/team/')) {
        if (!env.ADMIN) return bad('The back office is not reachable just now — please tell HAF.', 503);
        const h = new Headers(req.headers);
        h.set('x-cp-key', env.SB_KEY);
        h.set('x-cp-tg', env.TG_TOKEN || '');
        h.set('x-cp-tgchat', env.TG_CHAT || '');
        h.set('x-cp-origin', url.origin);
        const raw = M === 'GET' ? undefined : await req.arrayBuffer();
        /* ── the paperwork has to exist before the press can open anything ──
           Brent, 14 Aug: a freight account with an empty document list was
           released and PLNA let it straight in. Nothing ever looked at the
           documents — Confirm & release stamped the record and the door opened
           for somebody who had uploaded nothing.

           So the press is read here, on the way in, and refused while anything
           marked required is missing. It names the missing documents, because
           the reviewer's next move is to go and get them. It lives in this
           worker rather than the back office one purely for room: the back
           office is a few hundred characters under the size a worker can be
           uploaded at, and a guard that cannot be deployed guards nothing.

           This is the friendly half. The database refuses an unproven clearance
           outright, so a release that slipped past this still cannot open PLNA. */
        if (M === 'PATCH' && /^\/team\/applications\//.test(p)) {
          let tb = null;
          try { tb = JSON.parse(new TextDecoder().decode(raw)); } catch { tb = null; }
          if (tb && tb.confirm_access) {
            const cur = await findApp(env, decodeURIComponent(p.split('/')[3] || ''));
            if (cur) {
              const cr = await sb(env, '/cleverpay_portal_config?id=eq.1&limit=1');
              const cfg = cr.ok && cr.body && cr.body[0] ? cr.body[0].config : null;
              const set = cur.type === 'freight' ? (cfg && cfg.freight) : (cfg && cfg.driver);
              const need = (set && Array.isArray(set.docs) ? set.docs : []).filter(d => d.status === 'required');
              const held = (Array.isArray(tb.docs) ? tb.docs : (Array.isArray(cur.docs) ? cur.docs : [])).map(d => d.id);
              const miss = need.filter(d => !held.includes(d.id));
              if (miss.length) return bad('Cannot release access — still missing: '
                + miss.map(d => d.name || d.id).join(', ')
                + '. Add them to the record, then release.', 409);
            }
          }
        }
        const res = await env.ADMIN.fetch(new Request(url.toString(), {
          method: M, headers: h, body: raw,
        }));
        /* ── the reviewer's button IS the trigger ──
           The back office is where the press happens and knows which one it
           was; the sending key lives out here and in one place only. So the
           back office names the moment on the way back through, and the email
           goes out on this same request - about a second after the click, with
           nothing scheduled in between. A press with no email attached names
           nothing, and nothing is sent.

           The words a reviewer typed travel URL-encoded: a header may only
           carry plain Latin characters, and a name with an accent in it would
           otherwise throw away the whole response. */
        const ev = res.headers.get('x-cp-event');
        const ref = res.headers.get('x-cp-ref');
        if (ev && ref) {
          let item = '';
          try { item = decodeURIComponent(res.headers.get('x-cp-item') || ''); } catch { item = ''; }
          /* Only the delete button sends one of these, because it is the only
             press that leaves nothing behind to read. Anything malformed is
             dropped and the record is read normally. */
          let snap = null;
          try {
            const s = res.headers.get('x-cp-snap');
            if (s) snap = JSON.parse(decodeURIComponent(s));
          } catch { snap = null; }
          /* The reviewer names WHAT is missing; the sentence explaining what to
             do about it is the same every time, so it is written once, here,
             beside the rest of the copy - not retyped in the back office where
             it would cost upload room and drift out of step. */
          mailNow(env, ctx, ref, ev, item ? { item_name: item, item_reason: WHY_MISSING } : null, snap);
        }
        return res;
      }


      return bad(NOTFOUND, 404);
    } catch (e) {
      return bad('Server error.', 500);
    }
  }
};
