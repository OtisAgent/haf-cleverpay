/* Live check on the real clever.usehaf.co.uk team portal.
   Uses short-lived verification session tokens (deleted afterwards) rather than
   anyone's PIN, and only ever opens the Integration tab — never screenshots the
   applicant queue, which holds real people's details. */
import { chromium } from 'playwright-core';

/* the box has changed chromium build more than once — take whichever is installed */
const CHROME = [
  process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  process.env.HOME + '/.cache/ms-playwright/chromium-1140/chrome-linux/chrome',
].find(p => { try { return statSync(p).isFile(); } catch { return false; } });

const SITE = 'https://clever.usehaf.co.uk/team.html';
const SESSIONS = {
  Brent: { token: 'OTISVERIFY-BRENT-31JUL', username: 'bf638793', name: 'Brent Ford', role: 'admin' },
  Gemma: { token: 'OTISVERIFY-GEMMA-31JUL', username: 'cleverg', name: 'Gemma Vale', role: 'compliance' },
  Other: { token: 'OTISVERIFY-OTHER-31JUL', username: 'admin', name: 'Admin', role: 'admin' },
};

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); } };

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox'],
});

async function open(who, width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(s => sessionStorage.setItem('cp_team_session', JSON.stringify(s)), SESSIONS[who]);
  await page.reload({ waitUntil: 'networkidle' });
  return { ctx, page };
}

for (const who of ['Brent', 'Gemma']) {
  console.log(`\n── ${who} (${SESSIONS[who].username}) on the live site ──`);
  const { ctx, page } = await open(who);
  await page.waitForSelector('#shell.show', { timeout: 15000 });
  ok('signed in', true);
  ok('sees the Integration tab', await page.locator('#tab-integration').count() === 1);
  await page.click('#tab-integration');
  await page.waitForSelector('.ig-wrap', { timeout: 15000 });
  const txt = await page.locator('.ig-wrap').innerText();
  ok('the panel loads', txt.includes('Back-office address'));
  ok('the endpoint is the real one',
    (await page.locator('#ig-ep').innerText()).includes('cleverpay-api') , await page.locator('#ig-ep').innerText());
  ok('it shows no key is active yet', txt.includes('no key yet'), txt.slice(0, 90));
  ok('it lists what would cross', txt.includes('compliance status') && txt.includes('No documents'));
  await page.screenshot({ path: new URL(`_shots/LIVE-${who}.png`, import.meta.url).pathname, fullPage: true });
  await ctx.close();
}

console.log('\n── a third team login (admin) on the live site ──');
{
  const { ctx, page } = await open('Other');
  await page.waitForSelector('#shell.show', { timeout: 15000 });
  ok('signed in normally', true);
  ok('no Integration tab', await page.locator('#tab-integration').count() === 0);
  ok('"Integration" appears nowhere in the tab bar', !(await page.locator('.tab-bar').innerText()).includes('Integration'));
  const forced = await page.evaluate(async () => {
    const t = JSON.parse(sessionStorage.getItem('cp_team_session')).token;
    const base = 'https://cleverpay-api.orange-tree-fae7.workers.dev';
    const a = await fetch(base + '/team/integration', { headers: { Authorization: 'Bearer ' + t } });
    const b = await fetch(base + '/team/integration/key', {
      method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: '{}' });
    return { read: a.status, make: b.status, body: (await a.text()).trim() };
  });
  ok('forcing the read from their own browser is refused', forced.read === 404, forced);
  ok('forcing a key from their own browser is refused', forced.make === 404, forced);
  ok('the refusal gives nothing away', forced.body === '{"error":"Not found."}', forced.body);
  await ctx.close();
}

console.log('\n── the endpoint is not reachable from the public site ──');
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('https://clever.usehaf.co.uk/', { waitUntil: 'domcontentloaded' });
  const blocked = await page.evaluate(async () => {
    try {
      const r = await fetch('https://cleverpay-api.orange-tree-fae7.workers.dev/partner/compliance');
      return { reached: true, status: r.status };
    } catch (e) { return { reached: false, error: String(e).slice(0, 80) }; }
  });
  ok('a browser on the public sign-up site cannot read it', !blocked.reached, blocked);
  const html = await page.content();
  ok('the sign-up page links nothing to the integration', !html.includes('partner/compliance') && !html.includes('Integration'));
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail ? 1 : 0);
