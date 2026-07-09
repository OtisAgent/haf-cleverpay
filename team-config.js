/* ── USERS ── */
/* Temp passwords — update these once Brent provides Gemma's login details */
const USERS = [
  {username: 'brent',  password: 'Brent2026',  name: 'Brent Ford',  role: 'admin'},
  {username: 'gemma',  password: 'Gemma2026',  name: 'Gemma Vale',  role: 'compliance'},
  {username: 'admin',  password: 'HAF2026',     name: 'Admin',        role: 'admin'},
];

/* ── DEFAULT COMPLIANCE CONFIG ── */
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
    ]
  },
  rebate: {standard: '', knect: ''}
};

/* ── STATE ── */
let currentUser = null;
let currentTab = 'pending';
let rejectTarget = null;

/* ── HELPERS ── */