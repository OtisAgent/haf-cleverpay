/* Correcting a record that already exists.

   Two jobs live here, both asked for by Brent on 4 Aug: putting a file the team
   already holds onto somebody's account by hand, and correcting the details and
   codes on it. Everything in this file acts on a record that has already been
   created — adding a brand new account with its paperwork is team-add.js. */

const EDIT_MAX_MB = 15;
const EDIT_MIME = ['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp'];
/* a phone often hands over a HEIC with no type at all — fall back to the extension
   rather than refuse an upload the store would happily have accepted */
const EDIT_EXT = {pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',
  heic:'image/heic',heif:'image/heif',webp:'image/webp'};
const EDIT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,application/pdf,image/*';
const EDIT_VTYPES = ['Small van','Midi van','SWB van','MWB van','LWB van','XLWB van',
  'Luton','Luton — tail lift'];

function edEsc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function edMime(f){
  const t=(f.type||'').toLowerCase();
  if(EDIT_MIME.includes(t))return t;
  return EDIT_EXT[(f.name.split('.').pop()||'').toLowerCase()]||'';
}

/* ── PUTTING A FILE ON A RECORD BY HAND ──
   The applicant's own upload door needs their PIN, which the team does not hold,
   so this goes through the team's own session instead. A hidden file input per
   document row keeps it one press: choose the file, it uploads, the row redraws. */

/* The button and its hidden file input, drawn onto a document row by team.js.
   "Add file" when nothing is held, "Replace" when something is — a replacement
   supersedes the old file and arrives unticked, because nobody has read it yet. */
function docAddBtn(ref,id,held){
  const t=held
    ?'Put a different file on this document — it replaces what is there and needs checking again'
    :'Put a file on this document yourself — for paperwork that came by email or WhatsApp';
  return`<button class="doc-add" onclick="cpDocPick('${ref}','${id}')" title="${t}">`+
    `<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`+
    `${held?'Replace':'Add file'}</button>`+
    (held?`<button class="doc-add doc-del" onclick="cpDocRemove('${ref}','${id}')" title="Take this document off the record">`+
      `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`:'')+
    `<input type="file" id="upl-${ref}-${id}" accept="${EDIT_ACCEPT}" style="display:none" onchange="cpDocChosen('${ref}','${id}',this)">`;
}

function cpDocPick(ref,id){
  const el=document.getElementById('upl-'+ref+'-'+id);
  if(el)el.click();
}

async function cpDocChosen(ref,id,input){
  const f=input.files&&input.files[0];
  input.value='';
  if(!f)return;
  if(!f.size)return showToast('That file looks empty',true);
  if(f.size>EDIT_MAX_MB*1024*1024)return showToast('That file is over '+EDIT_MAX_MB+'MB — use a smaller copy',true);
  const mime=edMime(f);
  if(!mime)return showToast('PDF or photo only (JPG, PNG or HEIC)',true);

  const row=document.getElementById('drow-'+ref+'-'+id);
  if(row)row.classList.add('uploading');
  showToast('Uploading '+f.name+'…');

  const q=new URLSearchParams({ref:ref,id:id,filename:f.name});
  let r;
  try{
    const res=await fetch(CP_API+'/team/doc-file?'+q.toString(),{
      method:'POST',
      headers:{'Content-Type':mime,'Authorization':'Bearer '+TEAM.token},
      body:f});
    r={ok:res.ok,status:res.status,body:await res.json().catch(()=>null)};
  }catch(e){r={ok:false,status:0,body:{error:'No connection — check your internet and try again.'}}}

  if(row)row.classList.remove('uploading');
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return;}
  if(!r.ok)return showToast((r.body&&r.body.error)||'Could not add that file',true);

  edApply(ref,r.body.app);
  showToast(f.name+' added to the record');
}

async function cpDocRemove(ref,id){
  const def=(typeof edDocName==='function')?edDocName(ref,id):id;
  if(!confirm('Take "'+def+'" off this record?\n\nThe file is removed from their application. You can add it again at any time.'))return;
  const r=await cpApi('/team/doc-remove',{method:'POST',token:TEAM.token,body:{ref:ref,id:id}});
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return;}
  if(!r.ok)return showToast((r.body&&r.body.error)||'Could not remove that document',true);
  edApply(ref,r.body.app);
  showToast('Document removed');
}

