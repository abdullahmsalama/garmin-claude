// Garmin connector for Claude (and other MCP apps): your own copy, in your own Cloudflare account.
//   /      setup and status page (login: the OWNER_PASSWORD you chose when deploying)
//   /mcp   the connector itself (remote MCP), behind OAuth (/authorize, /token, /register)
// Your Garmin Personal API key is typed on the setup page and stored encrypted in your database.
// The cron pulls new data every 30 minutes and loads your history a few requests at a time.
// Secret: OWNER_PASSWORD (required). Optional: ENCRYPTION_KEY, GARMIN_API_KEY, PUBLIC_URL.
import { OAuthProvider, AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { mcpHandler } from './mcp.js';
import { sign, verify, sameSecret } from './crypto.js';
import { ensureSchema } from './schema.js';
import { OWNER, log, getMeta, syncRecent, queueHistory, runJobs, hasKey, setApiKey } from './store.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
let origin = ''; // this connector's own address, e.g. https://garmin-claude-connector.you.workers.dev
const base = env => (env.PUBLIC_URL || origin).replace(/\/$/, '');
const html = (body, status = 200, headers = {}) => new Response(page(body), { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...headers } });
const go = (to, headers = {}) => new Response(null, { status: 303, headers: { Location: to, ...headers } });
const ip = req => req.headers.get('CF-Connecting-IP') || 'local';
const DAY_MS = 864e5;

// ---------- password ----------
// The Deploy button pre-fills the example value, so refuse it (and anything short) until it's changed.
const EXAMPLE_PASSWORDS = ['change-me-to-a-long-password', 'change-me', 'password', '123456789012'];
function passwordProblem(env) {
  const p = env.OWNER_PASSWORD || '';
  if (!p) return 'No password is set yet.';
  if (EXAMPLE_PASSWORDS.includes(p.toLowerCase())) return 'The password is still the example one.';
  if (p.length < 12) return 'The password is shorter than 12 characters.';
  return null;
}
const passwordHelp = problem => html(`<h1>One more step: choose your password</h1><div class="card"><p class="bad">${esc(problem)}</p>
<p>This password protects your Garmin data, so the connector won't work until it's set. In Cloudflare:</p>
<ol><li>Open <b>dash.cloudflare.com</b> → <b>Workers &amp; Pages</b> → this connector.</li>
<li><b>Settings</b> → <b>Variables and Secrets</b> → <b>OWNER_PASSWORD</b> → <b>Edit</b>.</li>
<li>Type a password of <b>12+ characters</b> (a short sentence works well) and <b>Deploy</b>.</li>
<li>Come back to this page and refresh.</li></ol></div>`, 503);

// ---------- owner login ----------
const COOKIE = 'gm_owner';
const cookieFlags = env => `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${base(env).startsWith('https') ? '; Secure' : ''}`;
async function sessionCookie(env) { const exp = Date.now() + 30 * DAY_MS; return `${COOKIE}=${exp}.${await sign(env, `owner:${exp}`)}; ${cookieFlags(env)}`; }
async function isOwner(req, env) {
  const c = (req.headers.get('Cookie') || '').split(/;\s*/).find(x => x.startsWith(`${COOKIE}=`));
  if (!c) return false;
  const [exp, sig] = c.slice(COOKIE.length + 1).split('.');
  return +exp > Date.now() && verify(env, `owner:${exp}`, sig);
}
// Password check with a brake on guessing: 5 wrong tries per IP per 15 min, 20 overall per hour.
async function checkPassword(req, env, password) {
  const now = Date.now();
  const mine = (await env.DB.prepare('SELECT COUNT(*) AS n FROM login_fails WHERE ip = ?1 AND ts > ?2').bind(ip(req), now - 15 * 60000).first()).n;
  const all = (await env.DB.prepare('SELECT COUNT(*) AS n FROM login_fails WHERE ts > ?1').bind(now - 3600000).first()).n;
  if (mine >= 5 || all >= 20) return 'Too many wrong tries. Wait 15 minutes.';
  if (await sameSecret(env, env.OWNER_PASSWORD, String(password || ''))) return null;
  await env.DB.batch([env.DB.prepare('INSERT INTO login_fails (ip, ts) VALUES (?1, ?2)').bind(ip(req), now), env.DB.prepare('DELETE FROM login_fails WHERE ts < ?1').bind(now - 86400000)]);
  return 'Wrong password.';
}
// POSTs from the owner's pages must come from this site.
const sameOrigin = (req, env) => {
  const site = req.headers.get('Sec-Fetch-Site'); // set by modern browsers, can't be faked by a web page
  if (site) return site === 'same-origin' || site === 'none';
  const o = req.headers.get('Origin');
  return !o || o === new URL(base(env) || req.url).origin;
};

