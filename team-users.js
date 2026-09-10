/* Team & access — the owner's screen for the portal's own people.

   Brent, 10 Sep: "can you make sure my account as toggles / switches aswell so
   i can manage the users in the portal". Until now every reviewer, every
   permission and every setup code came through me by hand, which made one
   person a single point of failure for who can see HAF's compliance records.

   Three switches per person, and each one is enforced in the worker as well as
   drawn here — a switch the browser alone respects is decoration:
     Access      can this login sign in at all
     Admin       can they manage people and the back-office link
     Can release can they press Confirm & release on an application

   The tab is drawn for an admin only. That is presentation; the server answers
   a plain 404 to everyone else either way. */

let USERS_DATA = null;

function canManageUsers() {
  return !!TEAM && String(TEAM.role || '').toLowerCase() === 'admin';
}

function showUsersTab() {
  const bar = document.querySelector('.tab-bar');
  const existing = document.getElementById('tab-users');
  if (!canManageUsers()) { existing?.remove(); return; }
  if (existing) return;
  const t = document.createElement('div');
  t.className = 'tab'; t.id = 'tab-users'; t.textContent = 'Team & access';
  t.onclick = () => setTab('users');
  bar.appendChild(t);
}

async function renderUsers() {
  const el = document.getElementById('main-content');
  if (!USERS_DATA) el.innerHTML = '<div class="empty">Loading the team…</div>';
  const r = await cpApi('/team/users', { token: TEAM.token });
  if (r.status === 401) { showToast('Session expired — please sign in again', true); doSignOut(); return; }
  if (!r.ok) { el.innerHTML = '<div class="empty">This area isn’t available on your login.</div>'; return; }
  USERS_DATA = r.body;
  drawUsers();
}

/* Brent's rule, 10 Sep: two initials, the last four digits of their own mobile,
   the last two of their year of birth. It is built here rather than typed so
   the shape cannot drift, and it stays editable because the back office also
   holds older logins that predate the rule. */
function usersSuggest() {
  const name = (document.getElementById('nu-name')?.value || '').trim();
  const mob = (document.getElementById('nu-mob')?.value || '').replace(/\D/g, '');
  const yr = (document.getElementById('nu-year')?.value || '').replace(/\D/g, '');
  const initials = name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const box = document.getElementById('nu-login');
  if (!box || box.dataset.touched === '1') return;
  if (initials.length === 2 && mob.length >= 4 && yr.length >= 2) {
    box.value = (initials + mob.slice(-4) + yr.slice(-2)).toLowerCase();
  }
}