function edDocName(ref,id){
  const a=QUEUE.find(x=>x.ref===ref);
  if(!a)return id;
  const cfg=getConfig();
  const defs=a.type==='freight'?cfg.freight.docs:cfg.driver.docs;
  const d=defs.find(x=>x.id===id);
  return d?d.name:id;
}

/* One place that writes a changed record back into the queue and redraws it,
   keeping the card the person is looking at open underneath them. */
function edApply(ref,app){
  const a=QUEUE.find(x=>x.ref===ref);
  if(a&&app)Object.assign(a,app);
  renderView();
  const c=document.getElementById('card-'+ref);
  if(c)c.classList.add('expanded');
}

/* ── CORRECTING THE DETAILS AND THE CODES ── */

let EDIT_REF=null;

function openEdit(ref){
  const a=QUEUE.find(x=>x.ref===ref);
  if(!a)return;
  EDIT_REF=ref;
  document.getElementById('edit-title').textContent='Edit '+(a.company||[a.fname,a.lname].filter(Boolean).join(' ')||a.ref);
  document.getElementById('edit-sub').textContent=a.ref+' · '+(a.username||'no username')+
    ' — their username, status and access cannot be changed here.';
  document.getElementById('edit-body').innerHTML=edFormHtml(a);
  document.getElementById('edit-err').classList.remove('show');
  document.getElementById('edit-ov').classList.add('open');
  const first=document.querySelector('#edit-body input:not([type=hidden])');
  if(first)first.focus();
}
function closeEdit(){document.getElementById('edit-ov').classList.remove('open');EDIT_REF=null}

function edField(k,label,v,type,extra){
  return`<div><label class="fl">${label}</label><input class="fi" id="ed-${k}" type="${type||'text'}" value="${edEsc(v||'')}"${extra||''}></div>`;
}
function edSelect(k,label,v,opts){
  return`<div><label class="fl">${label}</label><select class="fi" id="ed-${k}"><option value="">—</option>`+
    opts.map(o=>`<option value="${edEsc(o)}"${o===v?' selected':''}>${edEsc(o)}</option>`).join('')+
    `</select></div>`;
}

function edFormHtml(a){
  const isF=a.type==='freight',isB=a.type==='business';
  const details=isB||isF
    ? edField('company','Company name',a.company)+
      edField('crn','Companies House no.',a.crn)+
      edField('name','Contact name',a.name)+
      edField('title','Job title',a.title)+
      edField('email','Email',a.email,'email')+
      edField('phone','Phone',a.phone,'tel')+
      (isF?edField('vat','VAT no.',a.vat):'')
    : edField('fname','First name',a.fname)+
      edField('lname','Last name',a.lname)+
      edField('email','Email',a.email,'email')+
      edField('phone','Phone',a.phone,'tel')+
      edField('dob','Date of birth',a.dob,'date')+
      edSelect('vtype','Vehicle type',a.vtype,EDIT_VTYPES)+
      edField('vreg','Vehicle reg',a.vreg,'text',' placeholder="AB12 CDE" style="text-transform:uppercase"');

  /* the three codes Brent named — they only exist on a driver's record */
  const codes=a.type!=='driver'?'':`
    <div class="ed-sec">Driving record codes</div>
    <div class="add-grid">
      ${edField('dvla_licence','Driving licence number',a.dvla_licence_no,'text',' maxlength="18" placeholder="16 characters, from the front of the card" style="text-transform:uppercase"')}
      ${/* never upper-case this one on screen: DVLA check codes are case sensitive,
            and showing "ZZ98YY76" for a code that is really "Zz98Yy76" invites
            somebody to retype what they see and break every lookup */''}
      ${edField('dvla_code','DVLA check code',a.dvla_check_code,'text',' maxlength="10" placeholder="8 letters and numbers, exactly as GOV.UK showed it" autocapitalize="off" spellcheck="false"')}
      ${edField('ni','National Insurance number',a.ni_number,'text',' maxlength="13" placeholder="AB123456C" style="text-transform:uppercase"')}
    </div>
    <div class="ed-note">A new check code starts a new 21-day clock and clears the record tick, so whoever confirms it next is confirming the code that is actually there.</div>`;

  const hist=edHistory(a.notes);
  return`
    <div class="ed-sec">${isB?'Enquiry details':'Their details'}</div>
    <div class="add-grid">${details}</div>
    ${codes}
    <div class="ed-sec">Notes</div>
    <textarea class="fi ed-notes" id="ed-notes" rows="3" placeholder="Anything the team should know about this account">${edEsc(hist.free)}</textarea>
    ${hist.lines.length?`<div class="ed-sec">Change history</div>
      <div class="ed-hist">${hist.lines.slice().reverse().map(l=>`<div class="ed-hist-line">${edEsc(l)}</div>`).join('')}</div>`:''}`;
}

