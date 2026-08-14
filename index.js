let selectedType = null;
let knectOn = false;
let fleetOn = false;
let knectDriverOn = false;

function toggleTheme(){
  const h = document.documentElement;
  h.dataset.theme = h.dataset.theme === 'dark' ? 'light' : 'dark';
}

const TYPE_VIEWS = { driver:'view-driver', fleet:'view-driver', freight:'view-freight', business:'view-business' };
const ALL_CARDS = ['driver','fleet','freight','business'];

function selectType(type){
  selectedType = type;
  ALL_CARDS.forEach(t => {
    const card = document.getElementById('card-' + t);
    if (card) card.classList.toggle('selected', type === t);
  });
  setTimeout(() => {
    document.getElementById('view-type').style.display = 'none';
    document.getElementById(TYPE_VIEWS[type]).classList.add('visible');
    // Fleet / courier company route: same verified driver application,
    // with the fleet section switched on and required from the start.
    const kicker = document.querySelector('#view-driver .page-kicker');
    if (type === 'fleet') {
      if (kicker) kicker.textContent = 'Fleet / Courier Company Account';
      if (!fleetOn) toggleFleet();
    } else if (type === 'driver') {
      if (kicker) kicker.textContent = 'Owner Driver Account';
      if (fleetOn) toggleFleet();
    }
    window.scrollTo({top:0, behavior:'smooth'});
  }, 120);
}

/* Someone arriving from join.usehaf.co.uk has already said who they are and
   which plan they want. Asking again is asking twice, and a courier who picked
   Fleet Pro on the join page must not land on a form that says nothing about it.
   So: open their form straight away, and say their plan back to them.
   The plan itself is held on the join record against their email — stamping it
   onto this application needs a field the worker has no room for yet. */
