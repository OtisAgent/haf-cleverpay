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
  showIntegrationTab();
  loadConfig();
  loadQueue();
}
/* The Integration tab only appears for the two people who own the back-office link.
   Hiding it is presentation only — the API refuses everyone else server-side. */
const INTEGRATION_USERS=['bf638793','cleverg'];
function canIntegrate(){return !!TEAM&&INTEGRATION_USERS.includes(String(TEAM.username||'').toLowerCase())}
function showIntegrationTab(){
  const bar=document.querySelector('.tab-bar');
  const existing=document.getElementById('tab-integration');
  if(!canIntegrate()){existing?.remove();return}
  if(existing)return;
  const t=document.createElement('div');
  t.className='tab';t.id='tab-integration';t.textContent='Integration';
  t.onclick=()=>setTab('integration');
  bar.appendChild(t);
}
function doSignOut(){
  sessionStorage.removeItem('cp_team_session');
  TEAM=null;QUEUE=[];
  currentTab='pending';
  document.getElementById('tab-integration')?.remove();
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
  if(r.ok&&r.body)CFG=cpMergeConfig(r.body,DEFAULT_CONFIG);
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
  ['pending','reviewing','approved','rejected','all','settings','integration'].forEach(x=>{
    document.getElementById('tab-'+x)?.classList.toggle('active',x===t);
  });
  renderView();
}
function renderView(){
  /* the reading column is sized for cards — a record list wants the whole screen */
  document.getElementById('main-content')
    .classList.toggle('wide',LIST_TABS.includes(currentTab)&&getView(currentTab)==='list');
  if(currentTab==='settings') renderSettings();
  else if(currentTab==='integration') renderIntegration();
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

/* ── QUEUE RENDER ──
   Approved and All are the tabs that keep growing, so they default to the list
   view: one row per account, the way a CRM reads. The card view is still a click
   away on every tab. */
const LIST_TABS=['pending','approved','all'];
/* New Applications is the tab the team WORKS in, so it keeps its cards by default
   and remembers its own preference — the reference tabs default to the list. */
const SECTION_TAB='pending';
const viewKey=t=>t===SECTION_TAB?'cp_view_pending':'cp_view';
function getView(t){return localStorage.getItem(viewKey(t))||(t===SECTION_TAB?'cards':'list')}
let crmSearch='';
let crmSort={key:'submitted',dir:-1};
let crmOpen=null;

function setView(v){
  localStorage.setItem(viewKey(currentTab),v);
  renderView();
}
function setCrmSearch(v){
  crmSearch=v;
  renderQueue();
  const box=document.getElementById('crm-search');
  if(box){box.focus();box.setSelectionRange(box.value.length,box.value.length);}
}
function setCrmSort(k){
  if(crmSort.key===k)crmSort.dir=-crmSort.dir;
  else crmSort={key:k,dir:k==='submitted'?-1:1};
  renderQueue();
}

/* ── NEW APPLICATIONS SECTIONS ──
   Brent, 31 Jul: the working tab reads as a to-do list, not one long pile. Today's
   arrivals first, then the ones somebody here has already opened and that are still
   waiting on the applicant, then the rest. "Opened" is recorded on the record itself
   (viewed_at / viewed_by) the first time any team member expands it, so it is the
   team's shared knowledge, not one browser's. */
function pendingSections(list){
  const now=new Date();
  const sameDay=d=>{const x=new Date(d);return x.getDate()===now.getDate()&&x.getMonth()===now.getMonth()&&x.getFullYear()===now.getFullYear()};
  const isNew=a=>a.submitted&&sameDay(a.submitted);
  const noDocs=a=>!(Array.isArray(a.docs)&&a.docs.length);
  const rest=list.filter(a=>!isNew(a));
  const seenNoDocs=a=>a.viewed_at&&noDocs(a);
  return[
    {t:'New today',rows:list.filter(isNew),e:'Nothing new has come in today yet.'},
    {t:'Seen by the team — no documents yet',rows:rest.filter(seenNoDocs),e:'Nothing here — every application someone has opened has documents on it.'},
    {t:'Everything else waiting',rows:rest.filter(a=>!seenNoDocs(a)),e:'Nothing else is waiting.'},
  ];
}

function renderQueue(){
  const q=QUEUE;
  updateKPIs(q);
  const filtered=currentTab==='all'?q:q.filter(a=>a.status===currentTab||(currentTab==='pending'&&a.status==='enquiry'));
  const el=document.getElementById('main-content');
  const mode=getView(currentTab);
  if(!filtered.length){
    el.innerHTML=`<div class="empty"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>No ${currentTab==='all'?'':currentTab} applications yet.</div>`;
    return;
  }
  /* the working tab: same records, grouped under headings */
  if(currentTab===SECTION_TAB){
    const rows=filtered.filter(a=>crmMatch(a,crmSearch));
    const secs=pendingSections(rows);
    el.innerHTML=viewSwitchHtml()+listToolsHtml(rows.length,filtered.length)+secs.map(s=>
      `<div class="qsec">
        <div class="sec-head"><span class="sec-t">${s.t}</span><span class="sec-n">${s.rows.length}</span></div>
        ${s.rows.length?(mode==='list'?crmTableHtml(s.rows):`<div class="app-list">${s.rows.map(a=>appCardHtml(a)).join('')}</div>`)
          :`<div class="sec-empty">${s.e}</div>`}
      </div>`).join('');
    if(mode!=='list')rows.forEach(a=>{
      document.getElementById('head-'+a.ref)?.addEventListener('click',()=>toggleCard(a.ref));
    });
    return;
  }
  if(LIST_TABS.includes(currentTab)&&mode==='list'){renderCrm(filtered);return;}
  el.innerHTML=`${LIST_TABS.includes(currentTab)?viewSwitchHtml():''}<div class="app-list">${filtered.map(a=>appCardHtml(a)).join('')}</div>`;
  filtered.forEach(a=>{
    document.getElementById('head-'+a.ref)?.addEventListener('click',()=>toggleCard(a.ref));
  });
}

/* ── CRM LIST VIEW ── */
function viewSwitchHtml(){
  const mode=getView(currentTab);
  const b=(v,label,icon)=>`<button class="vs-btn${mode===v?' on':''}" onclick="setView('${v}')" title="${label} view"><svg viewBox="0 0 24 24">${icon}</svg>${label}</button>`;
  return`<div class="view-switch">
    ${b('list','List','<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>')}
    ${b('cards','Cards','<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/>')}
  </div>`;
}

/* ── what a record says beyond "approved" ──
   Clever Checked is the compliance verdict; the network state is what happened
   AFTER it — the account only goes green once its HAF KNECT membership activates
   (activated_at, set by the activation job). Both read off the record, never a guess. */
function netState(a){
  if(a.activated_at)return{c:'net-on',t:'Active',s:4,ti:'Active in the HAF network since '+fmtDate(a.activated_at)};
  if(a.membership_paid_at)return{c:'net-mid',t:'Activating',s:3,ti:'Membership paid '+fmtDate(a.membership_paid_at)+' — activation still to run'};
  if(a.status==='approved')return{c:'net-off',t:'Not joined',s:2,ti:'Clever Checked, but no HAF KNECT membership yet'};
  if(a.status==='blocked')return{c:'net-no',t:'Blocked',s:0,ti:'Refused all access'};
  return{c:'net-none',t:'—',s:1,ti:'Not in the network'};
}
function fmtDay(iso){return iso?new Date(iso).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'—'}
function money(p,cur){
  if(p===null||p===undefined)return'';
  const sym=(cur||'gbp').toLowerCase()==='gbp'?'£':'';
  return sym+(p/100).toFixed(2).replace(/\.00$/,'');
}

/* Columns sit to the right of the username and reference — the two things the team
   searches by — so a row reads left to right like a record, not a card. `on` is what
   shows out of the box; the Columns button turns the rest on per person. */
const CRM_COLS=[
  {k:'username',t:'Username',on:1,s:a=>a.username||'',v:a=>`<span class="c-user">${a.username||'—'}</span>`},
  {k:'ref',t:'Reference',on:1,s:a=>a.ref||'',v:a=>`<span class="c-ref">${a.ref}</span>`},
  {k:'name',t:'Name',on:1,s:a=>displayName(a).toLowerCase(),v:a=>`<span class="c-name">${displayName(a)}</span>`},
  {k:'type',t:'Account',on:1,sm:1,s:a=>a.type||'',v:a=>{
    const isB=a.type==='business',isF=a.type==='freight';
    return`<span class="chip ${isB?'chip-business':isF?'chip-freight':'chip-driver'}">${isB?'Business':isF?'Freight':'Driver'}</span>`;}},
  {k:'status',t:'Status',on:1,s:a=>a.status||'',v:a=>statusChip(a.status)},
  {k:'checked',t:'Clever Checked',on:1,sm:1,s:a=>a.status==='approved'?(new Date(a.approved_at||0).getTime()||1):0,v:a=>{
    if(a.status==='approved')return`<span class="cc-on" title="Passed the CleverPay compliance check${a.approved_at?' on '+fmtDate(a.approved_at):''}"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>${a.approved_at?fmtDay(a.approved_at):'Checked'}</span>`;
    if(a.status==='reviewing')return'<span class="c-no">Being checked</span>';
    if(a.status==='rejected')return`<span class="c-miss" title="${(a.reject_reason||a.rejectReason||'').replace(/"/g,'&quot;')}">Not passed</span>`;
    if(a.status==='blocked')return'<span class="c-miss">Blocked</span>';
    return'<span class="c-dim">Not yet</span>';}},
  {k:'network',t:'In the network',on:1,sm:1,s:a=>netState(a).s,v:a=>{
    const n=netState(a);
    return n.t==='—'?'<span class="c-dim">—</span>':`<span class="npill ${n.c}" title="${n.ti}">${n.t}</span>`;}},
  {k:'email',t:'Email',on:1,sm:1,s:a=>(a.email||'').toLowerCase(),v:a=>`<span class="c-dim">${a.email||'—'}</span>`},
  {k:'verified',t:'Confirmed',on:1,sm:1,s:a=>a.type==='business'?2:(a.email_verified?1:0),v:a=>
    a.type==='business'?'<span class="c-dim">—</span>'
    :(a.email_verified?`<span class="c-yes" title="${a.email_verified_at?'Confirmed '+fmtDate(a.email_verified_at):'Confirmed'}">Yes</span>`:'<span class="c-no">No</span>')},
  {k:'phone',t:'Phone',on:1,sm:1,s:a=>a.phone||'',v:a=>`<span class="c-dim">${a.phone||'—'}</span>`},
  {k:'docs',t:'Documents',on:1,sm:1,s:a=>appCompliance(a).missingReq.length,v:a=>{
    if(a.type==='business')return'<span class="c-dim">—</span>';
    const{missingReq,uploaded}=appCompliance(a);
    if(!uploaded.length&&missingReq.length)return`<span class="c-miss">None yet · ${missingReq.length} needed</span>`;
    return missingReq.length
      ?`<span class="c-miss">${uploaded.length} in · ${missingReq.length} missing</span>`
      :`<span class="c-yes">All ${uploaded.length} in</span>`;}},
  {k:'vehicle',t:'Vehicle',on:1,sm:1,s:a=>(a.vtype||'').toLowerCase(),v:a=>
    a.type!=='driver'?'<span class="c-dim">—</span>'
    :`<span class="c-dim">${a.vtype||'Not given'}${a.vreg?` · <span class="c-reg">${a.vreg}</span>`:''}</span>`},
  {k:'knect',t:'KNECT',sm:1,s:a=>a.knect?1:0,v:a=>a.knect?'<span class="c-yes">Member</span>':'<span class="c-dim">—</span>'},
  {k:'membership',t:'Membership',sm:1,s:a=>new Date(a.membership_paid_at||0).getTime()||0,v:a=>
    a.membership_paid_at
      ?`<span class="c-yes" title="Paid ${fmtDate(a.membership_paid_at)}">${money(a.membership_amount,a.membership_currency)||'Paid'} · ${fmtDay(a.membership_paid_at)}</span>`
      :'<span class="c-dim">Not paid</span>'},
  {k:'promo',t:'Promo / Founders',sm:1,s:a=>(a.promo_code||a.founders_tier||'').toLowerCase(),v:a=>{
    const bits=[a.promo_code,a.founders_tier].filter(Boolean);
    return bits.length?`<span class="c-dim">${bits.join(' · ')}</span>`:'<span class="c-dim">—</span>';}},
  {k:'crn',t:'Company no.',sm:1,s:a=>a.crn||'',v:a=>a.crn?`<span class="c-ref">${a.crn}</span>`:'<span class="c-dim">—</span>'},
  {k:'source',t:'Source',sm:1,s:a=>a.added_by||'',v:a=>a.added_by
    ?`<span class="c-dim" title="Added by hand in this portal">Added by ${a.added_by}</span>`
    :'<span class="c-dim">Signed up online</span>'},
  {k:'seen',t:'Opened by',sm:1,s:a=>new Date(a.viewed_at||0).getTime()||0,v:a=>a.viewed_at
    ?`<span class="c-dim" title="First opened ${fmtDate(a.viewed_at)}">${a.viewed_by||'team'} · ${fmtDay(a.viewed_at)}</span>`
    :'<span class="c-no">Not opened</span>'},
  {k:'submitted',t:'Submitted',on:1,sm:1,s:a=>new Date(a.submitted||0).getTime()||0,v:a=>`<span class="c-dim">${fmtDate(a.submitted)}</span>`},
  {k:'updated',t:'Last change',sm:1,s:a=>new Date(a.updated_at||0).getTime()||0,v:a=>`<span class="c-dim">${a.updated_at?fmtDate(a.updated_at):'—'}</span>`},
];

/* Which columns show is a per-person choice, kept in this browser. Falling back to
   the `on` set means a new column added later just appears for everyone. */
let crmCols=(()=>{try{const s=JSON.parse(localStorage.getItem('cp_cols')||'null');return Array.isArray(s)&&s.length?s:null}catch(e){return null}})();
let colMenuOpen=false;
function activeCols(){return crmCols?CRM_COLS.filter(c=>crmCols.includes(c.k)):CRM_COLS.filter(c=>c.on)}
function toggleCol(k){
  const cur=activeCols().map(c=>c.k);
  const next=cur.includes(k)?cur.filter(x=>x!==k):CRM_COLS.filter(c=>cur.includes(c.k)||c.k===k).map(c=>c.k);
  if(!next.length){showToast('Keep at least one column',true);return}
  crmCols=next;localStorage.setItem('cp_cols',JSON.stringify(next));
  renderQueue();
}
function resetCols(){crmCols=null;localStorage.removeItem('cp_cols');renderQueue()}
function toggleColMenu(){colMenuOpen=!colMenuOpen;renderQueue()}
function colMenuHtml(){
  const on=activeCols().map(c=>c.k);
  return`<div class="col-pick">
    <button class="vs-btn${colMenuOpen?' on':''}" onclick="toggleColMenu()" title="Choose what the columns show">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>Columns · ${on.length}
    </button>
    ${colMenuOpen?`<div class="col-menu">
      <div class="col-menu-h">Show in the list</div>
      ${CRM_COLS.map(c=>`<label class="col-opt${on.includes(c.k)?' on':''}" onclick="event.preventDefault();toggleCol('${c.k}')">
        <span class="col-box"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></span>${c.t}</label>`).join('')}
      <div class="col-menu-f"><button onclick="resetCols()">Back to the standard columns</button></div>
    </div>`:''}
  </div>`;
}

function crmMatch(a,term){
  if(!term)return true;
  const t=term.toLowerCase();
  return[a.username,a.ref,displayName(a),a.email,a.phone,a.company,a.fname,a.lname]
    .some(x=>(x||'').toString().toLowerCase().includes(t));
}

function listToolsHtml(shown,total){
  return`<div class="list-tools">
      <div class="list-search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="crm-search" type="text" placeholder="Search name, username, reference, email or phone" value="${crmSearch.replace(/"/g,'&quot;')}" oninput="setCrmSearch(this.value)">
      </div>
      ${getView(currentTab)==='list'?colMenuHtml():''}
      <div class="list-count">${shown} of ${total}</div>
    </div>`;
}

/* One table, already filtered. Used on its own for Approved and All, and once per
   section on New Applications. */
function crmTableHtml(list){
  const cols=activeCols();
  const rows=list.slice();
  const col=cols.find(c=>c.k===crmSort.key)||CRM_COLS.find(c=>c.k===crmSort.key)||cols[cols.length-1];
  rows.sort((x,y)=>{
    const a=col.s(x),b=col.s(y);
    return(a<b?-1:a>b?1:0)*crmSort.dir;
  });

  const arrow=k=>crmSort.key===k?`<span class="th-ar">${crmSort.dir===1?'▲':'▼'}</span>`:'';
  const head=cols.map((c,i)=>`<th class="${c.sm?'sm-hide ':''}${i===0?'stick1 ':''}th-${c.k}" onclick="setCrmSort('${c.k}')" title="Sort by ${c.t}">${c.t}${arrow(c.k)}</th>`).join('');
  const span=cols.length+2;

  /* an approval re-renders the whole list — the row the reviewer had open stays open */
  const body=rows.map((a,i)=>{
    const op=a.ref===crmOpen?' open':'';
    return`
    <tr class="r ${i%2?'row-b':'row-a'}${op}" id="row-${a.ref}" onclick="toggleRow('${a.ref}')">
      <td class="num">${i+1}</td>
      ${cols.map((c,j)=>`<td class="td-${c.k}${c.sm?' sm-hide':''}${j===0?' stick1':''}">${c.v(a)}</td>`).join('')}
      <td class="chev"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></td>
    </tr>
    <tr class="det ${i%2?'row-b':'row-a'}${op}" id="det-${a.ref}"><td colspan="${span}"><div class="det-box">${appDetailHtml(a)}</div></td></tr>`;
  }).join('');

  return`<div class="crm-wrap"><table class="crm">
      <thead><tr><th class="num">#</th>${head}<th class="chev"></th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

function renderCrm(list){
  const rows=list.filter(a=>crmMatch(a,crmSearch));
  document.getElementById('main-content').innerHTML=`
    ${viewSwitchHtml()}
    ${listToolsHtml(rows.length,list.length)}
    ${rows.length?crmTableHtml(rows)
    :`<div class="empty"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Nothing matches "${crmSearch}".</div>`}`;
}

/* One row open at a time — the same rule the cards follow. */
function toggleRow(ref){
  const row=document.getElementById('row-'+ref);
  const det=document.getElementById('det-'+ref);
  if(!row||!det)return;
  const was=row.classList.contains('open');
  document.querySelectorAll('.crm tr.open').forEach(x=>x.classList.remove('open'));
  crmOpen=was?null:ref;
  if(!was){row.classList.add('open');det.classList.add('open');markSeen(ref);}
}

/* ── "somebody here has looked at this" ──
   Recorded on the record the first time any team member opens it, through a database
   function that checks their session — so it is the team's shared knowledge and one
   browser's history can never fake it. Never blocks the reviewer: if the write fails
   the record simply stays unopened. */
async function markSeen(ref){
  const a=QUEUE.find(x=>x.ref===ref);
  if(!a||a.viewed_at||!TEAM)return;
  a.viewed_at=new Date().toISOString();
  a.viewed_by=TEAM.username;
  try{
    const r=await fetch(SB_URL+'/rest/v1/rpc/cleverpay_team_mark_seen',{
      method:'POST',
      headers:{'Content-Type':'application/json',apikey:SB_ANON,Authorization:'Bearer '+SB_ANON},
      body:JSON.stringify({p_ref:ref,p_token:TEAM.token})
    });
    if(!r.ok){a.viewed_at=null;a.viewed_by=null;}
  }catch(e){a.viewed_at=null;a.viewed_by=null;}
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

/* Compliance rows and the detail panel are shared by the card view and the list
   view, so they live in their own functions rather than inside the card. */
function appCompliance(a){
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
  return{isF,isB,docDefs,uploaded,reqDefs,missingReq,allDocRows};
}

function appDetailHtml(a){
  const{isF,isB,allDocRows,missingReq}=appCompliance(a);

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
    /* Nothing can be processed until the paperwork is in, so the queue chases it from
       here instead of someone remembering to write the email by hand. */
    const remindBtn=(()=>{
      if(isB||!missingReq.length||!a.email)return'';
      const n=missingReq.length;
      const last=a.reminder_requested_at||a.reminder_sent_at;
      if(last&&(Date.now()-Date.parse(last))<20*3600e3)
        return`<button class="btn btn-gh" disabled title="Reminded ${fmtDate(last)}${a.reminder_by?' by '+a.reminder_by:''} — the next one can go tomorrow"><svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Reminded today</button>`;
      return`<button class="btn btn-remind" onclick="openRemind('${a.ref}')" title="Email them a link to upload the ${n} document${n!==1?'s':''} we are still waiting on"><svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Send document reminder</button>`;
    })();
    const rev=(a.status==='pending'||a.status==='enquiry')?`<button class="btn btn-review" onclick="markReviewing('${a.ref}')"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Mark in review</button>`:'';
    return`${rev}${remindBtn}${emailBtn}<button class="btn btn-approve" onclick="approve('${a.ref}')"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Approve</button><button class="btn btn-reject" onclick="openReject('${a.ref}')"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Reject</button>${blockBtn}`;
  })();

  return`<div class="detail-sec">${isB?'Enquiry details':'Applicant details'}</div>
    <div class="detail-grid">${isB?businessRows:isF?freightRows:driverRows}</div>
    ${freightExtras}
    ${isB?'':`<div class="detail-sec">Compliance documents</div>
    <div class="doc-rows">${allDocRows.join('')||'<div style="font-size:.74rem;color:var(--mu);padding:.2rem 0">No documents submitted yet.</div>'}</div>`}
    <div class="detail-sec">Actions</div>
    <div class="action-bar">${actions}</div>`;
}

function appCardHtml(a){
  const{isF,isB,missingReq}=appCompliance(a);
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
        ${(()=>{const n=netState(a);return n.t==='—'?'':`<span class="npill ${n.c}" title="${n.ti}">${n.t}</span>`})()}
        ${a.added_by?`<span class="chip chip-reviewing" title="Added manually by the HAF team">Added by ${a.added_by}</span>`:''}
        ${a.viewed_at?`<span class="chip chip-seen" title="First opened ${fmtDate(a.viewed_at)}">Opened by ${a.viewed_by||'the team'}</span>`:''}
        ${missingReq.length?`<span class="chip" style="background:rgba(208,64,64,.1);color:var(--rd);border:1px solid rgba(208,64,64,.2)">${missingReq.length} doc${missingReq.length!==1?'s':''} missing</span>`:''}
        ${a.reminder_requested_at?`<span class="chip chip-seen" title="Document reminder sent ${fmtDate(a.reminder_requested_at)}${a.reminder_by?' by '+a.reminder_by:''}${a.reminder_count>1?' · '+a.reminder_count+' in total':''}">Reminded ${fmtDate(a.reminder_requested_at)}</span>`:''}
      </div>
      <div class="chevron"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></div>
    </div>
    <div class="app-detail">${appDetailHtml(a)}</div>
  </div>`;
}

/* ── ACTIONS ── */
function toggleCard(ref){
  const c=document.getElementById('card-'+ref);
  const was=c.classList.contains('expanded');
  document.querySelectorAll('.app-card.expanded').forEach(x=>x.classList.remove('expanded'));
  if(!was){c.classList.add('expanded');markSeen(ref);}
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
/* ── DOCUMENT REMINDER ──
   The reviewer confirms the address and the exact list before anything leaves the
   building — an applicant chased for a document they already sent stops trusting us. */
let remindTarget=null;
function openRemind(ref){
  const a=QUEUE.find(x=>x.ref===ref);if(!a)return;
  const{missingReq}=appCompliance(a);
  remindTarget=ref;
  document.getElementById('rm-who').textContent=displayName(a);
  document.getElementById('rm-email').textContent=a.email||'no email on file';
  document.getElementById('rm-list').innerHTML=missingReq.map(d=>`<li>${d.name}</li>`).join('');
  document.getElementById('rm-go').disabled=false;
  document.getElementById('rm-ov').classList.add('open');
}
function closeRemind(){document.getElementById('rm-ov').classList.remove('open');remindTarget=null}
async function confirmRemind(){
  const ref=remindTarget;if(!ref)return;
  const go=document.getElementById('rm-go');
  go.disabled=true;go.textContent='Sending…';
  const r=await cpApi('/team/remind',{method:'POST',body:{ref},token:TEAM.token});
  go.textContent='Send the reminder';
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return}
  if(!r.ok){go.disabled=false;showToast(r.body?.error||'Could not send that reminder — try again',true);return}
  const i=QUEUE.findIndex(a=>a.ref===ref);
  if(i>=0&&r.body.app)QUEUE[i]={...r.body.app,rejectReason:r.body.app.reject_reason};
  closeRemind();
  renderQueue();
  showToast(`Reminder on its way to ${r.body.email}`);
}
document.getElementById('rm-ov').addEventListener('click',function(e){if(e.target===this)closeRemind()});

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

/* ══ INTEGRATION — the back-office link (Brent and Gemma only) ══
   Everything here is read from the API, which checks who is asking. If a browser
   ever showed this panel to the wrong person they would still get nothing back. */
let INTEG=null;

function fmtAgo(iso){
  if(!iso)return'never';
  const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(s<60)return'just now';
  if(s<3600)return Math.floor(s/60)+' min ago';
  if(s<86400)return Math.floor(s/3600)+' hr ago';
  return fmtDate(iso);
}

async function renderIntegration(){
  const el=document.getElementById('main-content');
  if(!INTEG)el.innerHTML='<div class="empty">Checking the back-office link…</div>';
  const r=await cpApi('/team/integration',{token:TEAM.token});
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return}
  if(!r.ok){
    el.innerHTML='<div class="empty">This area isn’t available on your login.</div>';
    return;
  }
  INTEG=r.body;
  drawIntegration();
}