/* The record notes hold the change history behind a marker, written by the API.
   Split it back out so the team edits their own words and reads the trail below. */
const EDIT_HIST_MARK='— — record changes — —';
function edHistory(notes){
  const s=String(notes||'');
  const i=s.indexOf(EDIT_HIST_MARK);
  if(i===-1)return{free:s,lines:[]};
  return{free:s.slice(0,i).replace(/\s+$/,''),
    lines:s.slice(i+EDIT_HIST_MARK.length).split('\n').map(l=>l.trim()).filter(Boolean)};
}

function edVal(k){const el=document.getElementById('ed-'+k);return el?el.value.trim():undefined}

async function saveEdit(){
  const ref=EDIT_REF;
  const a=QUEUE.find(x=>x.ref===ref);
  if(!a)return;
  const err=document.getElementById('edit-err');
  err.classList.remove('show');
  const fail=m=>{err.textContent=m;err.classList.add('show')};

  const fields={notes:edVal('notes')};
  ['fname','lname','email','phone','dob','vtype','vreg','company','crn','vat','name','title']
    .forEach(k=>{const v=edVal(k);if(v!==undefined)fields[k]=v});

  if(fields.email==='')return fail('An account needs an email address — it is how they are told anything.');

  const body={ref:ref,fields:fields};
  if(a.type==='driver'){
    body.dvla={licence:edVal('dvla_licence')||'',code:edVal('dvla_code')||'',ni:edVal('ni')||''};
  }

  /* a changed address has been confirmed by nobody, so say so before it costs them access */
  if(fields.email&&a.email&&fields.email.toLowerCase()!==String(a.email).toLowerCase()&&a.email_verified){
    if(!confirm('Change the email address to '+fields.email+'?\n\nTheir old address was confirmed. The new one has not been, so they will need to confirm it before they can be let in.'))return;
  }

  const btn=document.getElementById('edit-save');
  btn.disabled=true;btn.textContent='Saving…';
  const r=await cpApi('/team/edit',{method:'POST',token:TEAM.token,body:body});
  btn.disabled=false;btn.textContent='Save changes';

  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return;}
  if(!r.ok)return fail((r.body&&r.body.error)||'Could not save those changes — try again.');

  const changed=(r.body&&r.body.changed)||[];
  closeEdit();
  edApply(ref,r.body.app);
  showToast(changed.length?'Saved — '+changed.join(', ')+' updated':'Nothing had changed');
}

document.getElementById('edit-ov').addEventListener('click',function(e){if(e.target===this)closeEdit()});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&document.getElementById('edit-ov').classList.contains('open'))closeEdit();
});

/* ── TAKING A RECORD OFF THE PORTAL ──
   Brent, 4 Aug: "allow us to delete application off the portal or archive or clear
   and resend to the user". Three buttons, and they are deliberately not equal.

   Archive is one press and reversible, so it asks nothing: the record is hidden
   from the working tabs and sits in Archived until somebody puts it back. Nothing
   about it changes — not the status, not the documents, not their access.

   Clear and Delete both destroy something, so both explain what in full before
   the press, and Delete is only offered to the two people who can actually do it
   (the API refuses everyone else regardless) and only once the reference has been
   typed out. A confirm box you can dismiss with the space bar is not a decision. */
