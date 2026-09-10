/* CleverPay business verification — Cloudflare Worker (cleverpay-verify)

   Brent, 10 Sep 2026: "on the accounts that have companies, to stop fraud and
   protect the business, we need to verify the owner of the business in
   accordance with Companies House, so .gov needs to be on the account alongside
   the HMRC checks. Allow Gemma to turn them off and on depending on the account
   type applying, in the Clever portal settings. Then we confirm the director as
   per the account direct on Companies House; if there is an issue with that,
   allow them to send an email."

   Gemma owns this. Everything it needs is hers: her Companies House key, her
   switches, her release decision at the end. It holds no policy of its own —
   it reads the switches out of the portal config she saves and does what they
   say.

   WHY A FOURTH WORKER rather than more lines in cleverpay-admin. A deploy
   travels through a pipe that caps the whole upload at 20,000 characters. The
   back office build is 19,686 of them and the front door 19,453 — between them
   about 400 characters of room, measured on a failed deploy, not guessed. A
   check that cannot be deployed verifies nobody, so this went into a script of
   its own with room to grow. It also means a mistake in here can never take
   the portal itself down: the worst it can do is fail to answer a check.

   WHERE THE KEY LIVES, and why not in the deploy script. Gemma's Companies
   House key is pasted into the portal by whoever owns it and held in one row
   only the service role can read. A key that can only be changed by a deploy
   is a key Gemma cannot rotate without me, and rotating it is exactly the
   thing she must be able to do alone. The portal never sends a key back to a
   browser — only the last four characters, so a reviewer can tell one key from
   another without being able to read either.

   It has NO public address. cleverpay-api reaches it over a private binding at
   /team/verify/* and hands it the database key on the request, exactly as it
   does the back office and Team & access, so the database key still lives in
   exactly one place and nothing is held at rest in here.

   THREE ANSWERS, NEVER ONE FLAG. Company, director and VAT fail for different
   reasons, and a reviewer needs to know which. Each is true, false, or
   unknown. A register that is down is unknown — never "not a real company". */

const SB = 'https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1';
const APPS = '/cleverpay_applications';
const SESS = '/cleverpay_team_sessions';
const USERS = '/cleverpay_team_users';
const KEYS = '/haf_service_keys';
const CFG = '/cleverpay_portal_config?id=eq.1&limit=1';
const CH = 'https://api.company-information.service.gov.uk';
const HMRC = 'https://api.service.hmrc.gov.uk/organisations/vat/check-vat-number/lookup/';
const CT = 'Content-Type';
const AJ = 'application/json';
const S = JSON.stringify;
const E = encodeURIComponent;
const nowIso = () => new Date().toISOString();

/* The account types that are businesses. A driver is a person: they hold no
   company ID and no company is ever looked up for them. */
const BUSINESS = ['business', 'fleet', 'freight'];

const OK_ORIGINS = ['https://clever.usehaf.co.uk', 'https://otisagent.github.io'];
function corsHeaders(req) {
  const o = req.headers.get('Origin') || '';
  const ok = OK_ORIGINS.includes(o) || o.endsWith('.workers.dev') || o.endsWith('.pages.dev');
  return {
    'Access-Control-Allow-Origin': ok ? o : OK_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': CT + ',Authorization',
    'Cache-Control': 'no-store',
  };
}
const J = (data, status, cors) => new Response(S(data), { status, headers: { [CT]: AJ, ...cors } });

