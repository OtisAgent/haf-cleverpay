/* The account sections and the invoices-and-payments screen, driven in a real
   browser against the real portal files.

   Nothing here is a stub of the portal: chromium loads team.html, team.js and
   team.css exactly as Cloudflare serves them, and only the CleverPay API is
   answered from a fixture. So a passing run means the page a person opens does
   this — not that a function returns the right array.

   The fixture is built to get a BAD row past every gate, not just a good one:
   a company number the register rejected, a number nobody has looked up yet, a
   driver who is also a limited company, an archived record that must not be
   counted, and an account with money against it and one without.

   Run:  node worker/test-sections-payments.mjs
*/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://cleverpay-api.orange-tree-fae7.workers.dev';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const ok = (n) => n.toISOString ? n.toISOString() : n;
const day = (d) => new Date(Date.UTC(2026, 8, d, 9, 0, 0)).toISOString();

const verified = (no, name) => ({ number: no, state: 'verified', name, status: 'Active',
                                  type: 'Private limited Company', reason: '',
                                  checked_at: day(10) });

/* every account also carries the fields the portal reads without asking */
const base = { docs: [], status: 'pending', email_verified: true, notes: null, archived: false };

const APPS = [
  { ...base, ref: 'T-DRIVER-1', type: 'driver', username: 'AA111111', fname: 'Ann', lname: 'Driver',
    email: 'ann@example.com', phone: '+447700000001', submitted: day(9) },

  /* an owner driver who trades through a limited company. He is still a DRIVER —
     the tag rides on his row, it does not move him into another section. */
  { ...base, ref: 'T-DRIVER-LTD', type: 'driver', username: 'BB222222', fname: 'Ben', lname: 'Wheeler',
    email: 'ben@example.com', phone: '+447700000002', submitted: day(8),
    company: 'Wheeler Haulage Ltd', crn: '16845493', company_check: verified('16845493', 'WHEELER HAULAGE LTD') },

  { ...base, ref: 'T-FLEET-LTD', type: 'fleet', username: 'CC333333', company: 'Arrow Connect Ltd',
    fname: 'Cal', lname: 'Ops', email: 'cal@example.com', submitted: day(7),
    crn: '10000001', company_check: verified('10000001', 'ARROW CONNECT LTD'),
    money: { plan: 'Founders', billing: 'monthly', paid_pence: 10000, awaiting_pence: 0,
             invoiced_pence: 0, outstanding_pence: 0, invoices: [], payments: [], orders: 0,
             synced_at: day(10) } },

  { ...base, ref: 'T-FLEET-PLAIN', type: 'fleet', username: 'DD444444', company: 'Dales Couriers',
    email: 'dale@example.com', submitted: day(6) },

  { ...base, ref: 'T-FREIGHT-LTD', type: 'freight', username: 'EE555555', company: 'Eastgate Freight Ltd',
    name: 'Eve Booker', email: 'eve@example.com', submitted: day(5), vat: 'GB123456789',
    crn: '10000002', company_check: verified('10000002', 'EASTGATE FREIGHT LTD'),
    money: { plan: 'Network', billing: 'monthly', paid_pence: 0, awaiting_pence: 54000,
             invoiced_pence: 54000, outstanding_pence: 54000,
             invoices: [{ number: 'INV-0001', status: 'awaiting_payment', issued_on: '2026-09-05',
                          due_on: '2026-09-19', total_pence: 54000, due_pence: 54000,
                          currency: 'GBP', url: '' }],
             payments: [], orders: 0, synced_at: day(10) } },

  /* the register said no. This must be visible, and it must NOT count as a
     limited company just because a number was typed. */
  { ...base, ref: 'T-FREIGHT-BADNO', type: 'freight', username: 'FF666666', company: 'Ficticious Ltd',
    email: 'fic@example.com', submitted: day(4), crn: '99999999',
    company_check: { number: '99999999', state: 'not_found', name: '', status: '', type: '',
                     reason: 'no company with that number', checked_at: day(10) } },

  /* a number nobody has looked up yet — neither a pass nor a fail */
  { ...base, ref: 'T-FREIGHT-UNCHECKED', type: 'freight', username: 'GG777777', company: 'Gale Logistics Ltd',
    email: 'gale@example.com', submitted: day(3), crn: '10000003' },

  { ...base, ref: 'T-BUSINESS', type: 'business', username: 'HH888888', company: 'Harbour Retail',
    email: 'harbour@example.com', submitted: day(2), status: 'enquiry' },

  /* filed away — counts towards nothing on any section or tile */
  { ...base, ref: 'T-ARCHIVED', type: 'freight', username: 'II999999', company: 'Idle Ltd',
    email: 'idle@example.com', submitted: day(1), archived: true,
    crn: '10000004', company_check: verified('10000004', 'IDLE LTD'),
    money: { plan: 'Founders', paid_pence: 999999, awaiting_pence: 0, invoiced_pence: 0,
             outstanding_pence: 0, invoices: [], payments: [], orders: 0, synced_at: day(10) } },
];