function drawIntegration(){
  const d=INTEG,k=d.key;
  /* "working" means both halves are true: our side answered, and a key exists for
     the back office to use. A green light with no key would be a lie. */
  const live=d.live&&!!k;
  const dot=live?'ig-ok':(d.live?'ig-warn':'ig-bad');
  const line=!d.live
    ?'Not working — we can’t reach the compliance records right now.'
    :(!k?'No key yet — the back office can’t connect until you generate one.'
        :'Working — the back office can connect.');
  const lastTalk=k?(k.last_used_at?`Last used ${fmtAgo(k.last_used_at)} · ${k.use_count} request${k.use_count===1?'':'s'} in total`:'Not used yet — the back office hasn’t called us with this key.'):'';

  document.getElementById('main-content').innerHTML=`
  <div class="ig-wrap">
    <div class="ig-card">
      <div class="ig-status"><span class="ig-dot ${dot}"></span><div>
        <div class="ig-status-t">${line}</div>
        <div class="ig-status-s">${lastTalk?lastTalk+' · ':''}Checked ${fmtAgo(d.checked_at)}</div>
      </div><button class="btn btn-gh" onclick="INTEG=null;renderIntegration()">Re-check</button></div>
    </div>

    <div class="ig-card">
      <div class="ig-h">Back-office address</div>
      <div class="ig-p">Give this to the back office along with the key. It is not linked anywhere and only answers to a valid key.</div>
      <div class="ig-copy"><code id="ig-ep">${d.endpoint}</code>
        <button class="btn btn-gh" onclick="igCopy('${d.endpoint}',this)">Copy</button></div>
    </div>

    <div class="ig-card">
      <div class="ig-h">Access key</div>
      ${k?`
        <div class="ig-krow">
          <div><div class="ig-klabel">Current key</div><div class="ig-kval">${k.prefix}…</div></div>
          <div><div class="ig-klabel">Created</div><div class="ig-kv2">${fmtDate(k.created_at)} by ${k.created_by}</div></div>
        </div>
        <div class="ig-p">Only the first few characters are kept — the full key was shown once when it was made. If it has been lost or shared by mistake, replace it.</div>
        <div class="ig-btns">
          <button class="btn btn-review" onclick="igRotate()">Replace key</button>
          <button class="btn btn-reject" onclick="igRevoke()">Switch off access</button>
        </div>`
      :`<div class="ig-p">There is no key yet. Generating one lets the back office read compliance status — and nothing else.</div>
        <div class="ig-btns"><button class="btn btn-approve" onclick="igRotate()">Generate key</button></div>`}
    </div>

    <div class="ig-card">
      <div class="ig-h">What the back office can see</div>
      <div class="ig-p">Only these, for each account:</div>
      <div class="ig-fields">${(d.shares||[]).map(s=>`<span class="ig-field">${s}</span>`).join('')}</div>
      <div class="ig-note">No documents, no bank or payment details, and no phone numbers or email addresses ever leave through this link.</div>
    </div>
  </div>`;
}

