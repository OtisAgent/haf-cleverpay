/* Team sign-in is verified server-side by the CleverPay API — no passwords live in this code. */

/* ── DEFAULT COMPLIANCE CONFIG (fallback if the live config can't be reached) ── */
/* Based on UK regulatory research (Road Traffic Act 1988, Employers' Liability Act 1969, etc.) */
const DEFAULT_CONFIG = {
  driver: {
    docs: [
      {id:'dl-front',     name:'Driving licence — front',        hint:'Front of DVLA photocard. Must show appropriate category (B for vans, C1 for 3.5–7.5T, C for HGV).',                     legal:'Road Traffic Act 1988, s.87 — criminal offence to drive without valid licence',                            status:'required'},
      {id:'dl-back',      name:'Driving licence — back',         hint:'Back of photocard showing vehicle categories and any restrictions.',                                                      legal:'Road Traffic Act 1988, s.87',                                                                             status:'required'},
      {id:'h-r-ins',      name:'Hire & Reward insurance',        hint:'Specific courier/delivery policy. Standard business use does NOT cover paid delivery work.',                              legal:'Road Traffic Act 1988, s.143 — criminal offence. £300 fine + 6 points + possible disqualification',      status:'required'},
      {id:'mot',          name:'MOT certificate',                hint:'Current and valid. Required annually from 3 years after first registration. Driving without valid MOT also voids insurance.', legal:'Road Traffic Act 1988, s.47 — offence to drive vehicle over 3 years old without valid MOT',              status:'required'},
      {id:'right-work',   name:'Right to work evidence',         hint:'UK/Irish passport, biometric residence permit, or Home Office online share code.',                                         legal:'Immigration, Asylum and Nationality Act 2006 — up to £60,000 penalty per illegal worker',               status:'required'},
      {id:'git-ins',      name:'Goods in Transit insurance',     hint:'Covers clients\' cargo for theft, loss or damage while in transit. Min £10,000 recommended; most contracts require more.', legal:'Contractually required by most courier network contracts (DPD, Evri, Amazon Flex, HAF)',                status:'optional'},
      {id:'pub-liability',name:'Public liability insurance',     hint:'Min £1 million per claim. Covers injury or property damage to third parties from work activities.',                         legal:'Contractually required by most platforms and commercial clients',                                        status:'optional'},
      {id:'dbs',          name:'DBS check certificate',          hint:'Basic DBS disclosing unspent convictions. Enhanced + Barred List required for deliveries to schools/care homes.',          legal:'Standard delivery: best practice. Regulated activity: mandatory under Safeguarding Vulnerable Groups Act 2006', status:'optional'},
      {id:'hmrc-utr',     name:'HMRC self-employment registration', hint:'UTR (Unique Taxpayer Reference) — 10-digit number from HMRC confirming self-employed status.',                          legal:'Taxes Management Act 1970 — must notify HMRC of self-employment',                                       status:'optional'},
      {id:'driver-cpc',   name:'Driver CPC / DQC card',          hint:'Required only for drivers of vehicles over 3,500kg (Category C1/C lorries). NOT needed for standard van drivers.',        legal:'Road Traffic (Driver Licensing) Act 1989 — HGV/lorry drivers only',                                     status:'optional'},
      {id:'operator-lic', name:"Operator's licence",             hint:'Required for vehicles over 3,500kg used for hire-and-reward. Standard National for UK work; Standard International for EU.', legal:"Goods Vehicles (Licensing of Operators) Act 1995 — HGV only",                                       status:'optional'},
    ]
  },
  freight: {
    docs: [
      {id:'incorp',       name:'Certificate of Incorporation',   hint:'Companies House certificate confirming the business is legally registered as a UK company.',                              legal:'Companies Act 2006 — mandatory for limited companies',                                                   status:'required'},
      {id:'pub-liability',name:'Public liability insurance',     hint:'Min £1 million per claim. GOV.UK freight guidance states all forwarders should hold this.',                               legal:"GOV.UK Freight forwarding: managing risk — mandatory in practice for all freight businesses",            status:'required'},
      {id:'emp-liability',name:"Employer's liability insurance", hint:'Min £5 million cover per claim. Required if the company employs anyone — even one person.',                               legal:"Employers' Liability (Compulsory Insurance) Act 1969 — criminal offence not to hold it (£2,500/day fine)", status:'required'},
      {id:'biz-address',  name:'Proof of business address',      hint:'Utility bill or bank letter dated within 3 months. Must show the registered trading address.',                            legal:'KYC/AML due diligence — Money Laundering Regulations 2017',                                             status:'required'},
      {id:'eori',         name:'EORI number confirmation',       hint:'GB EORI number from HMRC. Required for any business making customs declarations or importing/exporting.',                  legal:'Taxation (Cross-border Trade) Act 2018 — mandatory for customs declarations',                            status:'optional'},
      {id:'prof-indem',   name:'Professional indemnity insurance', hint:'Covers claims from errors, omissions or negligent customs/logistics advice causing client financial loss.',              legal:'Contractually required by most clients; condition of BIFA membership',                                   status:'optional'},
      {id:'git-cargo',    name:'Goods in Transit / cargo insurance', hint:'Covers clients\' cargo for loss, theft or damage while in the forwarder\'s care. Required under BIFA STCs.',          legal:'BIFA Standard Trading Conditions 2025; GOV.UK freight forwarding guidance',                              status:'optional'},
      {id:'cmr-ins',      name:'CMR insurance certificate',      hint:'Required for international road freight. Covers statutory CMR liability (8.33 SDR per kg if goods lost or damaged).',     legal:'Carriage of Goods by Road Act 1965 — mandatory for international road carriage',                        status:'optional'},
      {id:'vat-cert',     name:'VAT registration certificate',   hint:'Required if VAT registered. Threshold from April 2024: £90,000 taxable turnover in any 12-month period.',                legal:'Value Added Tax Act 1994',                                                                               status:'optional'},
      {id:'bifa',         name:'BIFA membership certificate',    hint:'British International Freight Association membership. Industry standard, expected by most major clients.',                 legal:'Best practice; expected by contractual counterparties; limits liability under BIFA STCs 2025',           status:'optional'},
      /* Proof of person — identity of the human behind the business, for profile building */
      {id:'id-passport',  name:'Passport — proof of person',     hint:'Photo page of the passport of the director, owner or named contact. Confirms who is actually behind the business.',          legal:'Money Laundering Regulations 2017, reg. 28 — identify and verify the beneficial owner',                 status:'optional'},
      {id:'id-licence',   name:'Driving licence — proof of person', hint:'Photocard of the director, owner or named contact. Accepted in place of a passport as photographic ID.',                 legal:'Money Laundering Regulations 2017, reg. 28 — accepted photographic identity evidence',                  status:'optional'},
      {id:'id-utility',   name:'Utility bill — proof of person', hint:'Gas, electricity, water, broadband or council tax bill dated within 3 months, in that person\'s own name at their home address.', legal:'Money Laundering Regulations 2017, reg. 28 — address verification of the beneficial owner',          status:'optional'},
    ]
  },
  rebate: {standard: '', knect: ''},
  /* ── the official checks, per account type ──
     Saving this screen writes the WHOLE config back, so anything missing from
     the fallback is silently dropped the first time somebody saves a document
     list on a page whose config never loaded. That is how a switch disappears
     with nobody touching it, so the checks live in the fallback too.
     Off for drivers by default: a driver is a person, not a company. VAT off
     everywhere until HMRC credentials exist — a check switched on with no way
     to run reads as a failure. */
  checks: {
    company:  {business: true,  fleet: true,  freight: true,  driver: false},
    director: {business: true,  fleet: true,  freight: true,  driver: false},
    vat:      {business: false, fleet: false, freight: false, driver: false}
  }
};

