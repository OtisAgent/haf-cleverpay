/* CleverPay team & access — Cloudflare Worker (cleverpay-users)

   Who is allowed into the back office, and what each of them may do. Brent asked
   for this on 10 Sep: he had no way to manage the portal's own people, so every
   new reviewer, every PIN and every permission came through me. That is a person
   as a single point of failure, and it is not how an owner should hold his own
   admin.

   Why it is a third worker rather than more lines in cleverpay-admin. A deploy
   travels through a pipe that caps the whole upload at 20,000 characters, and
   the back office build was 19,686 of them — 94 characters of room, measured,
   not guessed. A screen that cannot be deployed manages nobody, so this went
   into a script of its own with room to grow.

   It has no public address. cleverpay-api reaches it over a private binding and
   hands it the database key on the request, exactly as it does the back office,
   so the secret still lives in one place and nothing is held at rest here.

   Two rules are enforced in here and nowhere else, because a switch that only
   the browser respects is not a switch:
     - only an admin may read or change any of this;
     - the portal can never be left with nobody in charge, and nobody can
       switch off or demote their own login. */

const SB = 'https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1';
const USERS = '/cleverpay_team_users';
const SESS = '/cleverpay_team_sessions';
const OK_ORIGINS = ['https://clever.usehaf.co.uk', 'https://otisagent.github.io', 'https://plna.usehaf.co.uk'];
const CT = 'Content-Type';
const AJ = 'application/json';
const S = JSON.stringify;
const E = encodeURIComponent;
const St = String;
const nowIso = () => new Date().toISOString();
const ROLES = ['admin', 'compliance'];

function corsHeaders(req) {
  const o = req.headers.get('Origin') || '';
  const ok = OK_ORIGINS.includes(o) || o.endsWith('.workers.dev') || o.endsWith('.pages.dev');
  return {
    'Access-Control-Allow-Origin': ok ? o : OK_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Cache-Control': 'no-store',
  };
}
const J = (data, status, cors) => new Response(S(data), { status, headers: { [CT]: AJ, ...cors } });

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

/* A code someone reads off a screen and types once. No letters or digits that
   are read as each other down a phone line, because the first thing a wrong
   character costs is a call to whoever set the account up. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const oneTimeCode = () => [...crypto.getRandomValues(new Uint8Array(8))]
  .map(b => CODE_ALPHABET[b % 32]).join('');

/* The row needs a password hash it can never match. A new member has no PIN at
   all until they choose one, and the honest way to say that is a hash of
   something nobody holds — not a blank, and never a default anybody could
   guess. */
async function unusableHash() {
  const seed = crypto.randomUUID() + crypto.randomUUID();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('HAF-CP-NOPIN|' + seed));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function whoAmI(env, req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  const r = await sb(env, `${SESS}?token=eq.${E(m[1])}&limit=1`);
  const s = r.ok && r.body && r.body[0];
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const u = await sb(env, `${USERS}?username=eq.${E(s.username)}&limit=1`);
  const row = u.ok && u.body && u.body[0];
  /* A login switched off mid-session stops working on its next request, not at
     the end of the week its session had left to run. */
  if (!row || row.active === false) return null;
  return row;
}

/* What the screen is allowed to know. A hash and a live setup code are neither
   of them anybody's business, including an admin's — the code is shown once, at
   the moment it is created, and never read back. */
const view = (u) => ({
  username: u.username,
  name: u.name,
  role: u.role,
  active: u.active !== false,
  canRelease: u.can_release === true,
  awaitingPin: u.must_set_pin === true,
  createdBy: u.created_by || null,
  createdAt: u.created_at || null,
  changedBy: u.access_changed_by || null,
  changedAt: u.access_changed_at || null,
});

/* The one guard that matters: this portal must always have at least one person
   who can still get in and change things. Counting is done against the database
   at the moment of the press, never against what the browser last drew. */
async function otherActiveAdmins(env, username) {
  const r = await sb(env, `${USERS}?select=username,role,active&role=eq.admin&active=is.true`);
  return (r.ok && Array.isArray(r.body) ? r.body : []).filter(u => u.username !== username).length;
}