function igCopy(txt,btn){
  navigator.clipboard?.writeText(txt).then(()=>{
    const was=btn.textContent;btn.textContent='Copied';setTimeout(()=>{btn.textContent=was},1600);
  },()=>showToast('Couldn’t copy — select the text and copy it manually',true));
}

async function igRotate(){
  const replacing=!!INTEG?.key;
  if(replacing&&!confirm('Replace the current key?\n\nThe old key stops working immediately, so the back office will be cut off until someone gives them the new one.'))return;
  const r=await cpApi('/team/integration/key',{method:'POST',token:TEAM.token,body:{}});
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return}
  if(!r.ok){showToast(r.body?.error||'Could not create the key',true);return}
  igShowKey(r.body.key,replacing);
  INTEG=null;renderIntegration();
}

async function igRevoke(){
  if(!confirm('Switch off the back-office link?\n\nThe key stops working straight away and the back office will not be able to read anything until a new key is generated.'))return;
  const r=await cpApi('/team/integration/revoke',{method:'POST',token:TEAM.token,body:{}});
  if(!r.ok){showToast(r.body?.error||'Could not switch it off',true);return}
  showToast('Back-office access switched off');
  INTEG=null;renderIntegration();
}

/* the one and only time the key is ever visible */
function igShowKey(key,replaced){
  document.getElementById('ig-key-title').textContent=replaced?'Your new key':'Your key';
  document.getElementById('ig-key-val').textContent=key;
  document.getElementById('ig-key-copy').onclick=function(){igCopy(key,this)};
  document.getElementById('ig-key-ov').classList.add('open');
}
/* wipe it from the page as well as from view — once it's closed it's gone */
function igCloseKey(){
  document.getElementById('ig-key-ov').classList.remove('open');
  document.getElementById('ig-key-val').textContent='';
  document.getElementById('ig-key-copy').onclick=null;
}

/* ── INIT ── */
const stored=sessionStorage.getItem('cp_team_session');
if(stored){
  TEAM=JSON.parse(stored);
  if(TEAM.mustSetPin)showSetPin();else enterShell();
}

/* Auto-refresh queue every 15s — never while Settings or Integration is open,
   so a refresh can't wipe a key the user has just been shown */
setInterval(()=>{if(TEAM&&currentTab!=='settings'&&currentTab!=='integration')loadQueue(true)},15000);
