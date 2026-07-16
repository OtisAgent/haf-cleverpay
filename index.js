let selectedType = null;
let knectOn = false;
let fleetOn = false;
let knectDriverOn = false;

function toggleTheme(){
  const h = document.documentElement;
  h.dataset.theme = h.dataset.theme === 'dark' ? 'light' : 'dark';
}

const TYPE_VIEWS = { driver:'view-driver', freight:'view-freight', business:'view-business' };

function selectType(type){
  selectedType = type;
  ['driver','freight','business'].forEach(t => {
    const card = document.getElementById('card-' + t);
    if (card) card.classList.toggle('selected', type === t);
  });
  setTimeout(() => {
    document.getElementById('view-type').style.display = 'none';
    document.getElementById(TYPE_VIEWS[type]).classList.add('visible');
    window.scrollTo({top:0, behavior:'smooth'});
  }, 120);
}

function backToType(){
  document.querySelectorAll('.form-section').forEach(s => s.classList.remove('visible'));
  document.getElementById('view-type').style.display = '';
  ['driver','freight','business'].forEach(t => {
    const card = document.getElementById('card-' + t);
    if (card) card.classList.remove('selected');
  });
  window.scrollTo({top:0, behavior:'smooth'});
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