const JOIN = (function () {
  const q = new URLSearchParams(location.search);
  const type = (q.get('type') || '').replace(/[^a-z]/g, '');
  const id = (q.get('join') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  const name = (q.get('pn') || '').replace(/[^\w £×.,&+-]/g, '').slice(0, 60);
  /* Their HAF username, if Join HAF already opened their account. */
  const user = (q.get('u') || '').replace(/[^a-z0-9]/gi, '').slice(0, 24).toUpperCase();
  return id && ALL_CARDS.includes(type) ? { id, type, name, user } : null;
})();

/* ── ADDING DRIVING TO AN ACCOUNT THAT ALREADY EXISTS ──────────────────────
   Brent, 14 Aug: a business or freight forwarder who wants to drive as well
   "should go through the clever.usehaf.co.uk system". The sidebar in KNECT now
   sends them here with ?add=driver (or ?add=fleet) and their HAF username.

   These people are NOT new applicants. They already hold a HAF account, a
   username and a PIN. Dropping them on the sign-up form would ask them to
   invent a second username and then reject them as a duplicate — turning
   somebody away at a door they were invited through. So they get the sign-in
   box with their username already filled in, and a line telling them what is
   about to be asked of them. */
const ADD = (function () {
  const q = new URLSearchParams(location.search);
  const type = (q.get('add') || '').replace(/[^a-z]/g, '');
  const user = (q.get('u') || '').replace(/[^a-z0-9]/gi, '').slice(0, 24).toUpperCase();
  return ALL_CARDS.includes(type) ? { type, user } : null;
})();

function applyAddChoice(){
  if (!ADD) return false;
  const what = ADD.type === 'fleet' ? 'a fleet' : 'owner driver';
  const note = document.getElementById('join-carry');
  if (note) {
    note.textContent = ADD.user
      ? 'Adding ' + what + ' to your HAF account — you are ' + ADD.user
        + '. Sign in with your PIN and we will ask for the documents we need before you can take work.'
      : 'Adding ' + what + ' to your HAF account. Sign in with your HAF username and PIN, and we will ask for the documents we need before you can take work.';
    note.style.display = '';
  }
  const idBox = document.getElementById('login-id');
  const pinBox = document.getElementById('login-pin');
  if (idBox && ADD.user) idBox.value = ADD.user;
  if (pinBox) pinBox.focus();
  return true;
}

function applyJoinChoice(){
  /* Somebody adding driving to an account they already hold comes first: they
     have a username, so there is nothing here for them to fill in. */
  if (applyAddChoice()) return;
  if (!JOIN) return;
  const note = document.getElementById('join-carry');
  /* Two different people arrive here holding a join id, and they need opposite
     things.

     WITH a username, Join HAF has already opened their HAF account — name, PIN
     and all. The only thing left for them is their documents. Sending them into
     the sign-up form would ask them to choose a username that already exists,
     and the moment they pressed the button they would be turned away as a
     duplicate: a front door that stops the very people who came through it.
     So they get the sign-in box, with their username already in it. The PIN
     they chose on Join HAF is still the key and only they have it.

     WITHOUT one, they came through the older join page, which records the
     membership but makes no login at all — so the sign-up form is genuinely
     their next step, and it stays exactly as it was. */
  if (JOIN.user) {
    if (note) {
      note.textContent = 'Your HAF account is open — you are ' + JOIN.user
        + '. Sign in with the PIN you chose on Join HAF and we will show you the documents we need.';
      note.style.display = '';
    }
    const idBox = document.getElementById('login-id');
    const pinBox = document.getElementById('login-pin');
    if (idBox) idBox.value = JOIN.user;
    if (pinBox) pinBox.focus();
    return;
  }
  if (note) {
    note.textContent = JOIN.name
      ? 'Carried over from Join HAF — you chose ' + JOIN.name + ', so we have not asked again. Just finish your details below.'
      : 'Carried over from Join HAF — we already have your plan, so just finish your details below.';
    note.style.display = '';
  }
  selectType(JOIN.type);
}
document.addEventListener('DOMContentLoaded', applyJoinChoice);

function backToType(){
  document.querySelectorAll('.form-section').forEach(s => s.classList.remove('visible'));
  document.getElementById('view-type').style.display = '';
  ALL_CARDS.forEach(t => {
    const card = document.getElementById('card-' + t);
    if (card) card.classList.remove('selected');
  });
  window.scrollTo({top:0, behavior:'smooth'});
}

/* Business account enquiry — no login created; the HAF team follows up.
   Writes through a database policy that ONLY allows business enquiries in
   (insert-only, public key) — enquiries appear in the team portal list. */
const ENQ_URL = 'https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1/cleverpay_applications';
const ENQ_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzZHd2b2dzeGxuY3p6YmVmd2dwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODgyMzYsImV4cCI6MjA5Njk2NDIzNn0.pxqM-Oh4f_3PlqCbKIKvcKZnNRUZ1ASKqqdNg78M_4M';

async function submitEnquiry(){
  const company = document.getElementById('b-company').value.trim();
  const name    = document.getElementById('b-name').value.trim();
  const phone   = document.getElementById('b-phone').value.trim();
  const email   = document.getElementById('b-email').value.trim();
  const notes   = document.getElementById('b-notes').value.trim();
  const err     = document.getElementById('biz-err');
  err.style.display = 'none';
  if (!company || !name || !phone || !email) {
    err.textContent = 'Please fill in company, your name, mobile and email.';
    err.style.display = ''; return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    err.textContent = 'That email address doesn’t look right.';
    err.style.display = ''; return;
  }
  const ref = 'HAF-CP-' + [...crypto.getRandomValues(new Uint8Array(4))].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  const btn = document.getElementById('biz-send');
  btn.disabled = true; btn.textContent = 'Sending…';
  let ok = false;
  try {
    const res = await fetch(ENQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ENQ_KEY, Authorization: 'Bearer ' + ENQ_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify({ type:'business', status:'enquiry', ref, docs:[],
        company: company.slice(0,120), name: name.slice(0,120), email: email.slice(0,160),
        phone: phone.slice(0,40), notes: notes.slice(0,1500) }),
    });
    ok = res.ok;
  } catch (e) {}
  btn.disabled = false; btn.textContent = 'Send to the HAF team →';
  if (!ok) {
    err.textContent = 'Could not send just now — please check your connection and try again.';
    err.style.display = ''; return;
  }
  document.getElementById('biz-ref').textContent = ref;
  document.getElementById('biz-form').style.display = 'none';
  document.getElementById('biz-done').style.display = '';
}

