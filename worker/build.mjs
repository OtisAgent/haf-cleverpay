/* Build the deployable copy of the CleverPay worker.

   Cloudflare Workers can only be updated through a ~20KB upload pipe, and the
   commented source is now bigger than that. This strips comment-only lines and
   leading indentation — nothing else — so the deployed script behaves exactly
   like the source. Safe because no template literal in the source spans lines
   (checked by the guard below). Output: worker/cleverpay-api.build.js.
*/
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = new URL('./cleverpay-api.js', import.meta.url);
const OUT = new URL('./cleverpay-api.build.js', import.meta.url);
const lines = readFileSync(SRC, 'utf8').split('\n');

let ticks = 0;
lines.forEach((l, i) => {
  ticks += (l.match(/`/g) || []).length;
  if (ticks % 2) throw new Error(`line ${i + 1} leaves a template literal open — stripping is unsafe`);
});

const out = [];
let inBlock = false;
for (const line of lines) {
  const t = line.trim();
  if (inBlock) { if (t.endsWith('*/')) inBlock = false; continue; }
  if (t.startsWith('/*')) { if (!t.endsWith('*/')) inBlock = true; continue; }
  if (t.startsWith('//') || !t) continue;
  out.push(t);
}

const body = out.join('\n');
writeFileSync(OUT, body);
console.log(`${body.length} bytes (from ${readFileSync(SRC, 'utf8').length})`);
if (body.length > 19000) console.error('WARNING: still too big for the upload pipe');
