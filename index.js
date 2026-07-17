let selectedType = null;
let knectOn = false;
let fleetOn = false;
let knectDriverOn = false;
let dFounderTier = null;
let fFounderTier = null;
let activeTierStage = 'founder'; // Tracks which tier stage is currently unlocked

const FOUNDER_CODES = { founder:'H6PRO', builder:'H3PRO', partner:'H1PRO', final:'HKPRO' };
const FOUNDER_MONTHS = { founder:6, builder:3, partner:1, final:0 };
const TIER_HIERARCHY = ['founder', 'builder', 'partner', 'final']; // Unlock order
const TIER_DATA = {
  founder: { name: 'Founders', price: '£100', plna: '6 months free PLNA Pro', freight: '3 months free Freight account' },
  builder: { name: 'Builder', price: '£250', plna: '3 months free PLNA Pro', freight: '1 month free Freight account' },
  partner: { name: 'Partner', price: '£500', plna: '1 month free PLNA Pro', freight: '1 month free Freight account' },
  final: { name: 'Final stage', price: '£1,000', plna: 'Standard access', freight: null }
};

// Fetch milestone state and render the active tier card
async function renderActiveTier(){
  try {
    const r = await fetch('https://jsdwvogsxlnczzbefwgp.supabase.co/rest/v1/tier_config?id=eq.1&select=active_stage', {
      headers: {
        'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzZHd2b2dzeGxuY3p6YmVmd2dwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODgyMzYsImV4cCI6MjA5Njk2NDIzNn0.pxqM-Oh4f_3PlqCbKIKvcKZnNRUZ1ASKqqdNg78M_4M'
      }
    });
    const data = await r.json();
    if (data && data[0]) {
      activeTierStage = data[0].active_stage || 'founder';
    }
  } catch (e) {
    console.warn('Tier config fetch failed; defaulting to founder', e);
  }

  // Render active tier card for desktop and mobile
  const tierData = TIER_DATA[activeTierStage];
  if (tierData) {
    const cardHtml = `
      <div class="ft-card" id="d-ft-${activeTierStage}" onclick="selectFounderTier('d','${activeTierStage}')">
        <div class="ft-stage">${tierData.name}</div>
        <div class="ft-price">${tierData.price}</div>
        <div class="ft-reward">${tierData.plna}</div>
        ${tierData.freight ? `<div class="ft-reward ft-reward-freight">+ ${tierData.freight}</div>` : ''}
      </div>
    `;
    const dCardContainer = document.getElementById('d-active-tier-card');
    if (dCardContainer) dCardContainer.innerHTML = cardHtml;

    const mCardHtml = cardHtml.replace(/id="d-ft-/g, 'id="f-ft-').replace(/onclick="selectFounderTier\('d'/g, "onclick=\"selectFounderTier('f'");
    const fCardContainer = document.getElementById('f-active-tier-card');
    if (fCardContainer) fCardContainer.innerHTML = mCardHtml;
  }
}

function genFoundersCode(tier){
  const prefix = FOUNDER_CODES[tier] || 'HKPRO';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(b => chars[b % chars.length]).join('');
  return prefix + '-' + rand;
}

function selectFounderTier(form, tier){
  const prev = form === 'd' ? dFounderTier : fFounderTier;
  const allTiers = ['free', activeTierStage];

  // toggle off if same tier tapped again
  if(prev === tier){
    if(form === 'd') dFounderTier = null; else fFounderTier = null;
    allTiers.forEach(t => document.getElementById(form + '-ft-' + t)?.classList.remove('selected'));
    document.getElementById(form + '-code-preview').classList.remove('show');
    return;
  }

  if(form === 'd') dFounderTier = tier; else fFounderTier = tier;
  allTiers.forEach(t => {
    const card = document.getElementById(form + '-ft-' + t);
    if(card) card.classList.toggle('selected', t === tier);
  });

  // If free was selected, clear code
  if(tier === 'free'){
    document.getElementById(form + '-code-preview').classList.remove('show');
    sessionStorage.removeItem(form + '_founders_code');
    sessionStorage.removeItem(form + '_founders_tier');
  } else {
    const code = genFoundersCode(tier);
    document.getElementById(form + '-code-val').textContent = code;
    document.getElementById(form + '-code-preview').classList.add('show');
    // Store in sessionStorage so submit can read it
    sessionStorage.setItem(form + '_founders_code', code);
    sessionStorage.setItem(form + '_founders_tier', tier);
  }
}

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
  const info = document.getElementById('rebate-info');
  tog.classList.toggle('on', knectOn);
  const cfg = JSON.parse(localStorage.getItem('cp_config')||'null');
  const rStd = cfg?.rebate?.standard ? cfg.rebate.standard + '% per job' : 'Confirmed after signup';
  const rKnect = cfg?.rebate?.knect ? cfg.rebate.knect + '% per job' : 'Higher rate — TBC';
  document.getElementById('ri-standard').textContent = rStd;
  document.getElementById('ri-knect').textContent = rKnect;
  sub.textContent = knectOn
    ? 'KNECT member rate applied — you earn a higher rebate on every job.'
    : 'Tap to confirm — earns you a higher rebate rate on every job.';
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

  const foundersTier = dFounderTier || sessionStorage.getItem('d_founders_tier') || null;
  const foundersCode = foundersTier ? (sessionStorage.getItem('d_founders_code') || genFoundersCode(foundersTier)) : null;

  const r = await cpApi('/apply', { method: 'POST', body: {
    type: 'driver', username, pinHash,
    fname: fn, lname: ln, email, phone, dob, vtype, vreg,
    fleet: fleetOn, fleetSize: fleetOn ? fleetSize : null,
    knect: knectDriverOn,
    founders_tier: foundersTier,
    promo_code: foundersCode
  }});
  if(!r.ok){ alert(r.body?.error || 'Something went wrong — please try again.'); return; }

  sessionStorage.removeItem('d_founders_code'); sessionStorage.removeItem('d_founders_tier');
  localStorage.setItem('cp_application', JSON.stringify({...r.body, pinHash, founders_tier: foundersTier, promo_code: foundersCode}));
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

  const foundersTier = fFounderTier || sessionStorage.getItem('f_founders_tier') || null;
  const foundersCode = foundersTier ? (sessionStorage.getItem('f_founders_code') || genFoundersCode(foundersTier)) : null;

  const r = await cpApi('/apply', { method: 'POST', body: {
    type: 'freight', username, pinHash,
    company, crn, vat, name, title, email, phone,
    knect: knectOn,
    founders_tier: foundersTier,
    promo_code: foundersCode
  }});
  if(!r.ok){ alert(r.body?.error || 'Something went wrong — please try again.'); return; }

  sessionStorage.removeItem('f_founders_code'); sessionStorage.removeItem('f_founders_tier');
  localStorage.setItem('cp_application', JSON.stringify({...r.body, pinHash, founders_tier: foundersTier, promo_code: foundersCode}));
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
    if(r.status === 404) showLoginErr('No application found with that username or reference — check it, or sign up below.');
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

// Render two-tile choice on page load
renderActiveTier();