function toggleKnect(){
  knectOn = !knectOn;
  const tog = document.getElementById('knect-toggle');
  const sub = document.getElementById('knect-sub');
  const info = document.getElementById('pool-info');
  tog.classList.toggle('on', knectOn);
  const cfg = JSON.parse(localStorage.getItem('cp_config')||'null');
  const rStd = cfg?.rebate?.standard ? cfg.rebate.standard + '% per job' : 'Confirmed after signup';
  const rKnect = cfg?.rebate?.knect ? cfg.rebate.knect + '% per job' : 'Higher share — TBC';
  document.getElementById('ri-standard').textContent = rStd;
  document.getElementById('ri-knect').textContent = rKnect;
  sub.textContent = knectOn
    ? 'KNECT member share applied — a higher share of profit pooling in the network.'
    : 'Tap to confirm — you get a higher share of profit pooling in the network.';
  sub.classList.toggle('highlight', knectOn);
  info.classList.toggle('show', knectOn);
}

function toggleFleet(){
  fleetOn = !fleetOn;
  document.getElementById('fleet-toggle').classList.toggle('on', fleetOn);
  document.getElementById('fleet-size-wrap').style.display = fleetOn ? '' : 'none';
  const sub = document.getElementById('fleet-sub');
  sub.textContent = fleetOn
    ? 'Fleet noted — tell us how many drivers you currently have below.'
    : 'Tap if you run more than one driver — we\'ll set your fleet up properly.';
  sub.classList.toggle('highlight', fleetOn);
}

function toggleKnectDriver(){
  knectDriverOn = !knectDriverOn;
  document.getElementById('d-knect-toggle').classList.toggle('on', knectDriverOn);
  const sub = document.getElementById('d-knect-sub');
  sub.textContent = knectDriverOn
    ? 'KNECT membership noted — we\'ll link it to your driver account.'
    : 'Tap to confirm — members get priority access to work on the network. You can also join after you\'re approved.';
  sub.classList.toggle('highlight', knectDriverOn);
}

/* Generate HAF username: 2 initials + last 4 digits of phone + last 2 of birth year */
function genDriverUsername(fname, lname, phone, dob){
  const i1 = (fname[0] || '').toUpperCase();
  const i2 = (lname[0] || '').toUpperCase();
  const ph = phone.replace(/\D/g,'').slice(-4);
  const yr = (dob || '').split('-')[0]?.slice(-2) || '00';
  return i1 + i2 + ph + yr;
}

/* Business username: abbreviated name + last 4 of phone */
function genFreightUsername(company, phone){
  const words = company.trim().split(/\s+/);
  const abbr = words.length === 1
    ? company.replace(/\s+/g,'').substring(0,4).toUpperCase()
    : words.filter(w => !['ltd','limited','uk','plc','llp'].includes(w.toLowerCase()))
             .map(w => w[0]).join('').substring(0,4).toUpperCase();
  const ph = phone.replace(/\D/g,'').slice(-4);
  return abbr + ph;
}

/* Live username preview for driver form */
['d-fname','d-lname','d-phone','d-dob'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const fn = document.getElementById('d-fname').value;
    const ln = document.getElementById('d-lname').value;
    const ph = document.getElementById('d-phone').value;
    const dob = document.getElementById('d-dob').value;
    if(fn && ln && ph.replace(/\D/g,'').length >= 4 && dob){
      const u = genDriverUsername(fn, ln, ph, dob);
      document.getElementById('d-uname-val').textContent = u;
      document.getElementById('d-uname-preview').classList.add('show');
    } else {
      document.getElementById('d-uname-preview').classList.remove('show');
    }
  });
});

/* Live username preview for freight form */
['f-company','f-phone'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const co = document.getElementById('f-company').value;
    const ph = document.getElementById('f-phone').value;
    if(co && ph.replace(/\D/g,'').length >= 4){
      const u = genFreightUsername(co, ph);
      document.getElementById('f-uname-val').textContent = u;
      document.getElementById('f-uname-preview').classList.add('show');
    } else {
      document.getElementById('f-uname-preview').classList.remove('show');
    }
  });
});

/* PIN is stored only as a salted SHA-256 hash — never in plain text (see api.js) */
const hashPin = cpHashPin;

function validPin(pin, pin2){
  if(!/^\d{4,6}$/.test(pin)){
    alert('Your PIN must be 4 to 6 digits (numbers only).');
    return false;
  }
  if(pin !== pin2){
    alert('The two PINs do not match — please re-enter them.');
    return false;
  }
  return true;
}