const EXPECT_SECTION = {
  'Driver accounts': ['T-DRIVER-1', 'T-DRIVER-LTD'],
  'Business accounts with drivers': ['T-FLEET-LTD', 'T-FLEET-PLAIN'],
  'Limited companies': ['T-FREIGHT-LTD'],
  'Business accounts without drivers': ['T-FREIGHT-BADNO', 'T-FREIGHT-UNCHECKED', 'T-BUSINESS'],
};

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + g + '\n       want ' + w); }
};

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('no'); return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const run = async () => {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on('pageerror', e => { fail++; console.log('  FAIL page threw: ' + e.message); });

  await page.route(API + '/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/team/applications')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(APPS) });
    if (u.pathname === '/config')
      return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.addInitScript(() => {
    sessionStorage.setItem('cp_team_session',
      JSON.stringify({ token: 'test', username: 'bf638793', name: 'Test Reviewer', role: 'admin' }));
  });

  await page.goto(`http://127.0.0.1:${port}/team.html`);
  await page.waitForFunction(() => window.QUEUE && window.QUEUE.length > 0 || (typeof QUEUE !== 'undefined' && QUEUE.length > 0));

  /* ── the arrivals board ── */
  console.log('\nARRIVALS BOARD — sections by what an account is');
  await page.evaluate(() => setTab('signedup'));
  await page.waitForTimeout(120);

  const heads = await page.$$eval('.qsec', secs => secs.map(s => ({
    title: s.querySelector('.sec-t')?.textContent.trim(),
    count: s.querySelector('.sec-n')?.textContent.trim(),
    refs: [...s.querySelectorAll('.c-ref')].map(r => r.textContent.trim()),
  })));

  check('four sections, in order', heads.map(h => h.title), Object.keys(EXPECT_SECTION));
  for (const [title, refs] of Object.entries(EXPECT_SECTION)) {
    const sec = heads.find(h => h.title === title) || { refs: [], count: '?' };
    check(`"${title}" holds the right accounts`, sec.refs.slice().sort(), refs.slice().sort());
    check(`"${title}" count matches its rows`, sec.count, String(refs.length));
  }

  /* the whole point of exclusive sections: the parts add up to the board, and
     nobody is in two of them or in none */
  const all = heads.flatMap(h => h.refs);
  check('every live account appears exactly once', all.slice().sort(),
        APPS.filter(a => !a.archived).map(a => a.ref).sort());
  check('the archived record is on no section', all.includes('T-ARCHIVED'), false);
  check('sections add up to the board count',
        heads.reduce((n, h) => n + Number(h.count), 0), APPS.filter(a => !a.archived).length);

  /* ── the company register tags ── */
  console.log('\nTHE COMPANY REGISTER — only a checked number earns the tag');
  const chipFor = async (ref) => page.evaluate((r) => {
    const row = [...document.querySelectorAll('.crm tr.r, .app-card')]
      .find(el => el.textContent.includes(r));
    return row ? [...row.querySelectorAll('.chip')].map(c => c.textContent.trim()) : null;
  }, ref);

  check('a checked number shows Ltd', (await chipFor('T-FREIGHT-LTD') || []).some(c => c.startsWith('Ltd')), true);
  check('a driver who is a limited company keeps the tag',
        (await chipFor('T-DRIVER-LTD') || []).some(c => c.startsWith('Ltd')), true);
  check('a rejected number is called out, not tagged',
        await chipFor('T-FREIGHT-BADNO').then(c => [c.some(x => x === 'Company no. not found'), c.some(x => x.startsWith('Ltd'))]),
        [true, false]);
  check('an unchecked number is neither',
        await chipFor('T-FREIGHT-UNCHECKED').then(c => [c.some(x => x === 'Company no. unchecked'), c.some(x => x.startsWith('Ltd'))]),
        [true, false]);
  check('no number at all shows no register chip',
        await chipFor('T-DRIVER-1').then(c => c.some(x => /Ltd|Company no\./.test(x))), false);

  /* ── invoices and payments ── */
  console.log('\nINVOICES AND PAYMENTS');
  await page.evaluate(() => setTab('payments'));
  await page.waitForTimeout(120);

  const tiles = await page.$$eval('.paytile', ts => ts.map(t => ({
    label: t.querySelector('.pt-t').textContent.trim(),
    value: t.querySelector('.pt-v').textContent.trim(),
  })));
  const tile = l => (tiles.find(t => t.label === l) || {}).value;

  check('signed up counts the live accounts', tile('Signed up'), '8');
  check('on a plan counts only accounts with one', tile('On a plan'), '2');
  check('paid is the live total, archived excluded', tile('Paid'), '£100');
  check('awaiting payment adds up', tile('Awaiting payment'), '£540');
  check('invoiced adds up', tile('Invoiced'), '£540');
  check('outstanding adds up', tile('Outstanding'), '£540');

  const tabCount = await page.textContent('#tc-payments');
  check('the tab count is accounts with money, not all accounts', tabCount, '2');

  const row = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('.crm.pay tbody tr')]
      .find(t => t.textContent.includes('T-FREIGHT-LTD'));
    return tr ? [...tr.children].map(td => td.textContent.trim()) : null;
  });
  check('the invoicing row carries the company number', row && row.includes('10000002'), true);
  check('the invoicing row carries the VAT number', row && row.includes('GB123456789'), true);
  check('the invoice reference is on the row', row && row.some(c => c.includes('INV-0001')), true);

  const money = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('.crm.pay tbody tr')]
      .find(t => t.textContent.includes('T-FREIGHT-LTD'));
    return [...tr.querySelectorAll('td.num-r')].map(td => td.textContent.trim());
  });
  check('paid / awaiting / invoiced / outstanding read across the row', money,
        ['£0', '£540', '£540', '£540']);

  const archivedShown = await page.evaluate(() =>
    document.querySelector('.crm.pay').textContent.includes('T-ARCHIVED'));
  check('an archived record is not on the payments screen', archivedShown, false);

  /* the filter, and the honesty of the sync stamp */
  await page.evaluate(() => setPayFilter('money'));
  await page.waitForTimeout(80);
  const onlyMoney = await page.$$eval('.crm.pay tbody tr', rs => rs.length);
  check('"something owed or paid" shows only those accounts', onlyMoney, 2);

  await page.evaluate(() => setPayFilter('none'));
  await page.waitForTimeout(80);
  const noMoney = await page.$$eval('.crm.pay tbody tr', rs => rs.length);
  check('"nothing yet" shows the rest', noMoney, 6);

  await page.evaluate(() => setPayFilter('all'));
  await page.waitForTimeout(80);
  const stamp = await page.textContent('.pay-synced');
  check('the screen says when the money side was last refreshed',
        /last refreshed/.test(stamp), true);

  /* a screen that has never synced must say so rather than showing silent zeros */
  await page.evaluate(() => { QUEUE = QUEUE.map(a => ({ ...a, money: null })); renderPayments(); });
  await page.waitForTimeout(80);
  const cold = await page.textContent('.pay-synced');
  check('with nothing synced it says so', /has not been refreshed/.test(cold), true);

  await browser.close();
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch(e => { console.error(e); process.exit(1); });
