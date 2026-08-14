/* What the applicant actually sees, rendered.

   Brent, 14 August: "HAF PLNA in red and only able to confirm after clever
   checked ... To get a HAF PLNA and drive on the network now, go and get clever
   checked ... upload documents here to add a vehicle" — and, just as important,
   "every join HAF account set up gets access to post jobs and view the HAF KNECT
   basic dashboard".

   So this checks the real status page in a real browser against two records: the
   one he tested with (approved, released, ZERO documents) and a complete one. The
   first must show a red, dead PLNA tile and a live KNECT tile; the second must
   show both working. Screenshots land in worker/_shots/.

   Run: node worker/test-status-plna-locked.mjs */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const ROOT = new URL('../', import.meta.url);
const SHOTS = new URL('./_shots/', import.meta.url);
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
const CONFIG = JSON.parse(readFileSync(new URL('./_live-config.json', import.meta.url), 'utf8'));
const REQ = t => CONFIG[t].docs.filter(d => d.status === 'required').map(d => d.id);
const files = ids => ids.map(id => ({ id, req: true, filename: id + '.pdf', path: 'x/' + id }));

/* the record exactly as it sits in production tonight */
const BRENT = {
  ref: 'HAF-CP-HVS7', username: 'BF638793', type: 'freight', status: 'approved',
  email: 'brentford93@hotmail.com', email_verified: true, docs: [],
  access_confirmed_at: '2026-08-11T14:10:26.533148+00:00',
  access_confirmed_by: 'OWNER: Brent Ford (own master account)',
  knect: false, submitted: '2026-08-04T05:39:13.119451+00:00',
};
/* and a complete one, the shape of the only properly checked driver we have */
const DONE = {
  ref: 'HAF-CP-74XU', username: 'HC823080', type: 'driver', status: 'approved',
  email: 'driver@example.com', email_verified: true, docs: files(REQ('driver')),
  access_confirmed_at: '2026-08-04T05:36:04.958+00:00', access_confirmed_by: 'cleverg',
  knect: true, submitted: '2026-08-01T09:00:00.000Z',
};

let CURRENT = BRENT;
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css' };
const srv = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(CONFIG)); }
  if (path === '/login' || path === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(CURRENT));
  }
  const name = (path === '/' ? '/status.html' : path).slice(1);
  try {
    let f = readFileSync(new URL(name, ROOT), 'utf8');
    if (name === 'api.js') f = f.replace(/const CP_API = '[^']*'/, "const CP_API = ''");
    res.writeHead(200, { 'Content-Type': MIME[name.split('.').pop()] || 'text/plain' });
    return res.end(f);
  } catch { res.writeHead(404); res.end('no'); }
});
await new Promise(r => srv.listen(8803, r));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 900, height: 1500 } });

async function render(app, shot) {
  CURRENT = app;
  /* status.html bounces to the sign-in page when it finds no session, so the
     record has to be in place BEFORE it is opened — land on any page on the
     origin first, seed it, then go to the page under test. */
  await page.goto('http://127.0.0.1:8803/index.html');
  await page.evaluate(a => localStorage.setItem('cp_application', JSON.stringify(a)), app);
  await page.goto('http://127.0.0.1:8803/status.html');
  await page.waitForTimeout(900);
  await page.screenshot({ path: new URL(shot, SHOTS).pathname, fullPage: true });
  return page.evaluate(() => {
    const tile = document.getElementById('plna-link');
    const note = document.getElementById('plna-locked');
    const knect = [...document.querySelectorAll('.access-link')].find(a => /knect/i.test(a.textContent));
    const cs = getComputedStyle(document.getElementById('plna-url'));
    return {
      panelShown: document.getElementById('access-panel').classList.contains('show'),
      locked: tile.classList.contains('locked'),
      href: tile.getAttribute('href'),
      urlText: document.getElementById('plna-url').textContent.trim(),
      urlColour: cs.color,
      noteShown: note.classList.contains('show'),
      noteText: note.innerText.replace(/\s+/g, ' ').trim(),
      noteBtn: note.querySelector('.pl-btn')?.getAttribute('href'),
      knectHref: knect?.getAttribute('href'),
      apSub: document.getElementById('ap-sub').textContent.trim(),
      accessSub: document.getElementById('tl-access-sub').textContent.trim(),
      docStep: document.getElementById('step-2').className,
    };
  });
}

console.log('\n── the account Brent tested: approved, released, NOTHING uploaded ──');
{
  const v = await render(BRENT, 'plna-locked-no-docs.png');
  ok('the account page still opens', v.panelShown, v);
  ok('the PLNA tile is in the locked (red) state', v.locked, v);
  ok('the PLNA tile is RED, not the normal colour', v.urlColour === 'rgb(208, 64, 64)', v.urlColour);
  ok('the PLNA link is DEAD — no address to click', v.href === null, v.href);
  ok('it reads Locked instead of the address', v.urlText === 'Locked', v.urlText);
  ok('the go-get-clever-checked note is shown', v.noteShown, v.noteShown);
  ok('it says to go and get Clever checked', /go and get Clever checked/i.test(v.noteText), v.noteText);
  ok('it says to upload documents to add a vehicle', /upload your documents here to add a vehicle/i.test(v.noteText), v.noteText);
  ok('the upload button goes to the documents page', v.noteBtn === 'docs.html', v.noteBtn);
  ok('HAF KNECT is still live and clickable', v.knectHref === 'https://knect.usehaf.co.uk', v.knectHref);
  ok('the page says KNECT is open for posting and dashboards', /post jobs and see your dashboards/i.test(v.apSub), v.apSub);
  ok('it does not tell them to log in to PLNA', !/log in to PLNA/i.test(v.accessSub), v.accessSub);
  ok('the Documents step is NOT ticked', /active/.test(v.docStep) && !/done/.test(v.docStep), v.docStep);
}

console.log('\n── a properly Clever checked driver ──');
{
  const v = await render(DONE, 'plna-open-checked.png');
  ok('the PLNA tile is not locked', !v.locked, v);
  ok('the PLNA link works', v.href === 'https://plna.usehaf.co.uk', v.href);
  ok('it shows the real address', v.urlText === 'plna.usehaf.co.uk', v.urlText);
  ok('the locked note is hidden', !v.noteShown, v.noteShown);
  ok('both platforms are offered', /log in to PLNA and HAF KNECT/i.test(v.accessSub), v.accessSub);
  ok('the Documents step is ticked', /done/.test(v.docStep), v.docStep);
}

console.log('\n── released, but a required document was removed afterwards ──');
{
  const v = await render({ ...DONE, docs: DONE.docs.slice(0, -1) }, 'plna-locked-one-short.png');
  ok('one missing document is enough to lock it again', v.locked && v.href === null, v);
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
await browser.close();
srv.close();
process.exit(fail ? 1 : 0);