// ---------- pages ----------
function page(body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>My Garmin connector</title>
<style>:root{color-scheme:light dark;--bg:#f6f5f1;--card:#fff;--ink:#1b2321;--muted:#5f6b67;--line:#e3ded3;--accent:#0f6b63;--accent-ink:#fff;--ok:#15803d;--bad:#c2410c}
@media(prefers-color-scheme:dark){:root{--bg:#0f1514;--card:#18211f;--ink:#ebe7df;--muted:#9aa5a1;--line:#283331;--accent:#35b3a7;--accent-ink:#06201d;--ok:#4ade80;--bad:#fb923c}}
*{box-sizing:border-box}body{font:16px/1.55 system-ui,-apple-system,sans-serif;max-width:680px;margin:0 auto;padding:20px 16px 40px;color:var(--ink);background:var(--bg)}
h1{font-size:23px;margin:4px 0 6px}h2{font-size:17px;margin:22px 0 8px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin:12px 0}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:5px 8px 5px 0;border-bottom:1px solid var(--line)}
button{font:inherit;font-weight:600;background:var(--accent);color:var(--accent-ink);border:0;border-radius:10px;padding:10px 16px;cursor:pointer}button.light{background:transparent;color:var(--ink);border:1px solid var(--line)}button:disabled{opacity:.5}
input,select{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);max-width:100%}input[type=password],input[type=text]{width:100%}
code{background:var(--bg);border:1px solid var(--line);padding:2px 6px;border-radius:6px;word-break:break-all;font-size:14px}.muted{color:var(--muted);font-size:14px}.wrap{overflow-x:auto}
.big{font-size:17px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}li{margin:5px 0}details summary{cursor:pointer;font-weight:600}</style><body>${body}</body></html>`;
}
const loginPage = (msg = '') => html(`<h1>My Garmin connector</h1><div class="card"><form method="post" action="/login">
<p>Log in with the password you chose when you deployed it.</p><p><input type="password" name="password" autocomplete="current-password" required autofocus></p><p><button>Log in</button></p>${msg ? `<p class="bad">${esc(msg)}</p>` : ''}</form></div>`, msg ? 401 : 200);

// Step 2 of setup: the Garmin key.
const keyForm = (msg = '', replacing = false) => `<div class="card"><h2 style="margin-top:0">${replacing ? 'Replace your Garmin key' : 'Add your Garmin key'}</h2>
<ol><li>Open <a href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noopener noreferrer">Garmin Connect → Settings → Personal API Key</a>.</li><li>Tap <b>Create</b> and copy the key (Garmin shows it once).</li><li>Paste it here.</li></ol>
<form method="post" action="/key"><p><input type="password" name="key" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Garmin Personal API key" required></p>
<p><button>Check and save</button></p>${msg ? `<p class="bad">${esc(msg)}</p>` : ''}</form>
<p class="muted">The key is checked with Garmin, then stored encrypted in your own Cloudflare database. Nobody else, including whoever made this connector, can see it.</p></div>`;

const ago = t => { if (!t) return 'never'; const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
async function statusPage(env, note = '', keyMsg = '') {
  if (!(await hasKey(env))) {
    return html(`<h1>Almost there 👋</h1><p class="muted">Your connector is running. Now connect it to your Garmin account.</p>${keyForm(keyMsg)}
<form method="post" action="/logout"><button class="light">Log out</button></form>`);
  }
  const counts = (await env.DB.prepare('SELECT type, COUNT(*) AS n, MIN(day) AS first, MAX(day) AS last, MAX(received) AS rec FROM summaries WHERE user_id = ?1 GROUP BY type ORDER BY type').bind(OWNER).all()).results;
  const jobs = (await env.DB.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()).results;
  const events = (await env.DB.prepare('SELECT ts, kind, detail FROM events ORDER BY id DESC LIMIT 12').all()).results;
  const keyError = await getMeta(env, 'key_error'), lastSync = +(await getMeta(env, 'last_sync')) || 0, result = await getMeta(env, 'last_sync_result');
  const left = jobs.filter(j => j.status === 'queued' || j.status === 'retry').reduce((s, j) => s + j.n, 0);
  const url = `${base(env)}/mcp`;
  const names = { activities: 'Activities', dailies: 'Daily stats', sleep: 'Sleep', hrv: 'HRV', bodyBattery: 'Body Battery', weight: 'Weight', hrZones: 'HR zones', fitnessAge: 'Fitness age', activityDetail: 'Workout details' };
  return html(`<h1>My Garmin connector</h1>
${note ? `<div class="card big">${esc(note)}</div>` : ''}
<div class="card"><p class="big">${keyError ? `<span class="bad">● ${esc(keyError)}</span>` : '<span class="ok">● Connected to Garmin</span>'}</p>
<p>Last update from Garmin: <b>${esc(ago(lastSync))}</b>${result && result !== 'ok' ? `<br><span class="bad">${esc(result)}</span>` : ''}</p>
<p>${left ? `Loading your history: <b>${left}</b> requests to go (a few every 5 minutes, so about ${(m => (m < 90 ? `${m} min` : `${Math.round(m / 60)} h`))(Math.ceil(left / 6) * 5)} more). You can use the connector already.` : jobs.length ? 'History loaded ✓' : ''}</p>
<div class="row"><form method="post" action="/sync"><button class="light">Update now</button></form></div></div>

<h2>Add it to Claude</h2><div class="card">
<p>Your connector link:</p><p class="row"><code id="u">${esc(url)}</code> <button class="light" type="button" id="copy">Copy</button></p>
<ol><li>Open <b>claude.ai</b> in a browser (it can't be added in the phone app, but works there afterwards).</li>
<li><b>Settings → Connectors → Add custom connector</b>. Name it <b>Garmin</b>, paste the link, tap <b>Add</b>.</li>
<li>Tap <b>Connect</b>. This page opens and asks for your password. Tap <b>Allow</b>.</li>
<li>In any chat (phone or web): <b>＋ → Connectors → Garmin</b> on, then ask <i>"How did I sleep this week?"</i></li></ol>
<details><summary>ChatGPT instead</summary><p class="muted">Needs a paid plan and ChatGPT's developer mode on the web (beta): Settings → Apps &amp; Connectors → Advanced → Developer mode on, then create a connector with the link above and sign in the same way.</p></details></div>

<h2>Your data</h2><div class="card wrap">${counts.length ? `<table><tr><th>What</th><th>Items</th><th>From</th><th>To</th></tr>${counts.map(c => `<tr><td>${esc(names[c.type] || c.type)}</td><td>${c.n}</td><td>${esc(c.first)}</td><td>${esc(c.last)}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing yet: tap Update now.</p>'}
<form method="post" action="/history" class="row" style="margin-top:10px"><span class="muted">Reload history:</span><select name="days"><option value="90">90 days</option><option value="365" selected>1 year</option><option value="730">2 years</option></select><button class="light">Load</button></form></div>

<details class="card"><summary>Recent events</summary><div class="wrap"><table>${events.map(e => `<tr><td class="muted">${esc(new Date(e.ts).toISOString().slice(5, 16).replace('T', ' '))}</td><td>${esc(e.kind)}</td><td>${esc(e.detail)}</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}</table></div></details>
<details class="card"><summary>Replace Garmin key</summary>${keyForm(keyMsg, true).replace('<div class="card">', '<div>')}</details>
<form method="post" action="/logout"><button class="light">Log out</button></form>
<script>document.getElementById('copy').onclick=function(){navigator.clipboard.writeText(document.getElementById('u').textContent).then(function(){document.getElementById('copy').textContent='Copied'})}</script>`);
}

// Consent for Claude (or any MCP client) to read the data: shows who's asking, needs the owner password.
async function authorize(req, env) {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === 'GET') {
      const request = await oauth.parseAuthRequest(req);
      const d = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(page(`<h1>Allow access to your Garmin data?</h1><div class="card">
<p><b>${esc(d.clientName)}</b> ${d.clientDomain ? `(from <b>${esc(d.clientDomain)}</b>)` : '<span class="muted">(name not verified)</span>'} wants <b>read-only</b> access.</p>
<p>Access goes to: <b>${esc(d.redirectHost)}</b></p>${d.redirectIsLoopback ? '<p class="bad">This sends access to an app on your computer. Continue only if you just started this yourself.</p>' : ''}
<form method="post"><input type="hidden" name="handle" value="${esc(consent.handle)}">
<p>Your connector password<br><input type="password" name="password" autocomplete="current-password" autofocus></p>
<p class="row"><button name="decision" value="approve">Allow</button> <button class="light" name="decision" value="deny">Deny</button></p></form></div>`), { headers: consent.headers });
    }
    const form = await req.formData();
    const handle = String(form.get('handle') || '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const bad = await checkPassword(req, env, form.get('password'));
    if (bad) return html(`<h1>Not allowed</h1><div class="card"><p class="bad">${esc(bad)}</p><p>Go back to Claude and start connecting again.</p></div>`, 403);
    const approved = await oauth.approveConsent(req, handle, { scope: ['garmin:read'] });
    const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: 'owner', metadata: { at: Date.now() }, scope: ['garmin:read'], props: { owner: true } });
    await log(env, 'connector', 'an app was allowed to read your data');
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError) return html(`<h1>Can't continue</h1><div class="card"><p>${esc(e.description)}</p><p>Start connecting again from Claude.</p></div>`, 400);
    throw e;
  }
}

