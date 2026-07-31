/* CleverPay shared API client — all pages talk to the CleverPay API (Cloudflare Worker
   backed by the HAF database) instead of this browser's local storage. */
const CP_API = 'https://cleverpay-api.orange-tree-fae7.workers.dev';

async function cpApi(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(CP_API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    return { ok: false, status: 0, body: { error: 'No connection — check your internet and try again.' } };
  }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, body: data };
}

/* The config the team has saved is the master — their Required/Optional choices always win.
   But a document added to the built-in set after that save would otherwise stay invisible
   until someone happened to re-save the settings, so anything missing is appended here. */
function cpMergeDocList(stored, defaults) {
  const list = Array.isArray(stored) ? stored.map(d => ({ ...d })) : [];
  const have = list.map(d => d.id);
  (defaults || []).forEach(d => { if (!have.includes(d.id)) list.push({ ...d }); });
  return list;
}

function cpMergeConfig(stored, defaults) {
  if (!stored) return JSON.parse(JSON.stringify(defaults));
  const out = JSON.parse(JSON.stringify(stored));
  Object.keys(defaults || {}).forEach(type => {
    const def = defaults[type] && defaults[type].docs;
    if (!def) return;
    if (!out[type] || !Array.isArray(out[type].docs)) { out[type] = JSON.parse(JSON.stringify(defaults[type])); return; }
    out[type].docs = cpMergeDocList(out[type].docs, def);
  });
  return out;
}

/* PIN hash — same scheme the sign-up form has always used */
async function cpHashPin(username, pin) {
  const data = new TextEncoder().encode('HAF-CP|' + username + '|' + pin);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
