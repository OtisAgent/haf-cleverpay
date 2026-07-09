let selectedType = null;
let knectOn = false;

function toggleTheme(){
  const h = document.documentElement;
  h.dataset.theme = h.dataset.theme === 'dark' ? 'light' : 'dark';
}

function selectType(type){
  selectedType = type;
  document.getElementById('card-driver').classList.toggle('selected', type === 'driver');
  document.getElementById('card-freight').classList.toggle('selected', type === 'freight');
  setTimeout(() => {
    document.getElementById('view-type').style.display = 'none';
    document.getElementById(type === 'driver' ? 'view-driver' : 'view-freight').classList.add('visible');
    window.scrollTo({top:0, behavior:'smooth'});
  }, 120);
}

function backToType(){
  document.querySelectorAll('.form-section').forEach(s => s.classList.remove('visible'));
  document.getElementById('view-type').style.display = '';
  document.getElementById('card-driver').classList.remove('selected');
  document.getElementById('card-freight').classList.remove('selected');
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

function submitDriver(e){
  e.preventDefault();
  const fn = document.getElementById('d-fname').value.trim();
  const ln = document.getElementById('d-lname').value.trim();
  const email = document.getElementById('d-email').value.trim();
  const phone = document.getElementById('d-phone').value.trim();
  const dob = document.getElementById('d-dob').value;
  const vtype = document.getElementById('d-vtype').value;
  const vreg = document.getElementById('d-vreg').value.trim().toUpperCase();

  if(!fn||!ln||!email||!phone||!dob||!vtype||!vreg){
    alert('Please fill in all required fields.');
    return;
  }

  const username = genDriverUsername(fn, ln, phone, dob);
  const ref = 'HAF-CP-' + Math.random().toString(36).substring(2,6).toUpperCase();

  const data = {
    type: 'driver', ref, username,
    fname: fn, lname: ln, email, phone, dob,
    vtype, vreg,
    submitted: new Date().toISOString(),
    status: 'pending'
  };

  localStorage.setItem('cp_application', JSON.stringify(data));
  window.location.href = 'docs.html';
}

function submitFreight(e){
  e.preventDefault();
  const company = document.getElementById('f-company').value.trim();
  const crn = document.getElementById('f-crn').value.trim();
  const vat = document.getElementById('f-vat').value.trim();
  const name = document.getElementById('f-name').value.trim();
  const title = document.getElementById('f-title').value.trim();
  const email = document.getElementById('f-email').value.trim();
  const phone = document.getElementById('f-phone').value.trim();

  if(!company||!crn||!name||!email||!phone){
    alert('Please fill in all required fields.');
    return;
  }

  const username = genFreightUsername(company, phone);
  const ref = 'HAF-CP-' + Math.random().toString(36).substring(2,6).toUpperCase();

  const data = {
    type: 'freight', ref, username,
    company, crn, vat, name, title, email, phone,
    knect: knectOn,
    rebateRate: knectOn ? 5 : 3,
    submitted: new Date().toISOString(),
    status: 'pending'
  };

  localStorage.setItem('cp_application', JSON.stringify(data));
  window.location.href = 'docs.html';
}

/* ── LOG IN: find an existing application by HAF username or reference ── */
function doLogin(){
  const raw = document.getElementById('login-id').value.trim().toUpperCase();
  const err = document.getElementById('login-err');
  if(!raw){ err.classList.remove('show'); return; }
  const queue = JSON.parse(localStorage.getItem('cp_team_queue')||'[]');
  const cur = JSON.parse(localStorage.getItem('cp_application')||'null');
  let app = null;
  if(cur && (String(cur.ref).toUpperCase()===raw || String(cur.username||'').toUpperCase()===raw)) app = cur;
  if(!app) app = queue.find(a => String(a.ref).toUpperCase()===raw || String(a.username||'').toUpperCase()===raw);
  if(!app){ err.classList.add('show'); return; }
  localStorage.setItem('cp_application', JSON.stringify(app));
  if(!app.docs || !app.docs.length) window.location.href = 'docs.html';
  else window.location.href = 'status.html';
}
document.getElementById('login-id').addEventListener('input', () => {
  document.getElementById('login-err').classList.remove('show');
});