const app = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname;
    if (p === '/health') return Response.json({ ok: true });
    const problem = passwordProblem(env);
    if (problem) return passwordHelp(problem);
    if (p === '/authorize') return authorize(req, env);

    if (p === '/login' && req.method === 'POST') {
      if (!sameOrigin(req, env)) return new Response('Forbidden', { status: 403 });
      const bad = await checkPassword(req, env, (await req.formData()).get('password'));
      if (bad) return loginPage(bad);
      return go('/', { 'Set-Cookie': await sessionCookie(env) });
    }
    if (p === '/logout' && req.method === 'POST') return go('/', { 'Set-Cookie': `${COOKIE}=; ${cookieFlags(env).replace('Max-Age=2592000', 'Max-Age=0')}` });

    // Everything below is for the owner only.
    if (!(await isOwner(req, env))) return p === '/' ? loginPage() : go('/');
    if (req.method === 'POST' && !sameOrigin(req, env)) return new Response('Forbidden', { status: 403 });
    if (p === '/key' && req.method === 'POST') {
      const first = !(await hasKey(env));
      try { await setApiKey(env, (await req.formData()).get('key')); } catch (e) { return statusPage(env, '', e.message); }
      // First key: load a year of history in the background, starting with the last few days.
      if (first) { await queueHistory(env, 365); ctx.waitUntil(syncRecent(env).then(() => runJobs(env)).catch(e => log(env, 'sync-error', e.message))); }
      return go(`/?n=${first ? 'connected' : 'key'}`);
    }
    if (p === '/sync' && req.method === 'POST') {
      const r = await syncRecent(env).catch(e => ({ errors: [e.message] }));
      return go(`/?n=${r.errors.length ? 'sync-error' : 'synced'}`);
    }
    if (p === '/history' && req.method === 'POST') {
      const days = Math.max(1, Math.min(730, parseInt((await req.formData()).get('days'), 10) || 365));
      await queueHistory(env, days);
      ctx.waitUntil(runJobs(env).catch(e => log(env, 'history-error', e.message)));
      return go('/?n=history');
    }
    if (p === '/') {
      const n = { connected: '🎉 Connected! Your last few days are loading now, and your past year follows in the background. Next: add it to Claude below.', key: 'New Garmin key saved.', synced: 'Updated from Garmin.', 'sync-error': 'The update had problems. See Recent events.', history: 'History queued. It loads a few requests every 5 minutes.' }[url.searchParams.get('n')];
      return statusPage(env, n);
    }
    return new Response('Not found', { status: 404 });
  },
};

// Built on first request, because this connector's address comes from the request (or PUBLIC_URL).
let provider;
const getProvider = env => provider ??= new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: mcpHandler,
  defaultHandler: app,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ['garmin:read'],
  requiredScopes: ['garmin:read'],
  resourceMetadata: { resource: `${base(env)}/mcp`, authorization_servers: [base(env)] },
  accessTokenTTL: 3600,
  refreshTokenTTL: 90 * 86400,
  refreshTokenIdleTTL: 90 * 86400,
});

export default {
  async fetch(req, env, ctx) {
    origin ||= new URL(req.url).origin;
    await ensureSchema(env);
    return getProvider(env).fetch(req, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      if (passwordProblem(env) || !(await hasKey(env))) return;
      await runJobs(env);
      if (Date.now() - (+(await getMeta(env, 'last_sync')) || 0) > 30 * 60000) await syncRecent(env);
    })().catch(e => log(env, 'cron-error', e.message)));
  },
};
