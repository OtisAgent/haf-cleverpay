/* Add account — team manually adds a current driver (or freight forwarder) to CleverPay.
   Uses the same username + PIN rules as the public sign-up so accounts behave identically. */

let addType = 'driver';

/* Documents the team already holds for this person. Kept in memory until the
   account exists, because a file can only be stored against a real reference. */
let addFiles = {};
const ADD_MAX_MB = 15;
const ADD_MIME = ['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp'];
/* phones often hand over a HEIC with no type at all — fall back to the extension
   rather than fail an upload the store would happily have accepted */
const ADD_EXT = {pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',
  heic:'image/heic',heif:'image/heif',webp:'image/webp'};
const ADD_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,application/pdf,image/*';

function openAdd(){
  document.getElementById('add-ov').classList.add('open');
  addFiles={};
  setAddType('driver');
  document.getElementById('add-err').classList.remove('show');
  document.querySelectorAll('#add-ov input').forEach(i=>{i.value='';});
  document.getElementById('add-status').value='approved';
  document.getElementById('add-doc-rows').style.display='none';
  document.getElementById('add-docs-toggle').classList.remove('on');
  updateAddPreview();
}
function closeAdd(){document.getElementById('add-ov').classList.remove('open')}

function setAddType(t){
  addType=t;
  document.getElementById('at-driver').classList.toggle('active',t==='driver');
  document.getElementById('at-freight').classList.toggle('active',t==='freight');
  document.getElementById('add-driver-fields').style.display=t==='driver'?'':'none';
  document.getElementById('add-freight-fields').style.display=t==='freight'?'':'none';
  /* a driver and a forwarder need different paperwork, so anything already
     picked belongs to the other list and must not be carried across */
  addFiles={};
  renderAddDocs();
  updateAddPreview();
}

/* ── attaching documents while the account is created ── */

function addEsc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function addSize(b){return b>=1048576?(b/1048576).toFixed(1)+'MB':Math.max(1,Math.round(b/1024))+'KB'}

function addDocDefs(){
  const cfg=typeof getConfig==='function'?getConfig():null;
  const set=cfg?(addType==='freight'?cfg.freight:cfg.driver):null;
  return set&&Array.isArray(set.docs)?set.docs:[];
}
function addDocDef(id){return addDocDefs().find(d=>d.id===id)||{id,name:id,status:'optional'}}

function toggleAddDocs(){
  const rows=document.getElementById('add-doc-rows');
  const open=rows.style.display==='none';
  rows.style.display=open?'':'none';
  document.getElementById('add-docs-toggle').classList.toggle('on',open);
  if(open)renderAddDocs();
}

function renderAddDocs(){
  const wrap=document.getElementById('add-doc-rows');
  if(!wrap)return;
  wrap.innerHTML=addDocDefs().map(d=>{
    const f=addFiles[d.id];
    const req=d.status==='required';
    return `<div class="adr${f?' on':''}">
      <div class="adr-name">${addEsc(d.name)}<span class="adr-badge ${req?'adr-req':'adr-opt'}">${req?'Required':'Optional'}</span></div>
      <div class="adr-file" id="adrf-${d.id}">${f?addEsc(f.name)+' · '+addSize(f.size):'—'}</div>
      <button type="button" class="adr-btn" onclick="${f?`addDropFile('${d.id}')`:`addPickFile('${d.id}')`}">${f?'Remove':'Attach'}</button>
      <input type="file" id="adri-${d.id}" accept="${ADD_ACCEPT}" style="display:none" onchange="addFileChosen('${d.id}',this)">
    </div>`;
  }).join('')||'<div class="adr-empty">No document list is set up for this account type yet.</div>';
  updateAddDocCount();
}

function updateAddDocCount(){
  const n=Object.keys(addFiles).length;
  const btn=document.getElementById('add-docs-toggle');
  const sub=document.getElementById('add-docs-sub');
  if(btn)btn.textContent=n?n+' attached':'Attach documents';
  if(sub)sub.textContent=n
    ?'They go on the record the moment the account is created — no need to chase them for these.'
    :'Attach anything you already hold — it lands on their record exactly like their own upload.';
}

function addMimeOf(f){
  const t=(f.type||'').toLowerCase();
  if(ADD_MIME.includes(t))return t;
  return ADD_EXT[(f.name.split('.').pop()||'').toLowerCase()]||'';
}
function addPickFile(id){document.getElementById('adri-'+id)?.click()}
function addDropFile(id){delete addFiles[id];renderAddDocs()}

function addFileChosen(id,input){
  const f=input.files&&input.files[0];
  if(!f)return;
  const note=(msg)=>{const el=document.getElementById('adrf-'+id);if(el){el.textContent=msg;el.classList.add('err')}input.value=''};
  if(f.size>ADD_MAX_MB*1024*1024)return note('Over '+ADD_MAX_MB+'MB — use a smaller copy');
  if(!f.size)return note('That file looks empty');
  if(!addMimeOf(f))return note('PDF or photo only (JPG, PNG, HEIC)');
  addFiles[id]=f;
  renderAddDocs();
}

/* one file to the CleverPay document store, against the reference just created */
async function addUploadFile(ref,id,file,key){
  const q=new URLSearchParams({ref:ref,id:id,k:key||''});
  try{
    const res=await fetch(CP_API+'/docs/file?'+q.toString(),
      {method:'POST',headers:{'Content-Type':addMimeOf(file)},body:file});
    if(!res.ok)return null;
    return await res.json();
  }catch(e){return null}
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

  /* The account exists now, so from here nothing may send them back to a form that
     would only refuse them as a duplicate — any upload trouble is reported instead. */
  const ref=r.body&&r.body.ref;
  const ids=Object.keys(addFiles);
  let attached=0,failed=[];
  if(ref&&ids.length){
    btn.disabled=true;
    const docs=[];
    for(let i=0;i<ids.length;i++){
      const id=ids[i],file=addFiles[id];
      btn.textContent='Uploading '+(i+1)+' of '+ids.length+'…';
      const up=await addUploadFile(ref,id,file,body.pinHash||'');
      if(up&&up.path)docs.push({id:id,filename:file.name,req:addDocDef(id).status==='required',
        path:up.path,mime:up.mime,size:up.size,added_by:TEAM&&TEAM.username});
      else failed.push(addDocDef(id).name);
    }
    if(docs.length){
      const pr=await cpApi('/team/applications/'+ref,{method:'PATCH',body:{docs:docs},token:TEAM.token});
      if(pr.ok)attached=docs.length;
      else failed=ids.map(id=>addDocDef(id).name);
    }
    btn.disabled=false;btn.textContent='Add account';
  }

  closeAdd();
  const who=body.type==='driver'?'Driver':'Freight forwarder';
  const pinNote=pin?'':' (no PIN set — they log in with just their username until one is added)';
  const docNote=attached?' · '+attached+' document'+(attached===1?'':'s')+' attached':'';
  if(failed.length)
    showToast(who+' added — username '+username+docNote+', but '+failed.join(', ')+
      ' did not upload. Open their record to add '+(failed.length===1?'it':'them')+'.',true);
  else
    showToast(who+' added — username '+username+docNote+pinNote);
  addFiles={};
  await loadQueue(true);
  setTab(status==='approved'?'approved':'pending');
}

document.getElementById('add-ov').addEventListener('click',function(e){if(e.target===this)closeAdd()});
['ad-fname','ad-lname','ad-phone','ad-dob','af-company','af-phone'].forEach(id=>{
  document.getElementById(id)?.addEventListener('input',updateAddPreview);
});
