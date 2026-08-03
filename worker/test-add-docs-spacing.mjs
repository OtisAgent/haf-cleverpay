/* Spacing proof for the documents section on the manual Add account form.
   Measures real rendered geometry — no screenshots-by-eye — so the section sits on
   the same rhythm as the rest of the form at desktop and phone width. Serves the
   portal's own files from disk with no database behind it: the form is opened and
   measured, never submitted.
   Run: node worker/test-add-docs-spacing.mjs */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const ROOT = new URL('../', import.meta.url);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const srv = createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'team.html';
  try {
    const body = readFileSync(new URL(name, ROOT));
    res.writeHead(200, { 'Content-Type': TYPES[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('no'); }
});
await new Promise(r => srv.listen(8798, r));
const SITE = 'http://127.0.0.1:8798';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };
/* sub-pixel layout: anything inside half a pixel is the same edge */
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

/* the queue behind the gate needs a real session; the form itself does not, so a
   local stub session is enough to reach it and nothing is ever sent anywhere */
async function openForm(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 1300 } });
  const page = await ctx.newPage();
  await page.goto(SITE + '/team.html');
  await page.evaluate(() => sessionStorage.setItem('cp_team_session', JSON.stringify(
    { token: 'SPACING-CHECK', username: 'bf638793', name: 'Brent Ford', role: 'admin' })));
  await page.reload();
  await page.waitForSelector('#shell.show', { timeout: 8000 });
  await page.click('.add-btn');
  await page.waitForSelector('#add-ov.open', { timeout: 4000 });
  await page.waitForTimeout(200);
  return { ctx, page };
}

/* the gaps the form already used before the documents section existed.
   Everything is expressed in the page's own base unit — this portal sets 14px, not
   the browser's 16px, so a hard-coded pixel target would measure the wrong rhythm. */
const rhythm = (page) => page.evaluate(() => {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  const docs = r('.add-docs'), meta = r('.add-meta-row');
  const shown = document.querySelector('#add-driver-fields').offsetParent !== null
    ? '#add-driver-fields' : '#add-freight-fields';
  const fields = r(shown);
  /* the fields box carries the last input's own bottom margin inside it, so the gap
     a person actually sees is measured from the last input, not from the box */
  const inputs = [...document.querySelectorAll(shown + ' .fi')];
  const lastField = inputs[inputs.length - 1].getBoundingClientRect();
  const head = document.querySelector('.add-docs .fl').getBoundingClientRect();
  const cs = getComputedStyle(document.querySelector('.add-docs'));
  return {
    rem,
    fieldsToRule: (docs.top - lastField.bottom) / rem,   /* last input → separator line */
    /* from the underside of the line, not its top edge — the line has its own width */
    ruleToHeading: (head.top - docs.top - parseFloat(cs.borderTopWidth)) / rem,
    docsToMeta: (meta.top - docs.bottom) / rem,          /* section → username card */
    left: docs.left, right: docs.right,
    metaLeft: meta.left, metaRight: meta.right,
    fieldsLeft: fields.left, fieldsRight: fields.right,
    borderTop: parseFloat(cs.borderTopWidth),
  };
});

for (const width of [1280, 390]) {
  console.log(`\n── the add form at ${width} ──`);
  const { ctx, page } = await openForm(width);
  const m = await rhythm(page);

  ok('the separator sits centred between the fields and the heading',
    near(m.fieldsToRule, 0.75, 0.06) && near(m.ruleToHeading, 0.8, 0.08) &&
    Math.abs(m.fieldsToRule - m.ruleToHeading) * m.rem <= 1.5, m);
  ok('the section leaves the same gap below it that the form uses everywhere else',
    near(m.docsToMeta, 1.25, 0.06), m.docsToMeta);
  ok('it lines up flush with the fields above and the username card below',
    near(m.left, m.fieldsLeft) && near(m.right, m.fieldsRight) &&
    near(m.left, m.metaLeft) && near(m.right, m.metaRight), m);
  ok('the separator line is actually drawn', m.borderTop >= 0.5, m.borderTop);

  /* the type tabs: an undefined token used to erase this border entirely */
  const tabs = await page.evaluate(() => {
    const cs = (s) => getComputedStyle(document.querySelector(s));
    const a = cs('#at-driver'), b = cs('#at-freight');
    const ra = document.querySelector('#at-driver').getBoundingClientRect();
    const rb = document.querySelector('#at-freight').getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { aStyle: a.borderTopStyle, bStyle: b.borderTopStyle,
      aW: parseFloat(a.borderTopWidth), bW: parseFloat(b.borderTopWidth),
      aCol: a.borderTopColor, bCol: b.borderTopColor, aBg: a.backgroundColor,
      gap: (rb.left - ra.right) / rem,
      sameWidth: Math.abs(ra.width - rb.width) < 1 };
  });
  ok('both account-type tabs are drawn as buttons, not bare text',
    tabs.aStyle === 'solid' && tabs.bStyle === 'solid' && tabs.aW >= 1 && tabs.bW >= 1, tabs);
  ok('the chosen tab is the one picked out in orange',
    tabs.aCol !== tabs.bCol && /241, *142, *0/.test(tabs.aCol), tabs);
  ok('the two tabs are equal width and evenly gapped',
    tabs.sameWidth && near(tabs.gap, 0.5, 0.06), tabs);

  /* open it up: the rows must not overflow the card or crush together */
  await page.click('#add-docs-toggle');
  await page.waitForTimeout(250);
  const open = await page.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const rows = [...document.querySelectorAll('#add-doc-rows .adr')];
    const box = document.querySelector('#add-doc-rows').getBoundingClientRect();
    const docs = document.querySelector('.add-docs').getBoundingClientRect();
    const meta = document.querySelector('.add-meta-row').getBoundingClientRect();
    const gaps = rows.slice(1).map((r, i) => (r.getBoundingClientRect().top - rows[i].getBoundingClientRect().bottom) / rem);
    const clipped = rows.some(r => r.getBoundingClientRect().right > box.right + 0.6);
    return { n: rows.length, gaps,
      boxTop: (box.top - document.querySelector('.add-docs-head').getBoundingClientRect().bottom) / rem,
      docsToMeta: (meta.top - docs.bottom) / rem, clipped,
      scrolls: document.querySelector('#add-doc-rows').scrollHeight > box.height + 1 };
  });
  ok('every document has its own row', open.n > 0, open.n);
  ok('the rows are evenly spaced', open.gaps.every(g => near(g, 0.38, 0.06)), open.gaps);
  ok('the list is set off from the heading above it', near(open.boxTop, 0.75, 0.06), open.boxTop);
  ok('opening it does not change the gap to the username card', near(open.docsToMeta, 1.25, 0.06), open.docsToMeta);
  ok('no row spills out sideways', !open.clipped, open);
  ok('a long list scrolls inside its own box instead of stretching the form', open.scrolls === true, open);

  /* and the whole card still fits the screen with the list open */
  const fits = await page.evaluate(() => {
    const mo = document.querySelector('#add-ov .modal').getBoundingClientRect();
    return { top: mo.top, bottom: mo.bottom, vh: window.innerHeight,
      scrolls: document.querySelector('#add-ov .modal').scrollHeight > mo.height + 1 };
  });
  ok('the whole form still fits on screen', fits.top >= -0.6 && fits.bottom <= fits.vh + 0.6, fits);

  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
