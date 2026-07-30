/* Team portal — all data lives in the shared HAF database via the CleverPay API (api.js).
   Sign-in is checked server-side; the browser only ever holds a session token. */

let TEAM = null;        /* {token, username, name, role} */
let QUEUE = [];         /* applications cache, refreshed from the API */
let CFG = null;         /* portal config (doc requirements + rebates) */
let currentTab = 'pending';
let rejectTarget = null;

function toggleTheme(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}
function showToast(msg,err){const t=document.getElementById('toast');t.textContent=msg;t.className='toast'+(err?' error':'')+' show';setTimeout(()=>{t.classList.remove('show')},3000)}
function fmtDate(iso){if(!iso)return'—';const d=new Date(iso);return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}
function getConfig(){return CFG||JSON.parse(JSON.stringify(DEFAULT_CONFIG))}

/* ── AUTH ── */
async function gateLogin(){
  const u=document.getElementById('gate-user').value.trim().toLowerCase();
  const p=document.getElementById('gate-pw').value;
  const err=document.getElementById('gate-err');
  const r=await cpApi('/team/login',{method:'POST',body:{username:u,password:p}});
  if(!r.ok){
    err.textContent=r.body?.error||'Could not sign in — try again.';
    err.classList.add('show');
    document.getElementById('gate-pw').value='';
    return;
  }
  TEAM=r.body;
  sessionStorage.setItem('cp_team_session',JSON.stringify(TEAM));
  if(TEAM.mustSetPin){showSetPin();return;}
  enterShell();
}
/* First sign-in — the member picks their own PIN before they see anything else */
function showSetPin(){
  document.querySelector('#gate .gate-card').style.display='none';
  document.getElementById('setpin-card').style.display='';
  document.getElementById('setpin-name').textContent=(TEAM.name||'').split(' ')[0]||'there';
  document.getElementById('setpin-a').focus();
}
async function savePin(){
  const a=document.getElementById('setpin-a').value.trim();
  const b=document.getElementById('setpin-b').value.trim();
  const err=document.getElementById('setpin-err');
  const fail=m=>{err.textContent=m;err.classList.add('show')};
  if(!/^\d{4,6}$/.test(a))return fail('Your PIN must be 4 to 6 numbers.');
  if(a!==b)return fail('Those two PINs do not match.');
  err.classList.remove('show');
  const r=await cpApi('/team/set-pin',{method:'POST',token:TEAM.token,body:{pin:a}});
  if(!r.ok)return fail(r.body?.error||'Could not save your PIN — try again.');
  delete TEAM.mustSetPin;
  sessionStorage.setItem('cp_team_session',JSON.stringify(TEAM));
  document.getElementById('setpin-card').style.display='none';
  document.querySelector('#gate .gate-card').style.display='';
  document.getElementById('setpin-a').value='';document.getElementById('setpin-b').value='';
  enterShell();
  showToast('PIN saved — use it to sign in from now on');
}
function enterShell(){
  document.getElementById('gate').style.display='none';
  document.getElementById('shell').classList.add('show');
  document.getElementById('welcome-name').textContent=TEAM.name;
  loadConfig();
  loadQueue();
}
function doSignOut(){
  sessionStorage.removeItem('cp_team_session');
  TEAM=null;QUEUE=[];
  document.getElementById('shell').classList.remove('show');
  document.getElementById('gate').style.display='';
  document.getElementById('setpin-card').style.display='none';
  document.querySelector('#gate .gate-card').style.display='';
  document.getElementById('gate-user').value='';
  document.getElementById('gate-pw').value='';
  document.getElementById('gate-err').classList.remove('show');
}

/* ── DATA ── */
async function loadConfig(){
  const r=await cpApi('/config');
  if(r.ok&&r.body)CFG=r.body;
}
async function loadQueue(silent){
  if(!TEAM)return;
  const r=await cpApi('/team/applications',{token:TEAM.token});
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return;}
  if(r.ok){QUEUE=(r.body||[]).map(a=>({...a,rejectReason:a.reject_reason}));renderView();}
  else if(!silent)showToast(r.body?.error||'Could not load the queue',true);
}
function refreshQueue(){loadQueue();showToast('Queue refreshed')}

/* ── TABS ── */
function setTab(t){
  currentTab=t;
  ['pending','reviewing','approved','rejected','all','settings'].forEach(x=>{
    document.getElementById('tab-'+x).classList.toggle('active',x===t);
  });
  renderView();
}
function renderView(){
  if(currentTab==='settings') renderSettings();
  else renderQueue();
}