async function submitDriver(e){
  e.preventDefault();
  const fn = document.getElementById('d-fname').value.trim();
  const ln = document.getElementById('d-lname').value.trim();
  const email = document.getElementById('d-email').value.trim();
  const phone = document.getElementById('d-phone').value.trim();
  const dob = document.getElementById('d-dob').value;
  const vtype = document.getElementById('d-vtype').value;
  const vreg = document.getElementById('d-vreg').value.trim().toUpperCase();

  const pin = document.getElementById('d-pin').value.trim();
  const pin2 = document.getElementById('d-pin2').value.trim();

  if(!fn||!ln||!email||!phone||!dob||!vtype||!vreg||!pin||!pin2){
    alert('Please fill in all required fields.');
    return;
  }
  const fleetSize = document.getElementById('d-fleet-size').value;
  if(fleetOn && !fleetSize){
    alert('Please tell us how many drivers you currently have.');
    return;
  }
  if(!validPin(pin, pin2)) return;

  const username = genDriverUsername(fn, ln, phone, dob);
  const pinHash = await hashPin(username, pin);

  const r = await cpApi('/apply', { method: 'POST', body: {
    type: 'driver', username, pinHash,
    fname: fn, lname: ln, email, phone, dob, vtype, vreg,
    fleet: fleetOn, fleetSize: fleetOn ? fleetSize : null,
    knect: knectDriverOn
  }});
  if(!r.ok){ alert(r.body?.error || 'Something went wrong — please try again.'); return; }

  localStorage.setItem('cp_application', JSON.stringify({...r.body, pinHash}));
  window.location.href = 'docs.html';
}

async function submitFreight(e){
  e.preventDefault();
  const company = document.getElementById('f-company').value.trim();
  const crn = document.getElementById('f-crn').value.trim();
  const vat = document.getElementById('f-vat').value.trim();
  const name = document.getElementById('f-name').value.trim();
  const title = document.getElementById('f-title').value.trim();
  const email = document.getElementById('f-email').value.trim();
  const phone = document.getElementById('f-phone').value.trim();

  const pin = document.getElementById('f-pin').value.trim();
  const pin2 = document.getElementById('f-pin2').value.trim();

  if(!company||!crn||!name||!email||!phone||!pin||!pin2){
    alert('Please fill in all required fields.');
    return;
  }
  if(!validPin(pin, pin2)) return;

  const username = genFreightUsername(company, phone);
  const pinHash = await hashPin(username, pin);

  const r = await cpApi('/apply', { method: 'POST', body: {
    type: 'freight', username, pinHash,
    company, crn, vat, name, title, email, phone,
    knect: knectOn
  }});
  if(!r.ok){ alert(r.body?.error || 'Something went wrong — please try again.'); return; }

  localStorage.setItem('cp_application', JSON.stringify({...r.body, pinHash}));
  window.location.href = 'docs.html';
}

/* ── LOG IN: find an existing application by HAF username or reference, then check the PIN ── */
function showLoginErr(msg){
  const err = document.getElementById('login-err');
  err.textContent = msg;
  err.classList.add('show');
}

async function doLogin(){
  const raw = document.getElementById('login-id').value.trim().toUpperCase();
  const pin = document.getElementById('login-pin').value.trim();
  document.getElementById('login-err').classList.remove('show');
  if(!raw) return;
  const r = await cpApi('/login', { method: 'POST', body: { id: raw, pin } });
  if(!r.ok){
    if(r.status === 404) showLoginErr('No application found with that username or reference — check it, or open a HAF account at join.usehaf.co.uk.');
    else if(r.status === 401) showLoginErr(pin ? 'Incorrect PIN — check it and try again.' : 'Enter your security PIN to log in.');
    else showLoginErr(r.body?.error || 'Could not log in — please try again.');
    return;
  }
  const app = r.body;
  /* keep the PIN hash locally so the docs/status pages can authenticate */
  app.pinHash = app.username && pin ? await hashPin(app.username, pin) : null;
  localStorage.setItem('cp_application', JSON.stringify(app));
  if(!app.docs || !app.docs.length) window.location.href = 'docs.html';
  else window.location.href = 'status.html';
}
['login-id','login-pin'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    document.getElementById('login-err').classList.remove('show');
  });
});
