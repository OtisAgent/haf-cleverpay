/* A fleet operator signing up is filed as a FLEET, with the company details HAF
   needs to invoice them.

   Until 10 Sep the driver form posted `type: 'driver'` with a `fleet: true` beside
   it. The API stores only the fields it recognises and `fleet` is not one of them,
   so the answer was dropped on the floor: every courier company that ticked "I
   operate a fleet" was filed as a lone owner driver. This drives the real form in
   a real browser and reads what it actually posts.

   Run:  node worker/test-fleet-signup.mjs
*/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://cleverpay-api.orange-tree-fae7.workers.dev';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + g + '\n       want ' + w); }
};

const serve = () => new Promise((resolve) => {
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

async function fillDriver(page) {
  await page.fill('#d-fname', 'Cal');
  await page.fill('#d-lname', 'Ops');
  await page.fill('#d-email', 'cal@arrowconnect.example');
  await page.fill('#d-phone', '+447700900123');
  await page.fill('#d-dob', '1988-04-02');
  await page.selectOption('#d-vtype', { index: 1 });
  await page.fill('#d-vreg', 'AB12 CDE');
  await page.fill('#d-pin', '4821');
  await page.fill('#d-pin2', '4821');
}

const run = async () => {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page threw: ' + e.message); });

  let posted = null;
  let alerted = null;
  await page.route(API + '/**', async (route) => {
    const req = route.request();
    if (new URL(req.url()).pathname === '/apply') {
      posted = JSON.parse(req.postData() || '{}');
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ref: 'HAF-CP-TEST', username: posted.username }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  page.on('dialog', d => { alerted = d.message(); d.dismiss(); });

  /* How a real person gets to this form. CleverPay has not been a cold front
     door since 3 Sep — everybody starts at join.usehaf.co.uk, and index.html on
     its own shows a sign-in box, so a test that clicked the type cards would be
     testing a screen nobody sees.
     Join HAF sends the roles that owe documents on with their type and plan on
     the address. When it also sends a username (`&u=`) it has already opened the
     HAF account, and CleverPay answers with the sign-in box instead. This is the
     other arrival — a join record with no login yet — which is the one that still
     runs the sign-up form. */
  const arrive = (type) => `http://127.0.0.1:${port}/index.html?join=test-1234`
    + `&type=${type}&plan=${type}_pro&pn=${encodeURIComponent('Fleet Pro')}`;

  console.log('\nARRIVING AS AN OWNER DRIVER — still an owner driver');
  await page.goto(arrive('driver'));
  await page.waitForTimeout(400);
  await fillDriver(page);
  await page.evaluate(() => document.getElementById('d-terms').checked = true);
  await page.click('#driver-form button[type=submit]');
  await page.waitForTimeout(300);
  check('the company fields are hidden', await page.isHidden('#fleet-co-wrap'), true);
  check('type is driver', posted && posted.type, 'driver');
  check('no company is attached', posted && posted.company, null);

  console.log('\nARRIVING AS A FLEET — a business with drivers');
  posted = null; alerted = null;
  await page.goto(arrive('fleet'));
  await page.waitForTimeout(400);
  await fillDriver(page);
  await page.evaluate(() => document.getElementById('d-terms').checked = true);
  check('the company fields appear', await page.isVisible('#fleet-co-wrap'), true);

  /* the company details are not optional for a fleet — a business we cannot
     invoice and cannot look up on the register is not a business account */
  await page.selectOption('#d-fleet-size', '4–10');
  await page.click('#driver-form button[type=submit]');
  await page.waitForTimeout(250);
  check('it refuses to submit with no company details', posted, null);
  check('and says why', /company name and Companies House number/i.test(alerted || ''), true);

  await page.fill('#d-company', 'Arrow Connect Ltd');
  await page.fill('#d-crn', '10000001');
  await page.fill('#d-vat', 'GB123456789');
  await page.click('#driver-form button[type=submit]');
  await page.waitForTimeout(300);

  check('type is fleet', posted && posted.type, 'fleet');
  check('the company name is carried', posted && posted.company, 'Arrow Connect Ltd');
  check('the company number is carried', posted && posted.crn, '10000001');
  check('the VAT number is carried', posted && posted.vat, 'GB123456789');
  check('the driver count is still asked for', posted && posted.fleetSize, '4–10');
  check('the person behind the company is still on the record',
        posted && [posted.fname, posted.lname], ['Cal', 'Ops']);

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch(e => { console.error(e); process.exit(1); });