/* ── KPI ── */
function updateKPIs(q){
  const n=(s)=>q.filter(a=>a.status===s).length;
  /* business enquiries arrive as status 'enquiry' — they queue with pending */
  const nPending=n('pending')+n('enquiry');
  document.getElementById('kpi-pending').textContent=nPending;
  document.getElementById('kpi-reviewing').textContent=n('reviewing');
  document.getElementById('kpi-approved').textContent=n('approved');
  document.getElementById('kpi-total').textContent=q.length;
  document.getElementById('pending-badge').textContent=nPending+' pending';
  document.getElementById('tc-pending').textContent=nPending;
  document.getElementById('tc-reviewing').textContent=n('reviewing');
  document.getElementById('tc-approved').textContent=n('approved');
  document.getElementById('tc-rejected').textContent=n('rejected');
}

/* ── QUEUE RENDER ── */
function renderQueue(){
  const q=QUEUE;
  updateKPIs(q);
  const filtered=currentTab==='all'?q:q.filter(a=>a.status===currentTab||(currentTab==='pending'&&a.status==='enquiry'));
  const el=document.getElementById('main-content');
  if(!filtered.length){
    el.innerHTML=`<div class="empty"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>No ${currentTab==='all'?'':currentTab} applications yet.</div>`;
    return;
  }
  el.innerHTML=`<div class="app-list">${filtered.map(a=>appCardHtml(a)).join('')}</div>`;
  filtered.forEach(a=>{
    document.getElementById('head-'+a.ref)?.addEventListener('click',()=>toggleCard(a.ref));
  });
}

function ini(a){
  if(a.type==='freight'||a.type==='business'){
    const w=(a.company||'').split(' ').filter(x=>!['ltd','limited','uk','plc','llp'].includes(x.toLowerCase()));
    return w.slice(0,2).map(x=>x[0]?.toUpperCase()||'').join('');
  }
  return(((a.fname||'')[0]||'').toUpperCase()+((a.lname||'')[0]||'').toUpperCase())||'—';
}
function displayName(a){
  const n=(a.type==='driver'?((a.fname||'')+' '+(a.lname||'')):(a.company||a.name||'')).trim();
  return n||'Name not given';
}
function statusChip(s){
  const m={pending:'chip-pending',enquiry:'chip-pending',reviewing:'chip-reviewing',approved:'chip-approved',rejected:'chip-rejected',blocked:'chip-rejected'};
  const l={pending:'Pending',enquiry:'New enquiry',reviewing:'In Review',approved:'Approved',rejected:'Rejected',blocked:'Blocked'};
  return`<span class="chip ${m[s]||'chip-pending'}">${l[s]||s}</span>`;
}

