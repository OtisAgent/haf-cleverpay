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
  enterShell();
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
  return((a.fname||'')[0]||'').toUpperCase()+((a.lname||'')[0]||'').toUpperCase();
}
function displayName(a){return a.type==='driver'?(a.fname+' '+a.lname):(a.company||a.name)}
function statusChip(s){
  const m={pending:'chip-pending',enquiry:'chip-pending',reviewing:'chip-reviewing',approved:'chip-approved',rejected:'chip-rejected'};
  const l={pending:'Pending',enquiry:'New enquiry',reviewing:'In Review',approved:'Approved',rejected:'Rejected'};
  return`<span class="chip ${m[s]||'chip-pending'}">${l[s]||s}</span>`;
}

function appCardHtml(a){
  const isF=a.type==='freight';
  const isB=a.type==='business';
  const cfg=getConfig();
  /* business enquiries carry no compliance docs — never flag them as missing */
  const docDefs=isB?[]:(isF?cfg.freight.docs:cfg.driver.docs);

  const uploaded=a.docs||[];
  const uploadedIds=uploaded.map(d=>d.id);
  const reqDefs=docDefs.filter(d=>d.status==='required');
  const missingReq=reqDefs.filter(d=>!uploadedIds.includes(d.id));

  const allDocRows=[
    ...uploaded.filter(d=>{const def=docDefs.find(x=>x.id===d.id);return def&&def.status==='required';}).map(d=>{
      const def=docDefs.find(x=>x.id===d.id);
      return`<div class="doc-row"><div class="dc-chk${a.status==='approved'?' on':''}" id="chk-${a.ref}-${d.id}" onclick="tickDoc('${a.ref}','${d.id}')"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="doc-row-name">${def?def.name:d.id}</div><div class="doc-row-file">${d.filename}</div><span class="doc-row-badge badge-ok">Uploaded</span></div>`;
    }),
    ...missingReq.map(d=>`<div class="doc-row missing"><div class="dc-chk" style="opacity:.4"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="doc-row-name">${d.name}</div><div class="doc-row-file">—</div><span class="doc-row-badge badge-missing">Missing</span></div>`),
    ...uploaded.filter(d=>{const def=docDefs.find(x=>x.id===d.id);return !def||def.status==='optional';}).map(d=>{
      const def=docDefs.find(x=>x.id===d.id);
      return`<div class="doc-row"><div class="dc-chk${a.status==='approved'?' on':''}" id="chk-${a.ref}-${d.id}" onclick="tickDoc('${a.ref}','${d.id}')"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="doc-row-name">${def?def.name:d.id}</div><div class="doc-row-file">${d.filename}</div><span class="doc-row-badge badge-opt">Optional</span></div>`;
    }),
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
    if(a.status==='approved')return`<button class="btn btn-gh btn-done">Approved ✓</button>`;
    if(a.status==='rejected')return`<button class="btn btn-gh btn-done">Rejected</button>`;
    const rev=(a.status==='pending'||a.status==='enquiry')?`<button class="btn btn-review" onclick="markReviewing('${a.ref}')"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Mark in review</button>`:'';
    return`${rev}<button class="btn btn-approve" onclick="approve('${a.ref}')"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Approve</button><button class="btn btn-reject" onclick="openReject('${a.ref}')"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Reject</button>`;
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
function tickDoc(ref,id){document.getElementById('chk-'+ref+'-'+id)?.classList.toggle('on')}
function markReviewing(ref){update(ref,{status:'reviewing'},'Marked as in review')}
function approve(ref){update(ref,{status:'approved'},'Application approved — access granted')}
async function update(ref,patch,okMsg){
  const r=await cpApi('/team/applications/'+ref,{method:'PATCH',body:patch,token:TEAM.token});
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return;}
  if(!r.ok){showToast(r.body?.error||'Update failed — try again',true);return;}
  const i=QUEUE.findIndex(a=>a.ref===ref);
  if(i>=0)QUEUE[i]={...r.body,rejectReason:r.body.reject_reason};
  renderQueue();
  if(okMsg)showToast(okMsg,patch.status==='rejected');
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

/* ── INIT ── */
const stored=sessionStorage.getItem('cp_team_session');
if(stored){
  TEAM=JSON.parse(stored);
  enterShell();
}

/* Auto-refresh queue every 15s */
setInterval(()=>{if(TEAM&&currentTab!=='settings')loadQueue(true)},15000);