function drawUsers() {
  const d = USERS_DATA || { users: [] };
  const list = d.users || [];
  const admins = list.filter(u => u.role === 'admin' && u.active).length;
  const meName = d.me?.username || '';

  const row = (u) => {
    const isMe = u.username === meName;
    const state = !u.active ? '<span class="us-pill us-off">Switched off</span>'
      : u.awaitingPin ? '<span class="us-pill us-wait">Waiting to choose a PIN</span>'
        : '<span class="us-pill us-on">Signed up</span>';
    const sw = (label, on, field, disabled, why) => `
      <label class="us-sw ${disabled ? 'us-dim' : ''}" ${why ? `title="${why}"` : ''}>
        <input type="checkbox" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}
          onchange="usersSet('${u.username}','${field}',this.checked,this)">
        <span>${label}</span>
      </label>`;
    /* Two things this screen will not let an admin do, because the database
       refuses them anyway and a switch that throws an error is a worse way to
       find out: turn your own login off, and step your own login down. */
    const lastAdmin = u.role === 'admin' && u.active && admins <= 1;
    return `
    <div class="us-row ${u.active ? '' : 'us-rowoff'}">
      <div class="us-who">
        <div class="us-name">${u.name}${isMe ? ' <span class="us-you">you</span>' : ''}</div>
        <div class="us-login">${u.username}</div>
        <div class="us-meta">${state}${u.createdBy ? ` · added by ${u.createdBy}` : ''}</div>
      </div>
      <div class="us-switches">
        ${sw('Access', u.active, 'active', isMe || lastAdmin,
      isMe ? 'You cannot switch off your own login' : 'This is the last admin login')}
        ${sw('Admin', u.role === 'admin', 'admin', isMe || lastAdmin,
        isMe ? 'You cannot step down your own login' : 'This is the last admin login')}
        ${sw('Can release', u.canRelease, 'canRelease', false, '')}
      </div>
      <div class="us-act">
        <button class="btn btn-gh" ${isMe || lastAdmin ? 'disabled' : ''}
          onclick="usersRemove('${u.username}','${u.name.replace(/'/g, '')}')">Remove</button>
      </div>
    </div>`;
  };

  document.getElementById('main-content').innerHTML = `
  <div class="ig-wrap">
    <div class="ig-card">
      <div class="ig-h">Who can get into this portal</div>
      <div class="ig-p">Three switches per person. <b>Access</b> is whether they can sign in at all.
        <b>Admin</b> lets them manage people and the back-office link. <b>Can release</b> lets them
        press Confirm &amp; release on an application, which is the press that opens the network to
        somebody. Every one of them is checked again by the server, so switching one off here really
        does close it.</div>
      <div class="us-list">${list.map(row).join('') || '<div class="empty">Nobody yet.</div>'}</div>
      <div class="ig-note">You never see or set anyone else's PIN. A new person gets a one-time code,
        signs in with it once, and chooses their own — so what they do in here is provably theirs.</div>
    </div>

    <div class="ig-card">
      <div class="ig-h">Add someone</div>
      <div class="ig-p">Their login is built from HAF's rule as you type: two initials, the last four
        digits of their mobile, the last two of their year of birth. You can change it if you need to.</div>
      <div class="us-form">
        <label>Full name<input id="nu-name" oninput="usersSuggest()" placeholder="Gemma Vale"></label>
        <label>Mobile<input id="nu-mob" oninput="usersSuggest()" inputmode="numeric" placeholder="07…"></label>
        <label>Year of birth<input id="nu-year" oninput="usersSuggest()" inputmode="numeric" maxlength="4" placeholder="1993"></label>
        <label>Login<input id="nu-login" oninput="this.dataset.touched='1'" placeholder="gv447193"></label>
        <label>Role<select id="nu-role"><option value="compliance">Compliance reviewer</option><option value="admin">Admin</option></select></label>
        <label class="us-sw"><input type="checkbox" id="nu-release"><span>Can press Confirm &amp; release</span></label>
      </div>
      <div class="ig-btns"><button class="btn btn-approve" onclick="usersAdd()">Add them</button></div>
    </div>
  </div>
  <style>
  .us-list{display:flex;flex-direction:column;gap:8px;margin-top:10px}
  .us-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--haf-line,#e3e6ea);border-radius:10px}
  .us-rowoff{opacity:.62}
  .us-who{flex:1 1 220px;min-width:200px}
  .us-name{font-weight:650}
  .us-you{font-weight:500;font-size:11px;padding:1px 6px;border-radius:20px;background:#eef2f7}
  .us-login{font-size:12px;opacity:.7}
  .us-meta{font-size:12px;margin-top:3px}
  .us-pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:20px;background:#eef2f7}
  .us-on{background:#e6f5ec}.us-off{background:#fdeaea}.us-wait{background:#fff4e2}
  .us-switches{display:flex;gap:16px;flex-wrap:wrap}
  .us-sw{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}
  .us-dim{opacity:.45;cursor:not-allowed}
  .us-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-top:10px}
  .us-form label{display:flex;flex-direction:column;gap:4px;font-size:12px}
  .us-form input,.us-form select{padding:9px 10px;border:1px solid var(--haf-line,#e3e6ea);border-radius:8px;font:inherit}
  </style>`;
}

async function usersSet(username, field, on, box) {
  const body = { username };
  if (field === 'admin') body.role = on ? 'admin' : 'compliance';
  else body[field] = on;
  const r = await cpApi('/team/users/access', { method: 'POST', token: TEAM.token, body });
  if (r.status === 401) { showToast('Session expired — please sign in again', true); doSignOut(); return; }
  if (!r.ok) {
    /* Put the switch back where it was. Leaving it showing the change the
       server just refused is how somebody comes away believing a door is shut
       when it is open. */
    if (box) box.checked = !on;
    showToast(r.body?.error || 'Could not save that change', true);
    return;
  }
  USERS_DATA = null;
  showToast('Saved');
  renderUsers();
}

async function usersAdd() {
  const name = document.getElementById('nu-name').value.trim();
  const username = document.getElementById('nu-login').value.trim().toLowerCase();
  const role = document.getElementById('nu-role').value;
  const canRelease = document.getElementById('nu-release').checked;
  if (name.length < 2) { showToast('Give them a name', true); return; }
  if (username.length < 3) { showToast('Give them a login', true); return; }
  const r = await cpApi('/team/users/add', { method: 'POST', token: TEAM.token, body: { name, username, role, canRelease } });
  if (r.status === 401) { showToast('Session expired — please sign in again', true); doSignOut(); return; }
  if (!r.ok) { showToast(r.body?.error || 'Could not add them', true); return; }
  usersShowCode(username, r.body.setupCode);
  USERS_DATA = null;
  renderUsers();
}

/* Shown once. There is no way to read it back, by design — if it is lost the
   person is removed and added again, which is a smaller problem than a code
   that can be looked up by anyone who reaches this screen. */
function usersShowCode(username, code) {
  alert('Added.\n\nGive ' + username + ' this one-time code:\n\n    ' + code
    + '\n\nThey sign in with it once and then choose their own PIN. This code is not shown again.');
}

async function usersRemove(username, name) {
  if (!confirm('Remove ' + name + '?\n\nTheir login stops working immediately and they are signed out of the portal.')) return;
  const r = await cpApi('/team/users/remove', { method: 'POST', token: TEAM.token, body: { username } });
  if (r.status === 401) { showToast('Session expired — please sign in again', true); doSignOut(); return; }
  if (!r.ok) { showToast(r.body?.error || 'Could not remove that login', true); return; }
  USERS_DATA = null;
  showToast(name + ' removed');
  renderUsers();
}
