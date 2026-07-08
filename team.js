function toggleTheme(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}
function getQueue(){return JSON.parse(localStorage.getItem('cp_team_queue')||'[]')}
function saveQueue(q){localStorage.setItem('cp_team_queue',JSON.stringify(q))}
function getConfig(){return JSON.parse(localStorage.getItem('cp_config')||'null')||JSON.parse(JSON.stringify(DEFAULT_CONFIG))}
function saveConfig(c){localStorage.setItem('cp_config',JSON.stringify(c))}
function showToast(msg,err){const t=document.getElementById('toast');t.textContent=msg;t.className='toast'+(err?' error':'')+' show';setTimeout(()=>{t.classList.remove('show')},3000)}
function fmtDate(iso){if(!iso)return'—';const d=new Date(iso);return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}

/* ── AUTH ── */
function gateLogin(){
  const u=document.getElementById('gate-user').value.trim().toLowerCase();
  const p=document.getElementById('gate-pw').value;
  const user=USERS.find(x=>x.username===u&&x.password===p);
  if(user){
    currentUser=user;
    sessionStorage.setItem('cp_team_user',JSON.stringify(user));
    document.getElementById('gate').style.display='none';
    document.getElementById('shell').classList.add('show');
    document.getElementById('welcome-name').textContent=user.name;
    renderView();
  }else{
    document.getElementById('gate-err').classList.add('show');
    document.getElementById('gate-pw').value='';
  }
}
function doSignOut(){
  sessionStorage.removeItem('cp_team_user');
  currentUser=null;
  document.getElementById('shell').classList.remove('show');
  document.getElementById('gate').style.display='';
  document.getElementById('gate-user').value='';
  document.getElementById('gate-pw').value='';
  document.getElementById('gate-err').classList.remove('show');
}

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
  document.getElementById('kpi-pending').textContent=n('pending');
  document.getElementById('kpi-reviewing').textContent=n('reviewing');
  document.getElementById('kpi-approved').textContent=n('approved');
  document.getElementById('kpi-total').textContent=q.length;
  document.getElementById('pending-badge').textContent=n('pending')+' pending';
  document.getElementById('tc-pending').textContent=n('pending');
  document.getElementById('tc-reviewing').textContent=n('reviewing');
  document.getElementById('tc-approved').textContent=n('approved');
  document.getElementById('tc-rejected').textContent=n('rejected');
}

/* ── QUEUE RENDER ── */
function refreshQueue(){renderQueue();showToast('Queue refreshed')}
function renderQueue(){
  const q=getQueue();
  updateKPIs(q);
  const filtered=currentTab==='all'?q:q.filter(a=>a.status===currentTab);
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
  if(a.type==='freight'){
    const w=(a.company||'').split(' ').filter(x=>!['ltd','limited','uk','plc','llp'].includes(x.toLowerCase()));
    return w.slice(0,2).map(x=>x[0]?.toUpperCase()||'').join('');
  }
  return((a.fname||'')[0]||'').toUpperCase()+((a.lname||'')[0]||'').toUpperCase();
}
function displayName(a){return a.type==='driver'?(a.fname+' '+a.lname):(a.company||a.name)}
function statusChip(s){
  const m={pending:'chip-pending',reviewing:'chip-reviewing',approved:'chip-approved',rejected:'chip-rejected'};
  const l={pending:'Pending',reviewing:'In Review',approved:'Approved',rejected:'Rejected'};
  return`<span class="chip ${m[s]||'chip-pending'}">${l[s]||s}</span>`;
}

