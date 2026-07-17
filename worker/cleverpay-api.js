/* CleverPay API — Cloudflare Worker
   Storage: HUB Supabase (cleverpay_* tables), service key via SB_KEY secret.
   Serves: applicant sign-up/login/docs/status + team portal (auth, queue, manual add, config). */

const SB = 'https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1';
const APPS = 'cleverpay_applications';
const OK_ORIGINS = ['https://clever.usehaf.co.uk', 'https://otisagent.github.io', 'https://plna.usehaf.co.uk'];

function corsHeaders(req) {
  const o = req.headers.get('Origin') || '';
  const ok = OK_ORIGINS.includes(o) || o.endsWith('.workers.dev') || o.endsWith('.vercel.app');
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

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    let b = {};
    if (req.method !== 'GET') { try { b = await req.json(); } catch {} }

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

      /* ── team: log in ── */
      if (p === '/team/login' && req.method === 'POST') {
        const u = (b.username || '').toLowerCase().trim();
        const hash = await sha256('HAF-CP-TEAM|' + u + '|' + (b.password || ''));
        const r = await sb(env, `/cleverpay_team_users?username=eq.${encodeURIComponent(u)}&limit=1`);
        const user = r.ok && r.body && r.body[0];
        if (!user || user.pw_hash !== hash) return J({ error: 'Wrong username or password.' }, 401, cors);
        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
        const expires = new Date(Date.now() + 7 * 864e5).toISOString();
        await sb(env, '/cleverpay_team_sessions', { method: 'POST', body: JSON.stringify({ token, username: u, expires_at: expires }) });
        return J({ token, username: u, name: user.name, role: user.role }, 200, cors);
      }

      /* ── team: everything below needs a session ── */
      if (p.startsWith('/team/')) {
        const who = await teamUser(env, req);
        if (!who) return J({ error: 'Session expired — sign in again.' }, 401, cors);

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
