/* CleverPay API — Cloudflare Worker
   Storage: HUB Supabase (cleverpay_* tables), service key via SB_KEY secret.
   Serves: applicant sign-up/login/docs/status + team portal (auth, queue, manual add, config). */

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
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });

async function sb(env, path, init = {}) {
  const r = await fetch(SB + path, {
    ...init,
    headers: {
      apikey: env.SB_KEY,
      Authorization: 'Bearer ' + env.SB_KEY,
      'Content-Type': 'application/json',
      Prefer: init.method === 'POST' || init.method === 'PATCH' ? 'return=representation' : undefined,
      ...init.headers,
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const strip = a => { if (!a) return a; const { pin_hash, ...rest } = a; return rest; };
const newRef = () => 'HAF-CP-' + [...crypto.getRandomValues(new Uint8Array(4))].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

async function findApp(env, id) {
  const q = encodeURIComponent(id.toUpperCase());
  const r = await sb(env, `/${APPS}?or=(ref.eq.${q},username.eq.${q})&limit=1`);
  return r.ok && r.body && r.body[0] ? r.body[0] : null;
}

/* Which required documents are still outstanding on this application.
   Worked out from the config the team saved — the same list the portal shows —
   so a reminder can never ask for a document the settings no longer require. */
function missingRequired(cfg, app) {
  const set = app.type === 'freight' ? (cfg && cfg.freight) : (cfg && cfg.driver);
  const defs = (set && Array.isArray(set.docs) ? set.docs : []).filter(d => d.status === 'required');
  const have = (Array.isArray(app.docs) ? app.docs : []).map(d => d.id);
  return defs.filter(d => !have.includes(d.id)).map(d => ({ id: d.id, name: d.name, hint: d.hint || '' }));
}

async function teamUser(env, req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  const r = await sb(env, `/cleverpay_team_sessions?token=eq.${encodeURIComponent(m[1])}&limit=1`);
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

/* ── new-enquiry alert → the "HAF Sign ups - Enquiries" Telegram group ──
   Four lines only, signed off by Brent 28 Jul. Fire-and-forget: a Telegram
   failure must never break somebody's sign-up. TG_TOKEN/TG_CHAT are secrets.

   Brent 30 Jul: Gemma Vale runs compliance and the CleverPay team, so she must
   be notified of every new enquiry. The ping rides on the 🟠 of line one as a
   tg://user mention — it cuts through a muted group without adding a fifth
   line. TG_NOTIFY_IDS (comma-separated Telegram user ids) overrides the
   default if the people to notify change.

   30 Jul, second pass: a tg://user mention of an id Telegram cannot resolve is
   rejected outright (400 "wrong user_id specified") — which would take the WHOLE
   alert down with it, silently, because failures here are swallowed. The ping is
   a nice-to-have; the enquiry landing in the group is not. So the send now walks
   a ladder: mention → same message with a plain 🟠 → plain text with no markup.
   The enquiry always arrives, whatever Telegram thinks of the id. */
const NOTIFY_DEFAULT = ''; /* set TG_NOTIFY_IDS once an id is confirmed from Telegram itself */
const TYPE_LABELS = {
  driver: 'Owner Driver',
  fleet: 'Fleet / Courier Company',
  freight: 'Freight Forwarder',
  business: 'Business Account',
};
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ukStamp(d = new Date()) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'short' }).format(d);
  return `${time}, ${day}`;
}

/* The 🟠 becomes a mention of the first person to notify; anyone after them
   rides on an invisible separator straight after it. Nothing visible changes. */
function alertHeader(env, label) {
  const ids = String(env.TG_NOTIFY_IDS || NOTIFY_DEFAULT)
    .split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  const dot = ids.length ? `<a href="tg://user?id=${ids[0]}">🟠</a>` : '🟠';
  const extra = ids.slice(1).map((id) => `<a href="tg://user?id=${id}">⁣</a>`).join('');
  return `<b>${dot}${extra} NEW ENQUIRY — ${esc(label)}</b>`;
}

async function tgSend(env, text, html) {
  const body = { chat_id: env.TG_CHAT, text, disable_web_page_preview: true };
  if (html) body.parse_mode = 'HTML';
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.log('enquiry alert rejected', r.status, await r.text().catch(() => ''));
  return r.ok;
}

async function sendEnquiryAlert(env, row) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  const label = TYPE_LABELS[row.type] || 'New account';
  const who = [row.fname, row.lname].filter(Boolean).join(' ') || row.name || row.company || '—';
  const contact = [row.phone, row.email].filter(Boolean).join(' · ') || '—';
  const rest =
    `<b>Ref:</b> ${esc(row.ref)} · ${ukStamp()}\n` +
    `<b>Name:</b> ${esc(who)}\n` +
    `<b>Contact:</b> ${esc(contact)}`;
  const head = alertHeader(env, label);
  const plainHead = `<b>🟠 NEW ENQUIRY — ${esc(label)}</b>`;
  if (head !== plainHead && await tgSend(env, `${head}\n${rest}`, true)) return;
  if (await tgSend(env, `${plainHead}\n${rest}`, true)) return;
  await tgSend(env, `🟠 NEW ENQUIRY — ${label}\nRef: ${row.ref} · ${ukStamp()}\n` +
    `Name: ${who}\nContact: ${contact}`, false);
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
const canIntegrate = (u) => INTEGRATION_USERS.includes(String(u || '').toLowerCase().trim());

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
  const key = String(raw || '').trim();
  if (!/^cpk_[a-f0-9]{40}$/.test(key)) return null;
  const r = await sb(env, `/cleverpay_api_keys?key_hash=eq.${await keyHash(key)}&revoked_at=is.null&limit=1`);
  return r.ok && r.body && r.body[0] ? r.body[0] : null;
}

/* "when it last talked to us" on the panel comes from this — never let it break a reply */
function noteKeyUse(env, ctx, row, path) {
  const p = sb(env, `/cleverpay_api_keys?id=eq.${row.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_used_at: new Date().toISOString(), last_used_path: path, use_count: (row.use_count || 0) + 1 }),
  }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    let b = {};
    /* /docs/file carries raw file bytes, so it must not be read as JSON */
    if (req.method !== 'GET' && p !== '/docs/file') { try { b = await req.json(); } catch {} }

    try {
      /* ── public: config (doc requirements + rebates) ── */
      if (p === '/config' && req.method === 'GET') {
        const r = await sb(env, '/cleverpay_portal_config?id=eq.1&limit=1');
        return J(r.body && r.body[0] ? r.body[0].config : null, 200, cors);
      }

      /* ── applicant: sign up ── */
      if (p === '/apply' && req.method === 'POST') {
        if (!b.type || !b.username || !b.pinHash) return J({ error: 'Missing required fields.' }, 400, cors);
        const dupe = await findApp(env, b.username);
        if (dupe) return J({ error: 'An application already exists for this username. Log in instead, or contact the HAF team.' }, 409, cors);
        const row = pickFields(b);
        row.ref = newRef(); row.status = 'pending'; row.docs = b.docs || [];
        const r = await sb(env, `/${APPS}`, { method: 'POST', body: JSON.stringify(row) });
        if (!r.ok) return J({ error: 'Could not save your application. Please try again.' }, 500, cors);
        alertNewEnquiry(env, ctx, r.body[0]);
        return J(strip(r.body[0]), 200, cors);
      }

      /* ── public: business account enquiry (no login created — HAF team follows up) ── */
      if (p === '/enquiry' && req.method === 'POST') {
        if (!b.company || !b.name || !b.email || !b.phone) return J({ error: 'Please fill in company, contact name, email and mobile.' }, 400, cors);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return J({ error: 'That email address doesn’t look right.' }, 400, cors);
        const row = {
          type: 'business', status: 'enquiry', ref: newRef(), docs: [],
          company: String(b.company).slice(0, 120), name: String(b.name).slice(0, 120),
          email: String(b.email).slice(0, 160), phone: String(b.phone).slice(0, 40),
          notes: String(b.notes || '').slice(0, 1500),
        };
        const r = await sb(env, `/${APPS}`, { method: 'POST', body: JSON.stringify(row) });
        if (!r.ok) return J({ error: 'Could not send your enquiry. Please try again.' }, 500, cors);
        alertNewEnquiry(env, ctx, row);
        return J({ ok: true, ref: row.ref }, 200, cors);
      }

      /* ── applicant: log in ── */
      if (p === '/login' && req.method === 'POST') {
        const app = await findApp(env, b.id || '');
        if (!app) return J({ error: 'No application found with that username or reference.' }, 404, cors);
        if (app.pin_hash) {
          const attempt = b.pinHash || await sha256('HAF-CP|' + app.username + '|' + (b.pin || ''));
          if (attempt !== app.pin_hash) return J({ error: 'Incorrect PIN.' }, 401, cors);
        }
        return J(strip(app), 200, cors);
      }

      /* ── applicant: save docs / poll status (needs ref + matching pin) ── */
      if (p === '/docs' && req.method === 'POST') {
        const app = await findApp(env, b.ref || '');
        if (!app || (app.pin_hash && app.pin_hash !== b.pinHash)) return J({ error: 'Not authorised.' }, 401, cors);
        const r = await sb(env, `/${APPS}?ref=eq.${encodeURIComponent(app.ref)}`, {
          method: 'PATCH', body: JSON.stringify({ docs: b.docs || [], updated_at: new Date().toISOString() }) });
        return r.ok ? J(strip(r.body[0]), 200, cors) : J({ error: 'Could not save documents.' }, 500, cors);
      }
      /* ── applicant: upload one real file (raw bytes; ref/doc id/pin in the query) ── */
      if (p === '/docs/file' && req.method === 'POST') {
        const q = url.searchParams;
        const app = await findApp(env, q.get('ref') || '');
        if (!app || (app.pin_hash && app.pin_hash !== q.get('k'))) return J({ error: 'Not authorised.' }, 401, cors);
        const id = (q.get('id') || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
        if (!id) return J({ error: 'Missing document type.' }, 400, cors);
        const mime = (req.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
        if (!DOC_MIME.includes(mime)) return J({ error: 'Please upload a PDF or a photo (JPG, PNG or HEIC).' }, 415, cors);
        const bytes = await req.arrayBuffer();
        if (!bytes.byteLength) return J({ error: 'That file looks empty.' }, 400, cors);
        if (bytes.byteLength > 15728640) return J({ error: 'That file is over 15MB — please upload a smaller copy.' }, 413, cors);
        const path = `${app.ref}/${id}`;
        const up = await store(env, path, { method: 'POST', body: bytes,
          headers: { 'Content-Type': mime, 'x-upsert': 'true' } });
        if (!up.ok) return J({ error: 'Could not store that file — please try again.' }, 502, cors);
        return J({ ok: true, path, size: bytes.byteLength, mime }, 200, cors);
      }

      if (p === '/application' && req.method === 'GET') {
        const app = await findApp(env, url.searchParams.get('ref') || '');
        if (!app || (app.pin_hash && app.pin_hash !== url.searchParams.get('k'))) return J({ error: 'Not found.' }, 404, cors);
        return J(strip(app), 200, cors);
      }

      /* ── PLNA: redeem a Founders code for free Pro months (single-use, atomic) ── */
      if (p === '/promo/redeem' && req.method === 'POST') {
        const code = String(b.code || '').toUpperCase().trim();
        const user = String(b.username || '').toUpperCase().trim();
        if (!user) return J({ error: 'Missing username.' }, 400, cors);
        if (!/^H[631K]PRO-[A-Z0-9]{4,10}$/.test(code)) return J({ error: 'That code doesn’t look right — check it and try again.' }, 400, cors);
        const MONTHS = { H6: 6, H3: 3, H1: 1 };
        const months = MONTHS[code.slice(0, 2)];
        if (!months) return J({ error: 'This code doesn’t include free PLNA Pro time.' }, 400, cors);
        const r = await sb(env, `/${APPS}?promo_code=eq.${encodeURIComponent(code)}&limit=1`);
        const app = r.ok && r.body && r.body[0];
        if (!app) return J({ error: 'Code not recognised — check it matches the code from your sign-up.' }, 404, cors);
        if (app.username && app.username.toUpperCase() !== user) return J({ error: 'This code belongs to a different account.' }, 403, cors);
        if (app.promo_redeemed_at) {
          if ((app.promo_redeemed_by || '').toUpperCase() === user)
            return J({ ok: true, months, redeemed_at: app.promo_redeemed_at, already: true }, 200, cors);
          return J({ error: 'This code has already been used.' }, 409, cors);
        }
        const now = new Date().toISOString();
        const u2 = await sb(env, `/${APPS}?promo_code=eq.${encodeURIComponent(code)}&promo_redeemed_at=is.null`, {
          method: 'PATCH', body: JSON.stringify({ promo_redeemed_at: now, promo_redeemed_by: user }) });
        if (!u2.ok || !u2.body || !u2.body[0]) return J({ error: 'Could not redeem just now — please try again.' }, 500, cors);
        return J({ ok: true, months, redeemed_at: now }, 200, cors);
      }

      /* ── back office: read compliance status with an API key ──
         Deliberately NOT given CORS headers — this is server-to-server only, so no
         web page in any browser can read it even if somebody pasted a key into one. */
      if (p === '/partner/compliance' && req.method === 'GET') {
        const bare = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        const key = await apiKeyRow(env, req);
        if (!key) return new Response(JSON.stringify({ error: 'Not authorised.' }), { status: 401, headers: bare });
        noteKeyUse(env, ctx, key, p);
        const ref = (url.searchParams.get('ref') || '').trim();
        if (ref) {
          const app = await findApp(env, ref);
          if (!app) return new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: bare });
          return new Response(JSON.stringify(PARTNER_VIEW(app)), { status: 200, headers: bare });
        }
        const status = (url.searchParams.get('status') || '').replace(/[^a-z]/gi, '');
        const q = status ? `&status=eq.${encodeURIComponent(status)}` : '';
        const r = await sb(env, `/${APPS}?order=submitted.desc&limit=500${q}`);
        const rows = (r.body || []).map(PARTNER_VIEW);
        return new Response(JSON.stringify({ count: rows.length, accounts: rows }), { status: 200, headers: bare });
      }

      /* ── team: log in ──
         First-time members have must_set_pin set: they sign in once with the one-time
         setup code they were given, then choose their own PIN (see /team/set-pin). */
      if (p === '/team/login' && req.method === 'POST') {
        const u = (b.username || '').toLowerCase().trim();
        const hash = await sha256('HAF-CP-TEAM|' + u + '|' + (b.password || ''));
        const r = await sb(env, `/cleverpay_team_users?username=eq.${encodeURIComponent(u)}&limit=1`);
        const user = r.ok && r.body && r.body[0];
        if (!user) return J({ error: 'Wrong username or password.' }, 401, cors);
        const first = !!user.must_set_pin;
        const ok = first
          ? !!user.setup_code && (b.password || '').trim().toUpperCase() === user.setup_code.toUpperCase()
          : user.pw_hash === hash;
        if (!ok) return J({ error: first ? 'That setup code is not right.' : 'Wrong username or password.' }, 401, cors);
        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
        const expires = new Date(Date.now() + (first ? 36e5 : 7 * 864e5)).toISOString();
        await sb(env, '/cleverpay_team_sessions', { method: 'POST', body: JSON.stringify({ token, username: u, expires_at: expires }) });
        return J({ token, username: u, name: user.name, role: user.role, mustSetPin: first }, 200, cors);
      }

      /* ── team: everything below needs a session ── */
      if (p.startsWith('/team/')) {
        const who = await teamUser(env, req);
        if (!who) return J({ error: 'Session expired — sign in again.' }, 401, cors);
        const ur = await sb(env, `/cleverpay_team_users?username=eq.${encodeURIComponent(who)}&limit=1`);
        const me = ur.ok && ur.body && ur.body[0];
        if (!me) return J({ error: 'Session expired — sign in again.' }, 401, cors);

        /* choose / change your own PIN — nobody else ever sets it for you */
        if (p === '/team/set-pin' && req.method === 'POST') {
          const pin = (b.pin || '').trim();
          if (!/^\d{4,6}$/.test(pin)) return J({ error: 'Your PIN must be 4 to 6 numbers.' }, 400, cors);
          if (!me.must_set_pin) {
            const current = await sha256('HAF-CP-TEAM|' + who + '|' + (b.currentPin || ''));
            if (current !== me.pw_hash) return J({ error: 'Your current PIN is not right.' }, 401, cors);
          }
          const pw = await sha256('HAF-CP-TEAM|' + who + '|' + pin);
          const r = await sb(env, `/cleverpay_team_users?username=eq.${encodeURIComponent(who)}`,
            { method: 'PATCH', body: JSON.stringify({ pw_hash: pw, must_set_pin: false, setup_code: null }) });
          if (!r.ok) return J({ error: 'Could not save your PIN — please try again.' }, 500, cors);
          const tk = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
          await sb(env, `/cleverpay_team_sessions?token=eq.${encodeURIComponent(tk)}`,
            { method: 'PATCH', body: JSON.stringify({ expires_at: new Date(Date.now() + 7 * 864e5).toISOString() }) });
          return J({ ok: true }, 200, cors);
        }

        /* a first-time member sees nothing else until their PIN is set */
        if (me.must_set_pin) return J({ error: 'Choose your PIN first.' }, 403, cors);

        if (p === '/team/applications' && req.method === 'GET') {
          const r = await sb(env, `/${APPS}?order=submitted.desc&limit=500`);
          return J((r.body || []).map(strip), 200, cors);
        }

        /* manual add by team (drivers or freight) */
        if (p === '/team/applications' && req.method === 'POST') {
          if (!b.type || !b.username) return J({ error: 'Missing required fields.' }, 400, cors);
          const dupe = await findApp(env, b.username);
          if (dupe) return J({ error: `${b.username} already exists (ref ${dupe.ref}, status ${dupe.status}).` }, 409, cors);
          const row = pickFields(b);
          row.ref = newRef(); row.added_by = who; row.docs = b.docs || [];
          row.status = b.status === 'approved' ? 'approved' : 'pending';
          if (row.status === 'approved') row.approved_at = new Date().toISOString();
          const r = await sb(env, `/${APPS}`, { method: 'POST', body: JSON.stringify(row) });
          return r.ok ? J(strip(r.body[0]), 200, cors) : J({ error: 'Could not add — please try again.' }, 500, cors);
        }

        /* status / docs updates from the queue */
        const m = p.match(/^\/team\/applications\/([A-Za-z0-9-]+)$/);
        if (m && req.method === 'PATCH') {
          const patch = { updated_at: new Date().toISOString() };
          if (b.status) {
            patch.status = b.status;
            if (b.status === 'approved') patch.approved_at = new Date().toISOString();
            if (b.status === 'rejected') { patch.rejected_at = new Date().toISOString(); patch.reject_reason = b.rejectReason || null; }
          }
          if (b.docs !== undefined) patch.docs = b.docs;
          const r = await sb(env, `/${APPS}?ref=eq.${encodeURIComponent(m[1])}`, { method: 'PATCH', body: JSON.stringify(patch) });
          return r.ok && r.body[0] ? J(strip(r.body[0]), 200, cors) : J({ error: 'Update failed.' }, 500, cors);
        }

        /* ── reviewer opens the actual file — bytes proxied through this session, never a public link ── */
        if (p === '/team/doc' && req.method === 'GET') {
          const app = await findApp(env, url.searchParams.get('ref') || '');
          const id = (url.searchParams.get('id') || '').replace(/[^a-z0-9_-]/gi, '');
          const d = app && (Array.isArray(app.docs) ? app.docs : []).find(x => x.id === id);
          if (!d) return J({ error: 'No such document on this application.' }, 404, cors);
          if (!d.path) return J({ error: 'no_file' }, 404, cors);
          const f = await store(env, d.path, { method: 'GET' });
          if (!f.ok) return J({ error: 'That file could not be opened.' }, 502, cors);
          return new Response(f.body, { status: 200, headers: { ...cors,
            'Content-Type': d.mime || f.headers.get('Content-Type') || 'application/octet-stream',
            'Content-Disposition': `inline; filename="${String(d.filename || id).replace(/["\r\n]/g, '')}"` } });
        }

        /* ── reviewer ticks a document off — recorded on the application with who and when ── */
        if (p === '/team/doc-check' && req.method === 'POST') {
          const app = await findApp(env, b.ref || '');
          if (!app) return J({ error: 'Not found.' }, 404, cors);
          const now = new Date().toISOString();
          const docs = (Array.isArray(app.docs) ? app.docs : []).map(d => d.id !== b.id ? d
            : { ...d, checked: !!b.checked, checked_by: b.checked ? who : null, checked_at: b.checked ? now : null });
          const r = await sb(env, `/${APPS}?ref=eq.${encodeURIComponent(app.ref)}`,
            { method: 'PATCH', body: JSON.stringify({ docs, updated_at: now }) });
          return r.ok ? J({ ok: true, docs }, 200, cors) : J({ error: 'Could not save that tick.' }, 500, cors);
        }

        /* ── chase the documents we are still waiting on ──
           Nothing can be processed until the paperwork is in, so the queue needs a
           one-click nudge. The click is recorded here with who sent it and exactly
           which documents were outstanding at that moment; the email itself goes out
           from the HAF mailbox on the next reminder run. One per applicant per day —
           a chase that lands twice in an afternoon reads as harassment. */
        if (p === '/team/remind' && req.method === 'POST') {
          const app = await findApp(env, b.ref || '');
          if (!app) return J({ error: 'Not found.' }, 404, cors);
          if (app.type === 'business') return J({ error: 'Business enquiries do not have compliance documents.' }, 400, cors);
          if (!app.email) return J({ error: 'There is no email address on this application.' }, 400, cors);
          const cr = await sb(env, '/cleverpay_portal_config?id=eq.1&limit=1');
          const cfg = cr.ok && cr.body && cr.body[0] ? cr.body[0].config : null;
          if (!cfg) return J({ error: 'Could not read the document settings — try again in a moment.' }, 503, cors);
          const missing = missingRequired(cfg, app);
          if (!missing.length) return J({ error: 'Every required document is already in — there is nothing to chase.' }, 400, cors);
          const last = app.reminder_requested_at || app.reminder_sent_at;
          if (last && Date.now() - Date.parse(last) < 20 * 3600e3)
            return J({ error: 'This applicant has already been reminded today — you can send another tomorrow.' }, 429, cors);
          const now = new Date().toISOString();
          const r = await sb(env, `/${APPS}?ref=eq.${encodeURIComponent(app.ref)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              reminder_requested_at: now, reminder_by: who, reminder_docs: missing,
              reminder_count: (app.reminder_count || 0) + 1, updated_at: now,
            }),
          });
          if (!r.ok || !r.body || !r.body[0]) return J({ error: 'Could not queue that reminder — please try again.' }, 500, cors);
          return J({ ok: true, email: app.email, missing: missing.map(m => m.name), app: strip(r.body[0]) }, 200, cors);
        }

        /* ── the integration panel — Brent and Gemma only ──
           Anyone else gets exactly the same 404 as a route that does not exist. */
        if (p.startsWith('/team/integration')) {
          if (!canIntegrate(who)) return J({ error: 'Not found.' }, 404, cors);
          const kr = await sb(env, '/cleverpay_api_keys?revoked_at=is.null&order=created_at.desc&limit=1');
          const active = kr.ok && kr.body && kr.body[0] ? kr.body[0] : null;
          const summary = (k) => k && {
            prefix: k.key_prefix, label: k.label, created_at: k.created_at, created_by: k.created_by,
            last_used_at: k.last_used_at, use_count: k.use_count || 0,
          };

          if (p === '/team/integration' && req.method === 'GET') {
            /* a real check, not a guess: if we cannot read the table the back office
               reads, the panel must say so rather than show a comforting green line */
            const probe = await sb(env, `/${APPS}?select=ref&limit=1`);
            return J({
              endpoint: url.origin + '/partner/compliance',
              key: summary(active),
              live: probe.ok,
              checked_at: new Date().toISOString(),
              shares: ['reference', 'name', 'account type', 'compliance status', 'dates'],
            }, 200, cors);
          }

          /* generate or rotate — the plaintext key is returned this once and never again */
          if (p === '/team/integration/key' && req.method === 'POST') {
            const key = newApiKey();
            const row = {
              label: String(b.label || 'Back office').slice(0, 60),
              key_hash: await keyHash(key), key_prefix: key.slice(0, 12), created_by: who,
            };
            const ins = await sb(env, '/cleverpay_api_keys', { method: 'POST', body: JSON.stringify(row) });
            if (!ins.ok) return J({ error: 'Could not create the key — please try again.' }, 500, cors);
            /* rotate: the old key stops working the moment the new one exists */
            if (active) await sb(env, `/cleverpay_api_keys?id=eq.${active.id}`, {
              method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString(), revoked_by: who }) });
            return J({ key, rotated: !!active, summary: summary(ins.body[0]) }, 200, cors);
          }

          if (p === '/team/integration/revoke' && req.method === 'POST') {
            if (!active) return J({ error: 'There is no active key to switch off.' }, 400, cors);
            const r = await sb(env, `/cleverpay_api_keys?id=eq.${active.id}`, {
              method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString(), revoked_by: who }) });
            return r.ok ? J({ ok: true }, 200, cors) : J({ error: 'Could not switch the key off.' }, 500, cors);
          }

          return J({ error: 'Not found.' }, 404, cors);
        }

        if (p === '/team/config' && req.method === 'PUT') {
          const r = await sb(env, '/cleverpay_portal_config?id=eq.1', { method: 'PATCH', body: JSON.stringify({ config: b }) });
          return r.ok ? J({ ok: true }, 200, cors) : J({ error: 'Could not save settings.' }, 500, cors);
        }
      }

      return J({ error: 'Not found.' }, 404, cors);
    } catch (e) {
      return J({ error: 'Server error.' }, 500, cors);
    }
  }
};
