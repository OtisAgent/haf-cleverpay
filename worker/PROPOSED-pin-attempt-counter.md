# PROPOSED — attempt counter on the applicant door. NOT APPLIED, NOT DEPLOYED.

v2, 2026-08-14, after Warren's review. Kept out of `cleverpay-api.js` so nobody
deploying from this tree ships an unreviewed change to a live door.

## What it fixes

`/login` and `/docs` both accept a browser-computed SHA-256 as a bearer
credential and compare it straight against the stored hash, with nothing counting
the misses. A 4-digit PIN under a published formula is 10,000 candidates on a
laptop, and a correct guess returns the applicant's record **and their documents**
— licence, insurance, ID.

Twin of `plna_cred_kind`, which got this counter on 13 Aug. We hardened one door
and left the other; on 14 Aug at 11:39 the other became the one real people use.

**It does NOT** re-enrol anyone, change how signing in works, or touch a correct
first-try PIN. The real fix — PIN to the server, slow hash with a pepper,
short-lived token — is Brent's and is unaffected.

## What Warren's review changed

**1. The fail-open question is dissolved, not answered.** There is one Supabase
(`jsdwvogsxlnczzbefwgp`), and `findApp` — which fetches the record holding
`pin_hash` — goes through the same `sb()` helper as the counter. If it is
unreachable, `findApp` returns null, `/login` 404s and `/docs` refuses: **nobody
can sign in at all, so there is nothing to brute-force.** The unmetered window
cannot occur. His question removed the decision instead of settling it.

The narrow case survives — readable but the counter write fails — and his
condition is now code: **it must never fail open quietly.**

**2. The lock is no longer a weapon.** Keyed on reference alone, anyone knowing a
driver's username could fail 8 times and lock that driver out of their own diary
with no credential at all. It is now keyed on **reference + source**: a stranger
locks only themselves, and the real driver on any other connection is unaffected.
A second row per source across all references is what stops a sweep.

**Named residual:** this does not stop an attacker holding many addresses — a full
4-digit sweep needs on the order of a thousand. A large step up from unlimited; not
a wall. The wall is the migration.

## 1. Migration (HUB / CleverPay `jsdwvogsxlnczzbefwgp`) — NOT APPLIED

```sql
create table if not exists public.cleverpay_auth_attempt (
  k            text        primary key,   -- 'REF|source' or '*|source'
  fails        integer     not null default 0,
  first_fail   timestamptz,
  last_fail    timestamptz,
  locked_until timestamptz
);
revoke all on public.cleverpay_auth_attempt from public, anon, authenticated;
grant select, insert, update on public.cleverpay_auth_attempt to service_role;
-- and then, because the grant above is a hope rather than a fact until you check:
revoke delete, truncate on public.cleverpay_auth_attempt from service_role;
```

That last line is not tidiness. On `haf_watch_heartbeat` today, Supabase's default
privileges had already handed `service_role` ALL — including TRUNCATE — before my
grant ran, and RLS does not filter TRUNCATE. **Read the catalogue after applying
this, do not trust the script.**

## 2. Worker patch — one helper, both call sites

```js
/* Too many wrong PINs and this door stops answering. Keyed on reference + SOURCE so a
   stranger cannot lock a real driver out of their own diary; a second row per source
   catches someone sweeping across references. A locked key is refused WITHOUT
   comparing, so a lockout leaks nothing about whether the guess was right. */
const LOCK_AFTER  = 8;    // one reference from one source
const SWEEP_AFTER = 20;   // one source across all references
const LOCK_MINS   = 15;

async function bump(env, k, ceiling) {
  const q = '/cleverpay_auth_attempt?k=eq.' + encodeURIComponent(k);
  const got = await sb(env, q);
  if (!got.ok) return { locked: false, blind: true };   // could not read: say so, never silently
  const row = (got.body && got.body[0]) || null;
  if (row && row.locked_until && new Date(row.locked_until) > new Date())
    return { locked: true, row, q };
  return { locked: false, row, q };
}

async function pinOk(env, app, supplied, src) {
  if (!app || !app.pin_hash) return !!app;              // no PIN set: unchanged behaviour
  src = src || '?';
  const mine  = await bump(env, app.ref + '|' + src, LOCK_AFTER);
  const sweep = await bump(env, '*|' + src, SWEEP_AFTER);
  if (mine.locked || sweep.locked) return false;        // refuse without comparing

  if (supplied === app.pin_hash) {
    if (mine.row && mine.row.fails)
      await sb(env, mine.q, { method: 'PATCH',
        body: JSON.stringify({ fails: 0, locked_until: null }) });
    return true;
  }

  for (const [st, k, ceiling] of [[mine, app.ref + '|' + src, LOCK_AFTER],
                                  [sweep, '*|' + src, SWEEP_AFTER]]) {
    const fails = ((st.row && st.row.fails) || 0) + 1;
    const w = await sb(env, '/cleverpay_auth_attempt', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ k, fails, last_fail: nowIso(),
        first_fail: (st.row && st.row.first_fail) || nowIso(),
        locked_until: fails >= ceiling
          ? new Date(Date.now() + LOCK_MINS * 60000).toISOString() : null }) });
    /* Warren's condition: an unmetered window nobody knows about is the silent green
       we spent two days deleting. If the miss cannot be recorded, say it out loud. */
    if (!w.ok || st.blind)
      console.log('AUTH COUNTER BLIND — a failed PIN attempt on ' + k +
                  ' could not be recorded. Guessing is unmetered while this lasts.');
  }
  return false;
}
```

Both call sites — `req` is in scope at the handler (`async fetch(req, env, ctx)`):

```js
const src = req.headers.get('CF-Connecting-IP') || '?';

// /login
const attempt = b.pinHash || await sha256('HAF-CP|' + app.username + '|' + (b.pin || ''));
if (!await pinOk(env, app, attempt, src)) return bad('Incorrect PIN.', 401);

// /docs — the SAME helper, on purpose. A counter on one door and not the other
// is the twin-door mistake one week later.
if (!app || !await pinOk(env, app, b.pinHash, src)) return bad(NOAUTH, 401);
```

## 3. Still open, and deliberately not in this diff

`bad('Incorrect PIN.')` vs `bad(NOAUTH)` still tells an attacker which references
exist — and Warren is right that it **compounds** with the counter rather than
sitting beside it: once attempts are scarce, knowing which references are real is
what makes the remaining ones worth spending. **Next diff, not someday.**

## 4. Before it ships

- Re-measure after `build.sh`. The cap is on the built artifact (~16.9KB of
  20,000), not the source. **Measure, do not estimate.**
- Read the catalogue after the migration, per the note above.
- Brent's go. He has it as: reversible, invisible unless you are guessing, and it
  does not touch the decision he still owes.