function appCardHtml(a){
  const isF=a.type==='freight';
  const isB=a.type==='business';
  const cfg=getConfig();
  /* business enquiries carry no compliance docs — never flag them as missing */
  const docDefs=isB?[]:(isF?cfg.freight.docs:cfg.driver.docs);

  const uploaded=Array.isArray(a.docs)?a.docs:[];
  const uploadedIds=uploaded.map(d=>d.id);
  const reqDefs=docDefs.filter(d=>d.status==='required');
  const missingReq=reqDefs.filter(d=>!uploadedIds.includes(d.id));

  const docRow=(d,badge)=>{
    const def=docDefs.find(x=>x.id===d.id);
    const on=d.checked===true||(d.checked===undefined&&a.status==='approved');
    /* only a document whose file is actually held can be opened — older applications
       were submitted before the store existed and hold a filename only */
    const open=d.path
      ?`<button class="doc-open" onclick="openDoc('${a.ref}','${d.id}')" title="Open this document">
          <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View</button>`
      :`<span class="doc-nofile" title="Submitted before the document store existed — ask them to upload it again">No file held</span>`;
    return`<div class="doc-row"><div class="dc-chk${on?' on':''}" id="chk-${a.ref}-${d.id}" onclick="tickDoc('${a.ref}','${d.id}')" title="${d.checked_by?'Checked by '+d.checked_by+' · '+fmtDate(d.checked_at):'Tick once you have checked this document'}"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="doc-row-name">${def?def.name:d.id}</div><div class="doc-row-file">${d.filename||'—'}${d.size?' · '+fmtSize(d.size):''}</div>${open}<span class="doc-row-badge ${badge.cls}">${badge.txt}</span></div>`;
  };

  const allDocRows=[
    ...uploaded.filter(d=>{const def=docDefs.find(x=>x.id===d.id);return def&&def.status==='required';})
      .map(d=>docRow(d,{cls:'badge-ok',txt:'Uploaded'})),
    ...missingReq.map(d=>`<div class="doc-row missing"><div class="dc-chk" style="opacity:.4"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="doc-row-name">${d.name}</div><div class="doc-row-file">—</div><span class="doc-row-badge badge-missing">Missing</span></div>`),
    ...uploaded.filter(d=>{const def=docDefs.find(x=>x.id===d.id);return !def||def.status==='optional';})
      .map(d=>docRow(d,{cls:'badge-opt',txt:'Optional'})),
  ];

  const driverRows=`
    <div class="dg"><div class="dl">Name</div><div class="dv">${a.fname||''} ${a.lname||''}</div></div>
    <div class="dg"><div class="dl">HAF Username</div><div class="dv mono">${a.username||'—'}</div></div>
    <div class="dg"><div class="dl">Email</div><div class="dv">${a.email||'—'}</div></div>
    <div class="dg"><div class="dl">Phone</div><div class="dv">${a.phone||'—'}</div></div>
    <div class="dg"><div class="dl">Date of Birth</div><div class="dv">${a.dob||'—'}</div></div>
    <div class="dg"><div class="dl">Vehicle type</div><div class="dv">${a.vtype||'—'}</div></div>
    <div class="dg"><div class="dl">Vehicle reg</div><div class="dv mono">${a.vreg||'—'}</div></div>
    <div class="dg"><div class="dl">Submitted</div><div class="dv">${fmtDate(a.submitted)}</div></div>
  `;
  const freightRows=`
    <div class="dg"><div class="dl">Company</div><div class="dv">${a.company||'—'}</div></div>
    <div class="dg"><div class="dl">HAF Username</div><div class="dv mono">${a.username||'—'}</div></div>
    <div class="dg"><div class="dl">Contact name</div><div class="dv">${a.name||'—'}</div></div>
    <div class="dg"><div class="dl">Job title</div><div class="dv">${a.title||'—'}</div></div>
    <div class="dg"><div class="dl">Email</div><div class="dv">${a.email||'—'}</div></div>
    <div class="dg"><div class="dl">Phone</div><div class="dv">${a.phone||'—'}</div></div>
    <div class="dg"><div class="dl">Co. Reg. No.</div><div class="dv mono">${a.crn||'—'}</div></div>
    <div class="dg"><div class="dl">VAT No.</div><div class="dv">${a.vat||'Not provided'}</div></div>
    <div class="dg"><div class="dl">Submitted</div><div class="dv">${fmtDate(a.submitted)}</div></div>
  `;
  const businessRows=`
    <div class="dg"><div class="dl">Company</div><div class="dv">${a.company||'—'}</div></div>
    <div class="dg"><div class="dl">Contact name</div><div class="dv">${a.name||'—'}</div></div>
    <div class="dg"><div class="dl">Email</div><div class="dv">${a.email||'—'}</div></div>
    <div class="dg"><div class="dl">Phone</div><div class="dv">${a.phone||'—'}</div></div>
    <div class="dg" style="grid-column:1/-1"><div class="dl">What they need to move</div><div class="dv">${a.notes||'—'}</div></div>
    <div class="dg"><div class="dl">Submitted</div><div class="dv">${fmtDate(a.submitted)}</div></div>
  `;
  const freightExtras=isF?`
    <div class="info-row"><span class="ir-label">KNECT member</span><span class="ir-val">${a.knect?'Yes':'No'}</span></div>
    <div class="info-row"><span class="ir-label">Payment model</span><span class="ir-val">Pay upfront — no credit</span></div>
  `:'';

  const actions=(()=>{
    if(a.status==='blocked')return`<button class="btn btn-approve" onclick="unblockAcc('${a.ref}')"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Unblock (back to pending)</button>`;
    const blockBtn=isB?'':`<button class="btn btn-reject" onclick="blockAcc('${a.ref}')" title="Refuse this account all access — including PLNA"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>Block</button>`;
    const emailBtn=(!isB&&!a.email_verified)?`<button class="btn btn-review" onclick="confirmEmail('${a.ref}')" title="Mark this applicant's email address as confirmed"><svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>Confirm email</button>`:'';
    if(a.status==='approved')return`${emailBtn}<button class="btn btn-gh btn-done">Approved ✓</button>${blockBtn}`;
    if(a.status==='rejected')return`<button class="btn btn-gh btn-done">Rejected</button>${blockBtn}`;
    const rev=(a.status==='pending'||a.status==='enquiry')?`<button class="btn btn-review" onclick="markReviewing('${a.ref}')"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Mark in review</button>`:'';
    return`${rev}${emailBtn}<button class="btn btn-approve" onclick="approve('${a.ref}')"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Approve</button><button class="btn btn-reject" onclick="openReject('${a.ref}')"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Reject</button>${blockBtn}`;
  })();

  return`<div class="app-card" id="card-${a.ref}">
    <div class="app-head" id="head-${a.ref}">
      <div class="app-avatar">${ini(a)}</div>
      <div class="app-main">
        <div class="app-name">${displayName(a)}</div>
        <div class="app-meta">${a.ref} · ${fmtDate(a.submitted)}</div>
      </div>
      <div class="app-right">
        <span class="chip ${isB?'chip-business':isF?'chip-freight':'chip-driver'}">${isB?'Business':isF?'Freight':'Driver'}</span>
        ${statusChip(a.status)}
        ${isB?'':(a.email_verified?`<span class="chip chip-approved" title="Email address confirmed">Email ✓</span>`:`<span class="chip chip-pending" title="Access stays locked until the email is confirmed">Email unconfirmed</span>`)}
        ${a.added_by?`<span class="chip chip-reviewing" title="Added manually by the HAF team">Added by ${a.added_by}</span>`:''}
        ${missingReq.length?`<span class="chip" style="background:rgba(208,64,64,.1);color:var(--rd);border:1px solid rgba(208,64,64,.2)">${missingReq.length} doc${missingReq.length!==1?'s':''} missing</span>`:''}
      </div>
      <div class="chevron"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></div>
    </div>
    <div class="app-detail">
      <div class="detail-sec">${isB?'Enquiry details':'Applicant details'}</div>
      <div class="detail-grid">${isB?businessRows:isF?freightRows:driverRows}</div>
      ${freightExtras}
      ${isB?'':`<div class="detail-sec">Compliance documents</div>
      <div class="doc-rows">${allDocRows.join('')||'<div style="font-size:.74rem;color:var(--mu);padding:.2rem 0">No documents submitted yet.</div>'}</div>`}
      <div class="detail-sec">Actions</div>
      <div class="action-bar">${actions}</div>
    </div>
  </div>`;
}