/* ── VERIFICATION SETTINGS ───────────────────────────────────────────────────
   Gemma's. Three official checks down the side, four account types across, and
   her Companies House key at the top. Everything here is hers to change without
   asking anyone, which is the whole point: a compliance rule she cannot alter
   herself is a rule that ends up being asked of me at 11pm. */
const CHECK_ROWS=[
  {key:'company', name:'Company on the register',
   why:'Confirms the company number is real, the name matches the register, and the company has not been dissolved. Companies House, free.'},
  {key:'director', name:'Named person is a director',
   why:'Confirms the person opening the account is an active officer of that company, and whether they have verified their identity with Companies House (the duty that began November 2025).'},
  {key:'vat', name:'VAT number with HMRC',
   why:'Confirms the VAT number belongs to that business. Needs HMRC credentials, which take about a fortnight to come through.'},
];
const CHECK_TYPES=[
  {key:'business', label:'Business'},
  {key:'fleet',    label:'Fleet'},
  {key:'freight',  label:'Find a Courier'},
  {key:'driver',   label:'Driver'},
];

function renderVerifySection(cfg){
  const ch=cfg.checks||{};
  const head=CHECK_TYPES.map(t=>`<div class="vf-head" style="text-align:center">${t.label}</div>`).join('');
  const rows=CHECK_ROWS.map(r=>{
    const boxes=CHECK_TYPES.map(t=>{
      const on=!!(ch[r.key]&&ch[r.key][t.key]===true);
      return`<div style="text-align:center"><input type="checkbox" id="vf-${r.key}-${t.key}"${on?' checked':''}></div>`;
    }).join('');
    return`<div class="vf-name">${r.name}</div>${boxes}<div class="vf-why">${r.why}</div>`;
  }).join('');
  return`<div class="set-section">
    <div class="set-section-head">
      <div class="set-section-title">Verification — official checks</div>
      <div class="set-section-sub">Which government checks run on which kind of account. A check switched off is not run and is not held against the applicant. Nothing here is ever guessed: a register that cannot be reached is recorded as "we do not know", never as "not a real company".</div>
    </div>
    <div class="vf-key">
      <input id="vf-ch-key" type="password" autocomplete="off" placeholder="Paste the Companies House API key">
      <button class="btn-save" onclick="saveVerifyKey('companies_house','vf-ch-key')">Save &amp; test key</button>
      <span class="vf-state" id="vf-ch-state">checking…</span>
    </div>
    <div class="vf-why">The key is tested against a real company before it is stored, and it is never shown again — only its last four characters, so you can tell one key from another. Rotate it here whenever you like.</div>
    <div class="vf-grid"><div class="vf-head">Check</div>${head}${rows}</div>
    <div class="save-row"><button class="btn-save" onclick="saveChecks()"><svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Save which checks run</button></div>
  </div>`;
}