function appCardHtml(a){
  const isF=a.type==='freight';
  const cfg=getConfig();
  const docDefs=isF?cfg.freight.docs:cfg.driver.docs;

  /* Build doc rows: required docs that WEREN'T uploaded are flagged missing */
  const uploaded=a.docs||[];
  const uploadedIds=uploaded.map(d=>d.id);
  const reqDefs=docDefs.filter(d=>d.status==='required');
  const missingReq=reqDefs.filter(d=>!uploadedIds.includes(d.id));

  const allDocRows=[
    /* Required docs that were uploaded */
    ...uploaded.filter(d=>{const def=docDefs.find(x=>x.id===d.id);return def&&def.status==='required';}).map(d=>{
      const def=docDefs.find(x=>x.id===d.id);
      return`<div class="doc-row"><div class="dc-chk${a.status==='approved'?' on':''}" id="chk-${a.ref}-${d.id}" onclick="tickDoc('${a.ref}','${d.id}')"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="doc-row-name">${def?def.name:d.id}</div><div class="doc-row-file">${d.filename}</div><span class="doc-row-badge badge-ok">Uploaded</span></div>`;
    }),
    /* Required docs that are MISSING */
    ...missingReq.map(d=>`<div class="doc-row missing"><div class="dc-chk" style="opacity:.4"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="doc-row-name">${d.name}</div><div class="doc-row-file">—</div><span class="doc-row-badge badge-missing">Missing</span></div>`),
    /* Optional uploaded docs */
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
  const freightExtras=isF?`
    <div class="info-row"><span class="ir-label">KNECT member</span><span class="ir-val">${a.knect?'Yes':'No'}</span></div>
    <div class="info-row"><span class="ir-label">Payment model</span><span class="ir-val">Pay upfront — no credit</span></div>
  `:'';

  const actions=(()=>{
    if(a.status==='approved')return`<button class="btn btn-gh btn-done">Approved ✓</button>`;
    if(a.status==='rejected')return`<button class="btn btn-gh btn-done">Rejected</button>`;
    const rev=a.status==='pending'?`<button class="btn btn-review" onclick="markReviewing('${a.ref}')"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Mark in review</button>`:'';
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
        <span class="chip ${isF?'chip-freight':'chip-driver'}">${isF?'Freight':'Driver'}</span>
        ${statusChip(a.status)}
        ${missingReq.length?`<span class="chip" style="background:rgba(208,64,64,.1);color:var(--rd);border:1px solid rgba(208,64,64,.2)">${missingReq.length} doc${missingReq.length!==1?'s':''} missing</span>`:''}
      </div>
      <div class="chevron"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></div>
    </div>
    <div class="app-detail">
      <div class="detail-sec">Applicant details</div>
      <div class="detail-grid">${isF?freightRows:driverRows}</div>
      ${freightExtras}
      <div class="detail-sec">Compliance documents</div>
      <div class="doc-rows">${allDocRows.join('')||'<div style="font-size:.74rem;color:var(--mu);padding:.2rem 0">No documents submitted yet.</div>'}</div>
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
function markReviewing(ref){update(ref,{status:'reviewing'});showToast('Marked as in review')}
function approve(ref){update(ref,{status:'approved',approvedAt:new Date().toISOString()});showToast('Application approved — access granted')}
function update(ref,patch){
  const q=getQueue();const i=q.findIndex(a=>a.ref===ref);if(i<0)return;
  Object.assign(q[i],patch);saveQueue(q);syncApplicant(q[i]);renderQueue();
}
function syncApplicant(app){
  const c=JSON.parse(localStorage.getItem('cp_application')||'null');
  if(c&&c.ref===app.ref)localStorage.setItem('cp_application',JSON.stringify(app));
}
function openReject(ref){rejectTarget=ref;document.getElementById('reject-reason-text').value='';document.getElementById('modal-ov').classList.add('open')}
function closeModal(){document.getElementById('modal-ov').classList.remove('open');rejectTarget=null}
function confirmReject(){
  if(!rejectTarget)return;
  const reason=document.getElementById('reject-reason-text').value.trim()||'The compliance team will be in touch with further details.';
  update(rejectTarget,{status:'rejected',rejectReason:reason,rejectedAt:new Date().toISOString()});
  closeModal();showToast('Application rejected',true);
}
document.getElementById('modal-ov').addEventListener('click',function(e){if(e.target===this)closeModal()});

/* ── SETTINGS ── */
function renderSettings(){
  const cfg=getConfig();
  const el=document.getElementById('main-content');
  el.innerHTML=`<div class="settings-panel">
    ${renderDocSection('Driver Accounts','Compliance documents required from courier and delivery drivers before their account is activated. Grounded in UK law — see the legal basis for each.',cfg,'driver')}
    ${renderDocSection('Freight Forwarder Accounts','Compliance documents required from freight forwarding businesses. Based on UK Companies House, HMRC, and insurance requirements.',cfg,'freight')}
    ${renderRebateSection(cfg)}
  </div>`;

  /* Wire dropdowns */
  cfg.driver.docs.forEach(d=>{
    document.getElementById('sel-driver-'+d.id)?.addEventListener('change',function(){updateDocSel('driver',d.id,this.value,this)});
  });
  cfg.freight.docs.forEach(d=>{
    document.getElementById('sel-freight-'+d.id)?.addEventListener('change',function(){updateDocSel('freight',d.id,this.value,this)});
  });
}

function renderDocSection(title,sub,cfg,type){
  const docs=cfg[type].docs;
  const rows=docs.map(d=>`
    <div class="dc-config-row">
      <div class="dc-config-body">
        <div class="dc-config-name">${d.name}</div>
        <div class="dc-config-legal">${d.legal}</div>
        <div class="dc-config-hint">${d.hint}</div>
      </div>
      <select id="sel-${type}-${d.id}" class="dc-sel ${d.status==='required'?'req':d.status==='hidden'?'hid':'opt'}">
        <option value="required"${d.status==='required'?' selected':''}>Required</option>
        <option value="optional"${d.status==='optional'?' selected':''}>Optional</option>
        <option value="hidden"${d.status==='hidden'?' selected':''}>Not needed</option>
      </select>
    </div>`).join('');
  return`<div class="set-section">
    <div class="set-section-head"><div class="set-section-title">${title}</div><div class="set-section-sub">${sub}</div></div>
    ${rows}
    <div class="save-row"><button class="btn-save" onclick="saveDocConfig('${type}')"><svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Save ${type} requirements</button></div>
  </div>`;
}

function renderRebateSection(cfg){
  const r=cfg.rebate||{standard:'',knect:''};
  return`<div class="set-section">
    <div class="set-section-head"><div class="set-section-title">Rebate rates — Freight Forwarders</div><div class="set-section-sub">Set the rebate percentages shown to freight forwarder applicants after approval. Leave blank to display "TBC" until confirmed.</div></div>
    <div class="rebate-fields">
      <div class="rf-row">
        <div><div class="rf-label">Standard rebate rate</div><div class="rf-sub">Applies to all freight forwarder accounts</div></div>
        <div class="rf-input-wrap"><input class="rf-input" id="rb-standard" type="text" placeholder="e.g. 3" value="${r.standard}"><span class="rf-unit">% per job</span></div>
      </div>
      <div class="rf-row">
        <div><div class="rf-label">HAF KNECT member rate</div><div class="rf-sub">Higher rate for forwarders who hold a KNECT membership</div></div>
        <div class="rf-input-wrap"><input class="rf-input" id="rb-knect" type="text" placeholder="e.g. 5" value="${r.knect}"><span class="rf-unit">% per job</span></div>
      </div>
    </div>
    <div class="save-row"><button class="btn-save" onclick="saveRebates()"><svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Save rebate rates</button></div>
  </div>`;
}

function updateDocSel(type,id,val,sel){
  sel.className='dc-sel '+(val==='required'?'req':val==='hidden'?'hid':'opt');
}

function saveDocConfig(type){
  const cfg=getConfig();
  cfg[type].docs.forEach(d=>{
    const sel=document.getElementById('sel-'+type+'-'+d.id);
    if(sel)d.status=sel.value;
  });
  saveConfig(cfg);
  showToast(type==='driver'?'Driver requirements saved':'Freight requirements saved');
}

function saveRebates(){
  const cfg=getConfig();
  cfg.rebate={standard:document.getElementById('rb-standard').value.trim(),knect:document.getElementById('rb-knect').value.trim()};
  saveConfig(cfg);
  showToast('Rebate rates saved');
}

/* ── INIT ── */
const stored=sessionStorage.getItem('cp_team_user');
if(stored){
  currentUser=JSON.parse(stored);
  document.getElementById('gate').style.display='none';
  document.getElementById('shell').classList.add('show');
  document.getElementById('welcome-name').textContent=currentUser.name;
  renderView();
}

/* Auto-refresh queue every 15s */
setInterval(()=>{if(currentTab!=='settings')renderQueue()},15000);