/* ── ACTIONS ── */
function toggleCard(ref){
  const c=document.getElementById('card-'+ref);
  const was=c.classList.contains('expanded');
  document.querySelectorAll('.app-card.expanded').forEach(x=>x.classList.remove('expanded'));
  if(!was)c.classList.add('expanded');
}
/* ── DOCUMENT VIEWER ──
   The file never has a public address. The portal asks the API for it with this
   reviewer's session, holds the bytes in the browser only, and drops them on close. */
let VIEW={ref:null,list:[],i:0,url:null};

function fmtSize(n){if(!n)return'';return n<1048576?Math.max(1,Math.round(n/1024))+'KB':(n/1048576).toFixed(1)+'MB'}

function heldDocs(ref){
  const a=QUEUE.find(x=>x.ref===ref);
  if(!a)return[];
  const cfg=getConfig();
  const defs=a.type==='freight'?cfg.freight.docs:cfg.driver.docs;
  return(Array.isArray(a.docs)?a.docs:[]).filter(d=>d.path)
    .map(d=>({...d,name:(defs.find(x=>x.id===d.id)||{}).name||d.id}));
}

async function openDoc(ref,id){
  if(!TEAM)return;
  VIEW.ref=ref;VIEW.list=heldDocs(ref);
  const at=VIEW.list.findIndex(d=>d.id===id);
  VIEW.i=at<0?0:at;
  if(!VIEW.list.length){showToast('No document files are held on this application yet',true);return}
  document.getElementById('doc-ov').classList.add('open');
  await showDoc();
}

function closeDoc(){
  document.getElementById('doc-ov').classList.remove('open');
  document.getElementById('dv-body').innerHTML='';
  if(VIEW.url){URL.revokeObjectURL(VIEW.url);VIEW.url=null}
}

function stepDoc(n){
  const next=VIEW.i+n;
  if(next<0||next>=VIEW.list.length)return;
  VIEW.i=next;showDoc();
}