/* Says which keys are installed, never what they are. */
async function loadVerifyKeys(){
  const el=document.getElementById('vf-ch-state');
  if(!el)return;
  const r=await cpApi('/team/verify/keys',{token:TEAM.token});
  if(!r.ok){el.textContent='could not check';return;}
  const k=(r.body&&r.body.companies_house)||{};
  el.innerHTML=k.set
    ?`Companies House: <b>connected</b> · key ending ${k.last4}${k.setBy?' · installed by '+k.setBy:''}`
    :'Companies House: <b>no key yet</b> — the company and director checks cannot run until one is pasted in';
}

async function saveVerifyKey(name,inputId){
  const input=document.getElementById(inputId);
  const value=(input.value||'').trim();
  if(!value)return showToast('Paste the key first',true);
  showToast('Testing that key against the register…');
  const r=await cpApi('/team/verify/key',{method:'POST',token:TEAM.token,body:{name:name,value:value}});
  if(!r.ok)return showToast((r.body&&r.body.error)||'Could not save that key',true);
  input.value='';
  showToast('Key saved and tested — the official checks can run now');
  loadVerifyKeys();
}

/* Reads the boxes, not a remembered state, and saves through the same route as
   every other setting on this screen. */
function saveChecks(){
  const cfg=getConfig();
  const checks={};
  CHECK_ROWS.forEach(r=>{
    checks[r.key]={};
    CHECK_TYPES.forEach(t=>{
      const box=document.getElementById('vf-'+r.key+'-'+t.key);
      checks[r.key][t.key]=!!(box&&box.checked);
    });
  });
  cfg.checks=checks;
  CFG=cfg;
  pushConfig('Saved — those checks are the ones that run now');
}

/* ── SETTINGS TAB (uses getConfig/CFG/TEAM from team.js) ── */
function renderSettings(){
  const cfg=getConfig();
  const el=document.getElementById('main-content');
  el.innerHTML=`<div class="settings-panel">
    ${renderVerifySection(cfg)}
    ${renderDocSection('Driver Accounts','Compliance documents required from courier and delivery drivers before their account is activated. Grounded in UK law — see the legal basis for each.',cfg,'driver')}
    ${renderDocSection('Find a Courier Accounts','Compliance documents required from freight forwarding businesses. Based on UK Companies House, HMRC, and insurance requirements.',cfg,'freight')}
    ${renderRebateSection(cfg)}
  </div>`;
  loadVerifyKeys();

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
    <div class="set-section-head"><div class="set-section-title">Profit pooling shares — Find a Courier</div><div class="set-section-sub">Set the profit-pooling percentages shown to freight forwarder applicants after approval. Leave blank to display "TBC" until confirmed.</div></div>
    <div class="rebate-fields">
      <div class="rf-row">
        <div><div class="rf-label">Standard pooling share</div><div class="rf-sub">Applies to all accounts that post for clients</div></div>
        <div class="rf-input-wrap"><input class="rf-input" id="rb-standard" type="text" placeholder="e.g. 3" value="${r.standard}"><span class="rf-unit">% per job</span></div>
      </div>
      <div class="rf-row">
        <div><div class="rf-label">HAF KNECT member share</div><div class="rf-sub">Higher share for forwarders who hold a KNECT membership</div></div>
        <div class="rf-input-wrap"><input class="rf-input" id="rb-knect" type="text" placeholder="e.g. 5" value="${r.knect}"><span class="rf-unit">% per job</span></div>
      </div>
    </div>
    <div class="save-row"><button class="btn-save" onclick="saveRebates()"><svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Save pooling shares</button></div>
  </div>`;
}

function updateDocSel(type,id,val,sel){
  sel.className='dc-sel '+(val==='required'?'req':val==='hidden'?'hid':'opt');
}

async function pushConfig(okMsg){
  const r=await cpApi('/team/config',{method:'PUT',body:CFG,token:TEAM.token});
  if(r.status===401){showToast('Session expired — please sign in again',true);doSignOut();return;}
  showToast(r.ok?okMsg:(r.body?.error||'Could not save — try again'),!r.ok);
}

function saveDocConfig(type){
  const cfg=getConfig();
  cfg[type].docs.forEach(d=>{
    const sel=document.getElementById('sel-'+type+'-'+d.id);
    if(sel)d.status=sel.value;
  });
  CFG=cfg;
  pushConfig(type==='driver'?'Driver requirements saved':'Freight requirements saved');
}

function saveRebates(){
  const cfg=getConfig();
  cfg.rebate={standard:document.getElementById('rb-standard').value.trim(),knect:document.getElementById('rb-knect').value.trim()};
  CFG=cfg;
  pushConfig('Pooling shares saved');
}