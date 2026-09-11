/* Proof for Brent's 11 Sep ruling: a fleet's OWNER drives, so the fleet account
   is asked for a driving record exactly as an owner driver is, and the reviewer
   sees and confirms it in the portal exactly as they would a driver's.

   This drives the REAL portal files and the REAL applicant upload page in a real
   browser. It does not sign in — the panel it is proving is drawn by functions on
   the page, so the page is loaded and those functions are called directly with a
   record. (worker/test-panel.mjs, which does sign in, has been broken since the
   10 Sep sign-in change and fails identically on a clean checkout of production
   HEAD — it is not proving anything today and is not used here.)

   Run:  node worker/test-fleet-record.mjs
*/
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const ROOT = new URL('../', import.meta.url);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
               '.woff2': 'font/woff2' };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail))); }
};

/* the four account types, and the one fact that decides the question */
const REC = { dvla_licence_no: 'MORGA657054SM9IJ', dvla_check_code: 'Ab12 3Cd4',
              ni_number: 'AB123456C', dvla_code_at: '2026-09-11T09:00:00Z' };
const row = (type, extra) => ({
  ref: 'HAF-CP-T' + type.slice(0, 3).toUpperCase(), type, status: 'pending',
  email: 't@example.com', company: 'Efficient Express Limited', docs: [],
  ...REC, ...(extra || {}),
});

/* serve the real repo, and answer the page's own API calls with nothing, so the
   page loads and defines its functions without reaching the live worker */
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  /* API paths only. `/team` also prefixes team.js and team-edit.js, and
     swallowing those serves the portal with no code and every function
     undefined — which reads as "the feature is missing" and is really the
     stub eating the page. Anything with a file extension is a file. */
  const isFile = /\.[a-z0-9]+$/i.test(path);
  if (!isFile && (path.startsWith('/config') || path.startsWith('/team') || path.startsWith('/apps'))) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end('{}');
  }
  try {
    const file = path === '/' ? '/index.html' : path;
    const body = readFileSync(new URL('.' + file, ROOT));
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('no'); }
});

await new Promise(r => server.listen(0, r));
const BASE = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: CHROME });

/* ── 1. the reviewer's panel ─────────────────────────────────────────────── */
console.log('\nThe reviewer sees a driving record for everyone who drives');
{
  const page = await browser.newPage();
  await page.goto(BASE + '/team.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.recordCheckHtml === 'function', null, { timeout: 15000 });

  const draw = t => page.evaluate(r => window.recordCheckHtml(r), row(t));

  const fleet = await draw('fleet');
  ok('a fleet gets the driving record panel', fleet.includes('Driving record check'), fleet.slice(0, 80));
  ok('and the licence number is on it', fleet.includes('MORGA657054SM9IJ'));
  ok('and the check code keeps its capitals', fleet.includes('Ab12 3Cd4'));
  ok('and the NI number is masked until someone asks', fleet.includes('data-shown="0"') && !fleet.includes('>AB123456C<'));
  ok('and there is a GOV.UK button to run the check', fleet.includes('Check on GOV.UK'));
  ok('and a tick to confirm the record was checked', fleet.includes('tickDvla(&#39;') || fleet.includes("tickDvla('"));

  const driver = await draw('driver');
  ok('a driver is unchanged — still gets it', driver.includes('Driving record check'));

  /* the other half of the rule: nothing that never drives is ever asked */
  ok('a freight forwarder is NOT asked', (await draw('freight')) === '');
  ok('a business enquiry is NOT asked', (await draw('business')) === '');

  /* a fleet that has sent nothing must read as outstanding, not as blank-and-fine */
  const empty = await page.evaluate(r => window.recordCheckHtml(r),
    { ...row('fleet'), dvla_licence_no: null, dvla_check_code: null, ni_number: null, dvla_code_at: null });
  ok('an empty fleet record says it is outstanding', empty.includes('Not supplied yet'));
  ok('and it is not silently marked confirmed', !empty.includes('rc-panel on'));
  await page.close();
}

/* ── 2. the reviewer's edit panel ────────────────────────────────────────── */
console.log('\nThe reviewer can correct a fleet owner’s codes');
{
  const page = await browser.newPage();
  await page.goto(BASE + '/team.html', { waitUntil: 'domcontentloaded' });
  /* `needsRecord` is a top-level const, so it lives in the global LEXICAL scope
     and is reachable by bare name from every later script on the page — which is
     exactly how team-edit.js calls it — but it is never a property of `window`.
     Asking for window.needsRecord would fail while the feature worked fine. */
  await page.waitForFunction(() => typeof needsRecord === 'function', null, { timeout: 15000 });
  const gate = t => page.evaluate(r => needsRecord(r), row(t));
  ok('the edit panel opens the codes for a fleet', await gate('fleet'));
  ok('and for a driver', await gate('driver'));
  ok('and not for freight', !(await gate('freight')));
  ok('and not for a business', !(await gate('business')));
  await page.close();
}

/* ── 3. the applicant's own upload page ──────────────────────────────────── */
console.log('\nA fleet owner is asked for it on their own upload page');
for (const [type, wanted] of [['fleet', true], ['driver', true], ['freight', false], ['business', false]]) {
  const page = await browser.newPage();
  await page.addInitScript(a => {
    localStorage.setItem('cp_application', JSON.stringify(a));
  }, { ...row(type), pinHash: 'x', dvla_licence_no: null, dvla_check_code: null, ni_number: null });
  await page.goto(BASE + '/docs.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const shown = await page.evaluate(() => {
    const el = document.getElementById('rec-check');
    return !!(el && el.offsetHeight > 0);
  });
  ok(`the driving record block is ${wanted ? 'shown' : 'hidden'} for a ${type}`, shown === wanted, { shown });

  if (wanted) {
    /* the point of the block is that it BLOCKS: an empty record must not submit */
    const blocked = await page.evaluate(() => {
      const b = document.getElementById('submit-btn');
      return !!(b && b.disabled) && rcComplete() === false;
    });
    ok(`a ${type} with an empty record cannot submit`, blocked);
    /* and a good record satisfies it, and is what gets sent */
    const sends = await page.evaluate(() => {
      document.getElementById('rc-lic').value = 'MORGA657054SM9IJ';
      document.getElementById('rc-code').value = 'Ab123Cd4';
      document.getElementById('rc-ni').value = 'AB123456C';
      return rcComplete() === true;
    });
    ok(`a ${type} with a good record satisfies the check`, sends);
  }
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
