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

/* PIN hash — same scheme the sign-up form has always used */
async function cpHashPin(username, pin) {
  const data = new TextEncoder().encode('HAF-CP|' + username + '|' + pin);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