async function showDoc(){
  const d=VIEW.list[VIEW.i];
  const a=QUEUE.find(x=>x.ref===VIEW.ref)||{};
  const body=document.getElementById('dv-body');
  document.getElementById('dv-title').textContent=d.name;
  document.getElementById('dv-sub').textContent=
    `${displayName(a)} · ${a.ref} · ${d.filename||'file'}${d.size?' · '+fmtSize(d.size):''}`;
  document.getElementById('dv-count').textContent=`${VIEW.i+1} of ${VIEW.list.length}`;
  document.getElementById('dv-prev').disabled=VIEW.i===0;
  document.getElementById('dv-next').disabled=VIEW.i>=VIEW.list.length-1;
  const tick=document.getElementById('dv-tick');
  tick.textContent=d.checked?'Checked ✓'+(d.checked_by?' by '+d.checked_by:''):'Tick as checked';
  tick.className='btn '+(d.checked?'btn-gh btn-done':'btn-approve');

  if(VIEW.url){URL.revokeObjectURL(VIEW.url);VIEW.url=null}
  body.innerHTML='<div class="dv-msg">Opening the document…</div>';

  let res;
  try{
    res=await fetch(CP_API+'/team/doc?ref='+encodeURIComponent(VIEW.ref)+'&id='+encodeURIComponent(d.id),
      {headers:{Authorization:'Bearer '+TEAM.token}});
  }catch(e){
    body.innerHTML='<div class="dv-msg">No connection — check your internet and try again.</div>';return;
  }
  if(res.status===401){closeDoc();showToast('Session expired — please sign in again',true);doSignOut();return}
  if(!res.ok){
    const e=await res.json().catch(()=>null);
    body.innerHTML='<div class="dv-msg">'+(e&&e.error==='no_file'
      ?'No file is held for this document — ask the applicant to upload it again.'
      :'That document could not be opened. Nothing has been lost — try again, and tell Otis if it keeps failing.')+'</div>';
    return;
  }
  const blob=await res.blob();
  VIEW.url=URL.createObjectURL(blob);
  const mime=d.mime||blob.type||'';
  const dl=document.getElementById('dv-dl');
  dl.href=VIEW.url;dl.download=d.filename||d.id;

  if(mime.includes('pdf'))
    body.innerHTML=`<iframe class="dv-frame" src="${VIEW.url}" title="${d.name}"></iframe>`;
  else if(mime.startsWith('image/'))
    body.innerHTML=`<img class="dv-img" src="${VIEW.url}" alt="${d.name}">`;
  else
    body.innerHTML='<div class="dv-msg">This file type can’t be shown in the portal — use Download to open it.</div>';
}

async function tickFromViewer(){
  const d=VIEW.list[VIEW.i];
  if(d)await tickDoc(VIEW.ref,d.id);
}

/* a tick is a compliance record, so it is saved against the application with who and when */
async function tickDoc(ref,id){
  if(!TEAM)return;
  const a=QUEUE.find(x=>x.ref===ref);
  const d=a&&(Array.isArray(a.docs)?a.docs:[]).find(x=>x.id===id);
  if(!d)return;
  const next=!d.checked;
  const el=document.getElementById('chk-'+ref+'-'+id);
  el?.classList.toggle('on',next);
  const r=await cpApi('/team/doc-check',{method:'POST',token:TEAM.token,body:{ref:ref,id:id,checked:next}});
  if(!r.ok){el?.classList.toggle('on',!next);showToast(r.body?.error||'Could not save that tick',true);return}
  a.docs=r.body.docs;
  const fresh=a.docs.find(x=>x.id===id)||{};
  VIEW.list=VIEW.list.map(x=>x.id===id?{...x,...fresh}:x);
  if(document.getElementById('doc-ov').classList.contains('open')){
    const tick=document.getElementById('dv-tick');
    tick.textContent=fresh.checked?'Checked ✓'+(fresh.checked_by?' by '+fresh.checked_by:''):'Tick as checked';
    tick.className='btn '+(fresh.checked?'btn-gh btn-done':'btn-approve');
  }
  showToast(next?'Document checked off':'Tick removed');
}
function markReviewing(ref){update(ref,{status:'reviewing'},'Marked as in review')}
/* Approving with an unconfirmed email used to leave the applicant stuck — approved
   but locked out, waiting on a separate "Confirm email" click nobody knew to make.
   Both decisions are now taken together in one prompt, so the step cannot be missed. */