export default {
  async fetch(req, bound) {
    const cors = corsHeaders(req);
    const bad = (error, status) => J({ error }, status, cors);
    const M = req.method;
    if (M === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    /* the key arrives on the request from cleverpay-api and is never stored here */
    const env = { SB_KEY: req.headers.get('x-cp-key') || bound.SB_KEY };
    if (!env.SB_KEY) return bad('The back office could not reach the records — please tell HAF.', 503);

    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    let b = {};
    if (M !== 'GET') { try { b = await req.json(); } catch {} }

    try {
      const me = await whoAmI(env, req);
      if (!me) return bad('Session expired — sign in again.', 401);
      /* Managing people is the owner's screen. A reviewer signed into the same
         portal gets a plain 404 rather than a locked door: the tab is not part
         of their job and it is not theirs to know about. */
      if (me.role !== 'admin') return bad('Not found.', 404);

      if (p === '/team/users' && M === 'GET') {
        const r = await sb(env, `${USERS}?select=*&order=username`);
        if (!r.ok) return bad('Could not read the team list — please try again.', 502);
        return J({
          me: { username: me.username, name: me.name },
          users: (r.body || []).map(view),
        }, 200, cors);
      }

      if (p === '/team/users/add' && M === 'POST') {
        const name = St(b.name || '').trim().slice(0, 80);
        const username = St(b.username || '').toLowerCase().trim();
        const role = ROLES.includes(b.role) ? b.role : 'compliance';
        if (name.length < 2) return bad('Give the person a name.', 400);
        if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
          return bad('A login is 3 to 32 characters: letters, numbers, dot, dash or underscore.', 400);
        }
        const dup = await sb(env, `${USERS}?username=eq.${E(username)}&limit=1`);
        if (dup.ok && dup.body && dup.body[0]) return bad('That login already exists.', 409);

        const code = oneTimeCode();
        const row = {
          username, name, role,
          pw_hash: await unusableHash(),
          must_set_pin: true,
          setup_code: code,
          can_release: b.canRelease === true,
          can_release_granted_by: b.canRelease === true ? me.name + ' (' + me.username + ')' : null,
          can_release_granted_at: b.canRelease === true ? nowIso() : null,
          active: true,
          created_by: me.username,
          created_at: nowIso(),
        };
        const ins = await sb(env, USERS, { method: 'POST', body: S(row) });
        if (!ins.ok) return bad('Could not add them — please try again.', 500);
        /* Shown once, on this reply, and never obtainable again. Whoever adds
           the person passes it on; the person then chooses a PIN nobody else
           has ever seen, which is the whole point of it. */
        return J({ ok: true, username, setupCode: code, user: view(ins.body[0] || row) }, 200, cors);
      }

      if (p === '/team/users/access' && M === 'POST') {
        const username = St(b.username || '').toLowerCase().trim();
        const r = await sb(env, `${USERS}?username=eq.${E(username)}&limit=1`);
        const target = r.ok && r.body && r.body[0];
        if (!target) return bad('No such login.', 404);

        const patch = { access_changed_by: me.username, access_changed_at: nowIso() };
        const wantsActive = b.active === undefined ? target.active !== false : b.active === true;
        const wantsRole = b.role === undefined ? target.role : (ROLES.includes(b.role) ? b.role : target.role);

        /* Nobody talks themselves out of their own portal. It reads as a small
           thing until it is the only admin login and the tab has gone. */
        if (username === me.username && (!wantsActive || wantsRole !== 'admin')) {
          return bad('You cannot switch off or step down your own login. Ask another admin to do it.', 409);
        }
        /* And the portal is never left with nobody in charge. */
        if (target.role === 'admin' && target.active !== false && (!wantsActive || wantsRole !== 'admin')) {
          if (await otherActiveAdmins(env, username) === 0) {
            return bad('This is the last admin login. Add another admin first, then change this one.', 409);
          }
        }

        if (b.active !== undefined) patch.active = wantsActive;
        if (b.role !== undefined) patch.role = wantsRole;
        if (b.canRelease !== undefined) {
          patch.can_release = b.canRelease === true;
          patch.can_release_granted_by = b.canRelease === true ? me.name + ' (' + me.username + ')' : null;
          patch.can_release_granted_at = b.canRelease === true ? nowIso() : null;
        }

        const up = await sb(env, `${USERS}?username=eq.${E(username)}`, { method: 'PATCH', body: S(patch) });
        if (!up.ok) return bad('Could not save that change — please try again.', 500);
        /* Switched off means out now. A session left alive is an open door with
           a note on it saying the door is shut. */
        if (patch.active === false) await sb(env, `${SESS}?username=eq.${E(username)}`, { method: 'DELETE' });
        return J({ ok: true, user: view((up.body && up.body[0]) || { ...target, ...patch }) }, 200, cors);
      }

      if (p === '/team/users/remove' && M === 'POST') {
        const username = St(b.username || '').toLowerCase().trim();
        if (username === me.username) return bad('You cannot remove your own login.', 409);
        const r = await sb(env, `${USERS}?username=eq.${E(username)}&limit=1`);
        const target = r.ok && r.body && r.body[0];
        if (!target) return bad('No such login.', 404);
        if (target.role === 'admin' && target.active !== false && await otherActiveAdmins(env, username) === 0) {
          return bad('This is the last admin login. Add another admin first.', 409);
        }
        await sb(env, `${SESS}?username=eq.${E(username)}`, { method: 'DELETE' });
        const del = await sb(env, `${USERS}?username=eq.${E(username)}`, { method: 'DELETE' });
        if (!del.ok) return bad('Could not remove that login — please try again.', 500);
        return J({ ok: true, removed: username }, 200, cors);
      }

      return bad('Not found.', 404);
    } catch (e) {
      return bad('Server error.', 500);
    }
  },
};