function manageBar(a){
  const arch=a.archived
    ?`<button class="btn btn-approve" onclick="setArchived('${a.ref}',false)" title="Put this back in the working tabs"><svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Restore to the queue</button>`
    :`<button class="btn btn-gh" onclick="setArchived('${a.ref}',true)" title="Hide this from the working tabs — nothing else changes and you can put it back"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="5"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>Archive</button>`;
  const clear=a.type==='business'?''
    :`<button class="btn btn-review" onclick="openClear('${a.ref}')" title="Wipe what they sent and ask them to do it again"><svg viewBox="0 0 24 24"><polyline points="3 2 3 8 9 8"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Clear &amp; send back</button>`;
  const del=canIntegrate()
    ?`<button class="btn btn-reject" onclick="openDelete('${a.ref}')" title="Remove this application and its documents for good"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>Delete</button>`:'';
  return`<div class="detail-sec">Manage this record</div><div class="manage-bar">${arch}${clear}${del}</div>`;
}

async function setArchived(ref,on){
  const r=await cpApi('/team/archive',{method:'POST',token:TEAM.token,body:{ref:ref,archived:on}});
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return}
  if(!r.ok){showToast((r.body&&r.body.error)||'Could not save that — try again',true);return}
  edApply(ref,r.body.app);
  renderQueue();
  showToast(on?'Archived — it is in the Archived tab if you need it back':'Back in the queue');
}

let CLEAR_REF=null;
function openClear(ref){
  const a=QUEUE.find(x=>x.ref===ref);if(!a)return;
  CLEAR_REF=ref;
  const n=(Array.isArray(a.docs)?a.docs:[]).length;
  document.getElementById('cl-who').textContent=displayName(a);
  document.getElementById('cl-email').textContent=a.email||'no email on file';
  document.getElementById('cl-docs').textContent=n===1?'1 document':n+' documents';
  document.getElementById('cl-access').style.display=a.access_confirmed_at?'':'none';
  document.getElementById('cl-go').disabled=false;
  document.getElementById('cl-ov').classList.add('open');
}
function closeClear(){document.getElementById('cl-ov').classList.remove('open');CLEAR_REF=null}
async function confirmClear(){
  const ref=CLEAR_REF;if(!ref)return;
  const go=document.getElementById('cl-go');
  go.disabled=true;go.textContent='Clearing…';
  const r=await cpApi('/team/clear',{method:'POST',token:TEAM.token,body:{ref:ref}});
  go.textContent='Clear it and send it back';
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return}
  if(!r.ok){go.disabled=false;showToast((r.body&&r.body.error)||'Could not clear that — try again',true);return}
  closeClear();
  edApply(ref,r.body.app);
  renderQueue();
  showToast(r.body.emailed
    ?'Cleared — the email is on its way to '+r.body.email
    :'Cleared. No email was sent: this applicant is opted out or blocked.',!r.body.emailed);
}

let DELETE_REF=null;
function openDelete(ref){
  const a=QUEUE.find(x=>x.ref===ref);if(!a)return;
  DELETE_REF=ref;
  document.getElementById('dl-who').textContent=displayName(a);
  document.getElementById('dl-ref').textContent=a.ref;
  const box=document.getElementById('dl-confirm');
  box.value='';
  document.getElementById('dl-go').disabled=true;
  document.getElementById('dl-ov').classList.add('open');
  setTimeout(()=>box.focus(),50);
}
function closeDelete(){document.getElementById('dl-ov').classList.remove('open');DELETE_REF=null}
function dlTyped(){
  const a=QUEUE.find(x=>x.ref===DELETE_REF);
  const v=document.getElementById('dl-confirm').value.trim().toUpperCase();
  document.getElementById('dl-go').disabled=!a||v!==String(a.ref).toUpperCase();
}
async function confirmDelete(){
  const ref=DELETE_REF;if(!ref)return;
  const go=document.getElementById('dl-go');
  go.disabled=true;go.textContent='Deleting…';
  const r=await cpApi('/team/delete',{method:'POST',token:TEAM.token,
    body:{ref:ref,confirm:document.getElementById('dl-confirm').value.trim()}});
  go.textContent='Delete it for good';
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return}
  if(!r.ok){go.disabled=false;showToast((r.body&&r.body.error)||'Could not delete that — try again',true);return}
  const i=QUEUE.findIndex(x=>x.ref===ref);
  if(i>=0)QUEUE.splice(i,1);
  closeDelete();
  renderQueue();
  showToast('Deleted — '+r.body.ref+' is gone, and the compliance group has been told');
}
['cl-ov','dl-ov'].forEach(id=>document.getElementById(id).addEventListener('click',function(e){
  if(e.target===this){id==='cl-ov'?closeClear():closeDelete()}
}));