async function sb(env, path, init = {}) {
  const r = await fetch(SB + path, {
    ...init,
    headers: {
      apikey: env.KEY,
      Authorization: 'Bearer ' + env.KEY,
      [CT]: AJ,
      ...(init.method === 'POST' || init.method === 'PATCH' ? { Prefer: 'return=representation' } : {}),
      ...init.headers,
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

/* ── who is asking ───────────────────────────────────────────────────────────
   The same session the rest of the portal uses. A login switched off mid
   session stops working on its next request, not at the end of the week its
   session had left to run. */
async function whoAmI(env, req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  const r = await sb(env, `${SESS}?token=eq.${E(m[1])}&limit=1`);
  const s = r.ok && r.body && r.body[0];
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const u = await sb(env, `${USERS}?username=eq.${E(s.username)}&limit=1`);
  const row = u.ok && u.body && u.body[0];
  if (!row || row.active === false) return null;
  return row;
}

/* ── the company number, as the register writes it ───────────────────────────
   Leading zeros are part of a company number: 6 is 00000006. A Scottish or
   Northern Irish number keeps its two letters and pads the digits. Anything
   that cannot be made into one of those two shapes is not a company number,
   and saying so is more useful than asking the register about it. */
function normaliseNumber(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!s) return '';
  if (/^\d+$/.test(s)) return s.length <= 8 ? s.padStart(8, '0') : '';
  const m = s.match(/^([A-Z]{2})(\d+)$/);
  if (m && m[2].length <= 6) return m[1] + m[2].padStart(6, '0');
  return s.length === 8 ? s : '';
}

/* ── name matching ──────────────────────────────────────────────────────────
   The register writes an officer as "TAYLOR, Brendan John" and the account
   says "brendan taylor". Compare the sets of words, not the strings, and
   require BOTH a surname and a forename to line up: matching on a surname
   alone would confirm a father as his son, and matching on any single word
   would confirm every John in the country. */
const words = (s) => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(w => w.length > 1);

function nameMatches(accountName, officerName) {
  const a = words(accountName);
  const o = words(officerName);
  if (a.length < 2 || o.length < 2) return false;
  const shared = o.filter(w => a.includes(w));
  /* The register puts the surname first, so o[0] is the family name. */
  return shared.includes(o[0]) && shared.length >= 2;
}

/* ── Companies House ────────────────────────────────────────────────────────
   The official API, not the public web page. The page gives a name and a
   status; only the API gives the officers, which is the whole point of
   confirming a director. Basic auth, key as the username, empty password. */
async function chGet(key, path) {
  let r;
  try {
    r = await fetch(CH + path, {
      headers: { Authorization: 'Basic ' + btoa(key + ':'), Accept: AJ },
    });
  } catch {
    return { state: 'unknown', reason: 'could not reach Companies House' };
  }
  if (r.status === 401 || r.status === 403) return { state: 'unknown', reason: 'Companies House refused the key — it may need renewing' };
  if (r.status === 404) return { state: 'absent', reason: 'no company on the register with that number' };
  if (r.status === 429) return { state: 'unknown', reason: 'Companies House is rate limiting us — try again shortly' };
  if (!r.ok) return { state: 'unknown', reason: 'Companies House answered ' + r.status };
  try { return { state: 'ok', body: await r.json() }; }
  catch { return { state: 'unknown', reason: 'Companies House sent something unreadable' }; }
}

/* Identity verification is the duty that began in November 2025, and the
   register does not answer it for every officer yet. Three answers, and
   "the register did not say" is one of them — recorded as unknown rather
   than guessed either way. */
function idVerified(officer) {
  const v = officer.identity_verification_status ?? officer.identity_verified ?? officer.is_identity_verified;
  if (v === true || v === 'verified') return true;
  if (v === false || v === 'unverified') return false;
  return null;
}

async function checkCompany(key, number) {
  const c = await chGet(key, '/company/' + number);
  if (c.state !== 'ok') return c;
  const b = c.body || {};
  return {
    state: 'ok',
    name: b.company_name || '',
    status: b.company_status || '',
    /* A dissolved or liquidated company is a real register entry and a real
       refusal. Verified must never mean "the register had heard of it". */
    trading: !/dissolved|liquidation|closed|converted/i.test(b.company_status || ''),
  };
}

async function checkDirector(key, number, personName) {
  const o = await chGet(key, '/company/' + number + '/officers?items_per_page=100');
  if (o.state !== 'ok') return o;
  const items = Array.isArray(o.body && o.body.items) ? o.body.items : [];
  /* Only officers who are still in post, and only directors: a company
      secretary is not the person who can bind the company. */
  const active = items.filter(i => !i.resigned_on && /director|member|partner/i.test(i.officer_role || ''));
  const hit = active.find(i => nameMatches(personName, i.name));
  if (!hit) {
    return {
      state: 'ok', matched: false, idVerified: null, matchedName: null,
      reason: active.length
        ? 'the person named on the account is not an active director of that company'
        : 'the register lists no active directors for that company',
      activeCount: active.length,
    };
  }
  return { state: 'ok', matched: true, matchedName: hit.name, idVerified: idVerified(hit), reason: '', activeCount: active.length };
}

/* ── HMRC ───────────────────────────────────────────────────────────────────
   The VAT lookup needs credentials of its own. HMRC's registration takes about
   a fortnight, so this is written to work the day the key lands and to say
   plainly that it cannot run until then. A check that silently reports nothing
   is worse than one that says why. */
async function checkVat(token, vrn) {
  const n = String(vrn || '').toUpperCase().replace(/[^0-9]/g, '');
  if (n.length !== 9) return { state: 'absent', reason: 'that is not a nine-digit UK VAT number' };
  if (!token) return { state: 'unknown', reason: 'HMRC credentials are not installed yet' };
  let r;
  try {
    r = await fetch(HMRC + n, { headers: { Accept: 'application/vnd.hmrc.2.0+json', Authorization: 'Bearer ' + token } });
  } catch {
    return { state: 'unknown', reason: 'could not reach HMRC' };
  }
  if (r.status === 404) return { state: 'absent', reason: 'HMRC does not hold that VAT number' };
  if (!r.ok) return { state: 'unknown', reason: 'HMRC answered ' + r.status };
  let b = {};
  try { b = await r.json(); } catch {}
  return { state: 'ok', name: (b.target && b.target.name) || '', address: (b.target && b.target.address) || null };
}

/* ── the switches ───────────────────────────────────────────────────────────
   Gemma's, read fresh on every run out of the config row the Settings tab
   saves. Absent config means the checks are off, not on: a check nobody has
   switched on must never start refusing accounts by itself. */
async function switchesFor(env, type) {
  const c = await sb(env, CFG);
  const cfg = (c.ok && c.body && c.body[0] && c.body[0].config) || {};
  const ch = cfg.checks || {};
  const on = (k) => !!(ch[k] && ch[k][type] === true);
  return { company: on('company'), director: on('director'), vat: on('vat'), cfg };
}

async function keyValue(env, name) {
  const r = await sb(env, `${KEYS}?name=eq.${E(name)}&limit=1`);
  return (r.ok && r.body && r.body[0] && r.body[0].value) || '';
}

/* Which required documents are still outstanding — the same list the portal
   shows and the release gate already works to, read from Gemma's settings
   rather than from a copy kept in here. */
function missingRequired(cfg, app) {
  const set = app.type === 'freight' ? cfg.freight : cfg.driver;
  const need = ((set && set.docs) || []).filter(d => d.status === 'required').map(d => d.id);
  const have = (Array.isArray(app.docs) ? app.docs : []).map(d => d.id);
  return need.filter(id => !have.includes(id));
}

/* ── the five rungs ─────────────────────────────────────────────────────────
   Each one unlocks exactly one thing, and a rung is only climbed on evidence
   that is written down. A check switched off is not a failed rung — it is not
   a rung at all, and it says so, because "not required" and "not done" look
   the same on a screen and mean opposite things. */
function rungs(app, sw, missing) {
  const r = [
    { key: 'account', name: 'Account open', done: true, note: app.company_id ? 'Company ID ' + app.company_id : '' },
    {
      key: 'company', name: 'Company confirmed on the register',
      done: app.company_verified === true,
      skipped: !sw.company,
      note: app.company_verified === true
        ? (app.company_registered_name || '') + (app.company_status ? ' — ' + app.company_status : '')
        : app.company_verified === false ? 'not confirmed' : 'not checked yet',
    },
    {
      key: 'director', name: 'Person confirmed as a director',
      done: app.director_verified === true,
      skipped: !sw.director,
      note: app.director_verified === true
        ? (app.director_matched_name || '') + (app.director_id_verified === true ? ' — identity verified with Companies House'
            : app.director_id_verified === false ? ' — has not yet verified their identity with Companies House' : '')
        : app.director_note || 'not checked yet',
    },
    {
      key: 'vat', name: 'VAT number confirmed with HMRC',
      done: app.vat_verified === true,
      skipped: !sw.vat,
      note: app.vat_verified === true ? (app.vat_registered_name || 'confirmed') : 'not checked yet',
    },
    { key: 'docs', name: 'Required documents in', done: missing.length === 0, note: missing.length ? missing.length + ' still outstanding' : 'all in' },
    { key: 'released', name: 'Released by the team', done: !!app.access_confirmed_at, note: app.access_confirmed_by || '' },
  ];
  return r;
}

export default {
  async fetch(req, envIn) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const M = req.method;

    /* The database key travels on the request and is used for that request
       only, so this worker holds nothing at rest. No key means the caller is
       not the front door, and the front door is the only caller there is. */
    const env = { ...envIn, KEY: req.headers.get('x-cp-key') || '' };
    if (!env.KEY) return J({ error: 'Not found.' }, 404, cors);

    /* Reached at /team/verify/* through the front door's private binding; the
       routes below are written as the worker's own, so the prefix comes off
       here in one place rather than being repeated on every line. */
    const p = url.pathname.replace(/\/+$/, '').replace(/^\/team\/verify/, '') || '/';
    let b = {};
    if (M !== 'GET') { try { b = await req.json(); } catch {} }

    if (p === '/health') return J({ ok: true, service: 'cleverpay-verify' }, 200, cors);

    const me = await whoAmI(env, req);
    if (!me) return J({ error: 'Please sign in again.' }, 401, cors);

    try {
      /* ── which keys are installed ──
         Never the key itself. The last four characters are enough to tell one
         key from another and useless to anyone who steals the answer. */
      if (p === '/keys' && M === 'GET') {
        const r = await sb(env, `${KEYS}?select=name,value,set_by,set_at`);
        const rows = (r.ok && Array.isArray(r.body) ? r.body : []);
        const seen = (n) => rows.find(k => k.name === n);
        const show = (n) => {
          const k = seen(n);
          return k ? { set: true, last4: String(k.value).slice(-4), setBy: k.set_by, setAt: k.set_at } : { set: false };
        };
        return J({ companies_house: show('companies_house'), hmrc_vat: show('hmrc_vat') }, 200, cors);
      }

      /* Installing or rotating a key is an admin act, and it is recorded with
         the name of whoever did it. */
      if (p === '/key' && M === 'POST') {
        if (me.role !== 'admin' && me.role !== 'compliance') return J({ error: 'Not found.' }, 404, cors);
        const name = String(b.name || '');
        if (!['companies_house', 'hmrc_vat'].includes(name)) return J({ error: 'Unknown key.' }, 400, cors);
        const value = String(b.value || '').trim();
        if (value.length < 12) return J({ error: 'That does not look like a key.' }, 400, cors);
        /* Proved before it is stored. A key that is saved and does not work is
           a check that reads as "the register is down" for as long as nobody
           looks — so it is used once, against a company that has existed since
           1856, before it is allowed anywhere near an account. */
        if (name === 'companies_house') {
          const t = await chGet(value, '/company/00000006');
          if (t.state !== 'ok') return J({ error: 'That key did not work: ' + (t.reason || 'unknown') }, 400, cors);
        }
        const r = await sb(env, KEYS + '?on_conflict=name', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: S({ name, value, hint: 'last4 ' + value.slice(-4), set_by: me.name + ' (' + me.username + ')', set_at: nowIso() }),
        });
        if (!r.ok) return J({ error: 'Could not save that key. Please try again.' }, 500, cors);
        return J({ ok: true, name, last4: value.slice(-4), tested: name === 'companies_house' }, 200, cors);
      }

      /* ── where one account stands ── */
      if (p === '/state' && M === 'GET') {
        const ref = url.searchParams.get('ref') || '';
        const a = await sb(env, `${APPS}?ref=eq.${E(ref)}&limit=1`);
        const app = a.ok && a.body && a.body[0];
        if (!app) return J({ error: 'No account with that reference.' }, 404, cors);
        const sw = await switchesFor(env, app.type);
        return J({
          ref: app.ref, type: app.type, companyId: app.company_id || null,
          company: app.company || null, number: app.crn || null, vat: app.vat || null,
          switches: { company: sw.company, director: sw.director, vat: sw.vat },
          rungs: rungs(app, sw, missingRequired(sw.cfg, app)),
        }, 200, cors);
      }

      /* ── run the checks ──
         Only what Gemma has switched on for this account type, and only for a
         business: a driver is a person and has no company to confirm. Every
         answer written with the time and the name of whoever ran it. */
      if (p === '/run' && M === 'POST') {
        const ref = String(b.ref || '');
        const a = await sb(env, `${APPS}?ref=eq.${E(ref)}&limit=1`);
        const app = a.ok && a.body && a.body[0];
        if (!app) return J({ error: 'No account with that reference.' }, 404, cors);
        if (!BUSINESS.includes(app.type)) return J({ error: 'That account is a person, not a business — there is no company to confirm.' }, 400, cors);

        const sw = await switchesFor(env, app.type);
        if (!sw.company && !sw.director && !sw.vat) {
          return J({ error: 'Every official check is switched off for ' + app.type + ' accounts. Turn one on in Settings first.' }, 400, cors);
        }
        const key = await keyValue(env, 'companies_house');
        if ((sw.company || sw.director) && !key) {
          return J({ error: 'The Companies House key has not been installed yet — Settings, Verification.' }, 400, cors);
        }

        const number = normaliseNumber(app.crn);
        const person = app.name || [app.fname, app.lname].filter(Boolean).join(' ');
        const patch = { verify_by: me.name + ' (' + me.username + ')' };
        const out = { ref, companyId: app.company_id, ran: [] };

        if (sw.company || sw.director) {
          if (!number) {
            /* The applicant typed nothing usable. That is a false, not an
               unknown: we know the account does not carry a company number. */
            patch.company_verified = false;
            patch.company_checked_at = nowIso();
            patch.company_status = null;
            patch.director_verified = false;
            patch.director_checked_at = nowIso();
            patch.director_note = 'no usable company number on the account' + (app.crn ? ' (they entered "' + app.crn + '")' : '');
            out.ran.push({ check: 'company', result: 'no', why: patch.director_note });
          } else {
            if (sw.company) {
              const c = await checkCompany(key, number);
              patch.company_checked_at = nowIso();
              if (c.state === 'ok') {
                patch.company_verified = c.trading;
                patch.company_registered_name = c.name;
                patch.company_status = c.status;
                out.ran.push({ check: 'company', result: c.trading ? 'yes' : 'no', why: c.trading ? c.name : c.name + ' is ' + c.status });
              } else if (c.state === 'absent') {
                patch.company_verified = false;
                out.ran.push({ check: 'company', result: 'no', why: c.reason });
              } else {
                /* Unknown, and unknown is written as unknown. */
                patch.company_verified = null;
                out.ran.push({ check: 'company', result: 'unknown', why: c.reason });
              }
            }
            if (sw.director) {
              const d = await checkDirector(key, number, person);
              patch.director_checked_at = nowIso();
              if (d.state === 'ok') {
                patch.director_verified = d.matched;
                patch.director_matched_name = d.matchedName;
                patch.director_id_verified = d.idVerified;
                patch.director_note = d.matched ? '' : d.reason;
                out.ran.push({
                  check: 'director', result: d.matched ? 'yes' : 'no',
                  why: d.matched ? 'matched ' + d.matchedName : d.reason,
                  identityVerified: d.idVerified,
                });
              } else {
                patch.director_verified = null;
                patch.director_note = d.reason;
                out.ran.push({ check: 'director', result: 'unknown', why: d.reason });
              }
            }
          }
        }

        if (sw.vat) {
          const v = await checkVat(await keyValue(env, 'hmrc_vat'), app.vat);
          patch.vat_checked_at = nowIso();
          if (v.state === 'ok') {
            patch.vat_verified = true;
            patch.vat_registered_name = v.name;
            out.ran.push({ check: 'vat', result: 'yes', why: v.name });
          } else if (v.state === 'absent') {
            patch.vat_verified = false;
            out.ran.push({ check: 'vat', result: 'no', why: v.reason });
          } else {
            patch.vat_verified = null;
            out.ran.push({ check: 'vat', result: 'unknown', why: v.reason });
          }
        }

        /* The company_check tag the account label already reads, kept in step
           so a verified business reads as verified everywhere and not only on
           this screen. */
        patch.company_check = patch.company_verified === true && (patch.director_verified === true || !sw.director)
          ? 'verified' : patch.company_verified === false ? 'failed' : 'unchecked';

        const w = await sb(env, `${APPS}?ref=eq.${E(ref)}`, { method: 'PATCH', body: S(patch) });
        if (!w.ok) return J({ error: 'The checks ran but the answer could not be saved. Please run it again.' }, 500, cors);
        const saved = (w.body && w.body[0]) || app;
        out.rungs = rungs(saved, sw, missingRequired(sw.cfg, saved));
        return J(out, 200, cors);
      }

      /* ── the way out ──
         A real director whose name the register does not match — a recent
         appointment, a married name, a company where the filing is behind — is
         not a fraud and must not be left at a dead end. This raises a ticket on
         the route every other HAF ticket already travels, so it lands with the
         team in Discord with its own reference, and the account is stamped with
         why it is waiting on a person. */
      if (p === '/raise' && M === 'POST') {
        const ref = String(b.ref || '');
        const note = String(b.note || '').slice(0, 900);
        const a = await sb(env, `${APPS}?ref=eq.${E(ref)}&limit=1`);
        const app = a.ok && a.body && a.body[0];
        if (!app) return J({ error: 'No account with that reference.' }, 404, cors);
        const subject = 'Verify my business - ' + ref;
        const body = [
          'Company ID: ' + (app.company_id || 'not issued'),
          'Business: ' + (app.company || 'not given'),
          'Company number on the account: ' + (app.crn || 'none'),
          'Named person: ' + (app.name || [app.fname, app.lname].filter(Boolean).join(' ') || 'not given'),
          'Why the register check did not confirm them: ' + (app.director_note || 'not recorded'),
          note ? 'Note from ' + me.name + ': ' + note : '',
        ].filter(Boolean).join('\n');
        const t = await sb(env, '/rpc/raise_ticket', {
          method: 'POST',
          body: S({ p_subject: subject, p_body: body, p_category: 'verification', p_user_id: null, p_username: app.email || ref, p_guild: null }),
        });
        if (!t.ok) return J({ error: 'Could not raise that ticket. Please try again.' }, 502, cors);
        const ticket = (t.body && (t.body.ref || t.body.ticket_ref || t.body)) || null;
        if (env.HOOK) {
          /* Best effort, and deliberately after the record: the ticket exists
             whether or not Discord takes the message, and reading the row back
             is what proves it — not this call's return code. */
          try {
            await fetch(env.HOOK, {
              method: 'POST', headers: { [CT]: AJ },
              body: S({ content: '**Business verification needs a person** — ' + subject + '\n' + body.slice(0, 1200) }),
            });
          } catch {}
        }
        await sb(env, `${APPS}?ref=eq.${E(ref)}`, {
          method: 'PATCH',
          body: S({ action_item: 'business verification', action_reason: subject, director_note: (app.director_note || '') + ' — raised with the team' }),
        });
        return J({ ok: true, subject, ticket }, 200, cors);
      }

      return J({ error: 'Unknown endpoint.' }, 404, cors);
    } catch (e) {
      return J({ error: String((e && e.message) || e) }, 500, cors);
    }
  },
};