function approve(ref){
  const a=QUEUE.find(x=>x.ref===ref);
  if(a&&a.type!=='business'&&!a.email_verified){openApproveEmail(ref);return}
  update(ref,{status:'approved'},a&&a.type==='business'?'Enquiry approved':'Approved — access is unlocked');
}
let approveTarget=null;
function openApproveEmail(ref){
  approveTarget=ref;
  const a=QUEUE.find(x=>x.ref===ref)||{};
  document.getElementById('ae-email').textContent=a.email||'no email on file';
  document.getElementById('ae-ov').classList.add('open');
}
function closeApproveEmail(){document.getElementById('ae-ov').classList.remove('open');approveTarget=null}
async function approveAndConfirm(){
  const ref=approveTarget;closeApproveEmail();if(!ref)return;
  if(!await update(ref,{status:'approved'}))return;
  if(await confirmEmail(ref,true))showToast('Approved and email confirmed — access is unlocked');
}
function approveOnly(){
  const ref=approveTarget;closeApproveEmail();if(!ref)return;
  update(ref,{status:'approved'},'Approved — access stays locked until their email is confirmed');
}
function blockAcc(ref){update(ref,{status:'blocked'},'Account blocked — all access refused')}
function unblockAcc(ref){update(ref,{status:'pending'},'Unblocked — returned to pending for re-review')}

/* Email confirmation goes through a database function that checks the team
   session token server-side — the public key alone cannot flip this flag. */
const SB_URL='https://jsdwvogsxlnczzbefwgp.supabase.co';
const SB_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzZHd2b2dzeGxuY3p6YmVmd2dwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODgyMzYsImV4cCI6MjA5Njk2NDIzNn0.pxqM-Oh4f_3PlqCbKIKvcKZnNRUZ1ASKqqdNg78M_4M';
async function confirmEmail(ref,silent){
  if(!TEAM)return false;
  let ok=false;
  try{
    const res=await fetch(SB_URL+'/rest/v1/rpc/cleverpay_team_set_email_verified',{
      method:'POST',
      headers:{'Content-Type':'application/json',apikey:SB_ANON,Authorization:'Bearer '+SB_ANON},
      body:JSON.stringify({p_ref:ref,p_token:TEAM.token,p_verified:true})
    });
    ok=res.ok;
  }catch(e){}
  if(!ok){showToast(silent?'Approved, but the email could not be confirmed — use the Confirm email button on the card to retry':'Could not confirm the email — try again',true);return false;}
  const i=QUEUE.findIndex(a=>a.ref===ref);
  if(i>=0)QUEUE[i]={...QUEUE[i],email_verified:true};
  renderQueue();
  if(!silent)showToast('Email confirmed');
  return true;
}
async function update(ref,patch,okMsg){
  const r=await cpApi('/team/applications/'+ref,{method:'PATCH',body:patch,token:TEAM.token});
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return false;}
  if(!r.ok){showToast(r.body?.error||'Update failed — try again',true);return false;}
  const i=QUEUE.findIndex(a=>a.ref===ref);
  if(i>=0)QUEUE[i]={...r.body,rejectReason:r.body.reject_reason};
  renderQueue();
  if(okMsg)showToast(okMsg,patch.status==='rejected');
  return true;
}
function openReject(ref){rejectTarget=ref;document.getElementById('reject-reason-text').value='';document.getElementById('modal-ov').classList.add('open')}
function closeModal(){document.getElementById('modal-ov').classList.remove('open');rejectTarget=null}
function confirmReject(){
  if(!rejectTarget)return;
  const reason=document.getElementById('reject-reason-text').value.trim()||'The compliance team will be in touch with further details.';
  update(rejectTarget,{status:'rejected',rejectReason:reason},'Application rejected');
  closeModal();
}
document.getElementById('modal-ov').addEventListener('click',function(e){if(e.target===this)closeModal()});
document.getElementById('ae-ov').addEventListener('click',function(e){if(e.target===this)closeApproveEmail()});

/* reviewing a pile of documents is keyboard work: Esc closes, arrows flip through */
document.addEventListener('keydown',e=>{
  if(!document.getElementById('doc-ov').classList.contains('open'))return;
  if(e.key==='Escape')closeDoc();
  else if(e.key==='ArrowLeft')stepDoc(-1);
  else if(e.key==='ArrowRight')stepDoc(1);
});

/* ── INIT ── */
const stored=sessionStorage.getItem('cp_team_session');
if(stored){
  TEAM=JSON.parse(stored);
  if(TEAM.mustSetPin)showSetPin();else enterShell();
}

/* Auto-refresh queue every 15s */
setInterval(()=>{if(TEAM&&currentTab!=='settings')loadQueue(true)},15000);
