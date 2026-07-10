/* Add account — team manually adds a current driver (or freight forwarder) to CleverPay.
   Uses the same username + PIN rules as the public sign-up so accounts behave identically. */

let addType = 'driver';

function openAdd(){
  document.getElementById('add-ov').classList.add('open');
  setAddType('driver');
  document.getElementById('add-err').classList.remove('show');
  document.querySelectorAll('#add-ov input').forEach(i=>{i.value='';});
  document.getElementById('add-status').value='approved';
  updateAddPreview();
}
function closeAdd(){document.getElementById('add-ov').classList.remove('open')}

function setAddType(t){
  addType=t;
  document.getElementById('at-driver').classList.toggle('active',t==='driver');
  document.getElementById('at-freight').classList.toggle('active',t==='freight');
  document.getElementById('add-driver-fields').style.display=t==='driver'?'':'none';
  document.getElementById('add-freight-fields').style.display=t==='freight'?'':'none';
  updateAddPreview();
}

/* Same username rules as the sign-up forms */
function addGenUsername(){
  if(addType==='driver'){
    const fn=val('ad-fname'),ln=val('ad-lname'),ph=val('ad-phone').replace(/\D/g,''),dob=val('ad-dob');
    if(!fn||!ln||ph.length<4||!dob)return'';
    return (fn[0]||'').toUpperCase()+(ln[0]||'').toUpperCase()+ph.slice(-4)+((dob.split('-')[0]||'').slice(-2)||'00');
  }
  const co=val('af-company'),ph=val('af-phone').replace(/\D/g,'');
  if(!co||ph.length<4)return'';
  const words=co.trim().split(/\s+/);
  const abbr=words.length===1?co.replace(/\s+/g,'').substring(0,4).toUpperCase()
    :words.filter(w=>!['ltd','limited','uk','plc','llp'].includes(w.toLowerCase())).map(w=>w[0]).join('').substring(0,4).toUpperCase();
  return abbr+ph.slice(-4);
}
function val(id){return (document.getElementById(id)?.value||'').trim()}
function updateAddPreview(){
  const u=addGenUsername();
  document.getElementById('add-uname').textContent=u||'—';
}

function addErr(msg){
  const e=document.getElementById('add-err');
  e.textContent=msg;
  e.classList.add('show');
}

async function addSubmit(){
  document.getElementById('add-err').classList.remove('show');
  const username=addGenUsername();
  const pin=val('ad-pin');
  const status=document.getElementById('add-status').value;
  let body;

  if(addType==='driver'){
    if(!val('ad-fname')||!val('ad-lname')||!val('ad-phone')||!val('ad-dob')){addErr('First name, last name, phone and date of birth are required.');return;}
    body={type:'driver',username,fname:val('ad-fname'),lname:val('ad-lname'),email:val('ad-email'),
      phone:val('ad-phone'),dob:val('ad-dob'),vtype:val('ad-vtype'),vreg:val('ad-vreg').toUpperCase(),status};
  }else{
    if(!val('af-company')||!val('af-phone')||!val('af-name')){addErr('Company name, contact name and phone are required.');return;}
    body={type:'freight',username,company:val('af-company'),crn:val('af-crn'),vat:val('af-vat'),
      name:val('af-name'),title:val('af-title'),email:val('af-email'),phone:val('af-phone'),status};
  }
  if(!username){addErr('Fill in the highlighted fields so the HAF username can be generated.');return;}

  if(pin){
    if(!/^\d{4,6}$/.test(pin)){addErr('PIN must be 4 to 6 digits (numbers only).');return;}
    body.pinHash=await cpHashPin(username,pin);
  }

  const btn=document.getElementById('add-submit');
  btn.disabled=true;btn.textContent='Adding…';
  const r=await cpApi('/team/applications',{method:'POST',body,token:TEAM.token});
  btn.disabled=false;btn.textContent='Add account';

  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return;}
  if(!r.ok){addErr(r.body?.error||'Could not add the account — try again.');return;}

  closeAdd();
  showToast((body.type==='driver'?'Driver':'Freight forwarder')+' added — username '+username+(pin?'':' (no PIN set — they log in with just their username until one is added)'));
  await loadQueue(true);
  setTab(status==='approved'?'approved':'pending');
}

document.getElementById('add-ov').addEventListener('click',function(e){if(e.target===this)closeAdd()});
['ad-fname','ad-lname','ad-phone','ad-dob','af-company','af-phone'].forEach(id=>{
  document.getElementById(id)?.addEventListener('input',updateAddPreview);
});
