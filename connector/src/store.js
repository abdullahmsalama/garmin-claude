// D1 storage and syncing: the encrypted access token, pulled Garmin data, history jobs, event log.
import { encrypt, decrypt } from './crypto.js';
import { exchangeKey, GarminClient, GarminError } from './garmin/client.js';
import { GARMIN } from './garmin/config.js';

export const OWNER = 'owner'; // phase 1 has one user; the user_id column is ready for more
const DAY = 864e5;
export const iso = t => new Date(t).toISOString().slice(0, 10);
export const addDays = (d, n) => iso(Date.parse(d) + n * DAY);

// Your time zone: the one in your Garmin settings (saved once a day), else the TZ variable in
// wrangler.jsonc, else UTC. Used for "today" and for every local clock time the tools show.
const validZone = z => { try { return z && new Intl.DateTimeFormat('en-CA', { timeZone: z }) ? z : null; } catch { return null; } };
const zoneCache = new WeakMap(); // per database, re-read every 10 minutes
export async function timeZone(env) {
  const c = zoneCache.get(env.DB);
  if (c && Date.now() - c.at < 10 * 60000) return c.zone;
  const zone = validZone(await getMeta(env, 'time_zone')) || validZone(env.TZ) || 'UTC';
  zoneCache.set(env.DB, { zone, at: Date.now() });
  return zone;
}
const fmts = new Map();
const fmtIn = zone => fmts.get(zone) || fmts.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).get(zone);
// Epoch ms -> "YYYY-MM-DD HH:MM" in `zone`.
export function localTime(zone, ms) {
  if (ms == null || !isFinite(ms)) return null;
  const p = Object.fromEntries(fmtIn(zone).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export const today = async env => localTime(await timeZone(env), Date.now()).slice(0, 10);
// Reads your time zone from Garmin's settings and keeps it.
async function saveTimeZone(env, g) {
  const z = validZone((await g.get(GARMIN.paths.settings).catch(() => null))?.timeZone);
  if (z && z !== (await getMeta(env, 'time_zone'))) { await setMeta(env, 'time_zone', z); zoneCache.delete(env.DB); }
}

export async function log(env, kind, detail = '') {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO events (ts, kind, detail) VALUES (?1, ?2, ?3)').bind(Date.now(), kind, String(detail).slice(0, 300)),
    env.DB.prepare('DELETE FROM events WHERE id < (SELECT MAX(id) - 200 FROM events)'),
  ]);
}
export const getMeta = async (env, key) => (await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first())?.value ?? null;
export const setMeta = (env, key, value) => env.DB.prepare('INSERT INTO meta (key, value, updated) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated = ?3').bind(key, value == null ? null : String(value), Date.now()).run();

// The Garmin Personal API key: typed on the setup page and stored encrypted in D1
// (or a GARMIN_API_KEY secret, if you prefer to set it that way).
const KEY_ID = 'apikey';
export async function apiKey(env) {
  if (env.GARMIN_API_KEY) return env.GARMIN_API_KEY;
  const row = await env.DB.prepare('SELECT enc FROM tokens WHERE id = ?1').bind(KEY_ID).first();
  if (!row) return null;
  try { return await decrypt(env, row.enc); } catch { return null; } // password changed: ask for the key again
}
export const hasKey = async env => !!(await apiKey(env));

// Checks a new key with Garmin, then stores it (encrypted) together with its first access token.
export async function setApiKey(env, key) {
  key = String(key || '').trim();
  if (!key || /\s/.test(key) || key.length < 8 || key.length > 4000) throw new Error("That doesn't look like a Garmin Personal API key. Copy it again from Garmin Connect.");
  let t;
  try { t = await exchangeKey(key, garminBase(env)); } catch (e) {
    throw new Error(e.status === 401 || e.status === 403 ? 'Garmin refused this key. Check you copied all of it, or make a new one.' : `Couldn't check the key with Garmin (${e.message}). Try again in a minute.`);
  }
  const now = Date.now(), up = 'INSERT INTO tokens (id, enc, exp, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO UPDATE SET enc = ?2, exp = ?3, updated = ?4';
  await env.DB.batch([
    env.DB.prepare(up).bind(KEY_ID, await encrypt(env, key), 0, now),
    env.DB.prepare(up).bind(OWNER, await encrypt(env, t.token), t.exp, now),
  ]);
  await setMeta(env, 'key_error', null);
  await log(env, 'key', 'Garmin key saved');
}

// A valid access token: cached (encrypted) in D1, renewed from the Personal API key when it's
// within 30 minutes of expiring or Garmin refused it.
async function accessToken(env, force = false) {
  if (!force) {
    const row = await env.DB.prepare('SELECT enc, exp FROM tokens WHERE id = ?1').bind(OWNER).first();
    if (row && row.exp > Date.now() / 1000 + 1800) {
      try { return await decrypt(env, row.enc); } catch { /* password or key changed: get a fresh token below */ }
    }
  }
  const key = await apiKey(env);
  if (!key) throw new Error('No Garmin API key yet: add it on the setup page');
  try {
    const t = await exchangeKey(key, garminBase(env));
    await env.DB.prepare('INSERT INTO tokens (id, enc, exp, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO UPDATE SET enc = ?2, exp = ?3, updated = ?4')
      .bind(OWNER, await encrypt(env, t.token), t.exp, Date.now()).run();
    await setMeta(env, 'key_error', null);
    return t.token;
  } catch (e) {
    const msg = e.status === 401 || e.status === 403 ? 'Garmin refused the API key (expired or deleted?). Make a new key and add it on the setup page.' : `${e.message}${e.body ? `: ${e.body}` : ''}`;
    await setMeta(env, 'key_error', msg);
    await log(env, 'key-error', msg);
    throw new Error(msg);
  }
}
// GARMIN_BASE is only for local tests against a fake Garmin server.
const garminBase = env => (env.GARMIN_BASE && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.GARMIN_BASE) ? env.GARMIN_BASE : GARMIN.base);
export const garmin = env => new GarminClient(force => accessToken(env, force), garminBase(env));

// ---------- saving ----------
const DROP = ['comments', 'activityLikeDisplayNames', 'activityLikeFullNames', 'activityLikeProfileImageUrls', 'ownerProfileImageUrlSmall', 'ownerProfileImageUrlMedium', 'ownerProfileImageUrlLarge', 'ownerDisplayName', 'ownerFullName', 'ownerId', 'userProfileId', 'userProfilePk', 'userProfilePK'];
const slim = o => { const c = { ...o }; for (const k of DROP) delete c[k]; return c; };

// How each kind is filed: id (unique per user+type), day (local date) and start (epoch ms, optional).
const FILE = {
  activities: a => ({ id: String(a.activityId), day: a.startTimeLocal?.slice(0, 10), start: a.beginTimestamp ?? null }),
  dailies: d => ({ id: d.calendarDate, day: d.calendarDate }),
  sleep: s => ({ id: s.calendarDate, day: s.calendarDate }),
  hrv: h => ({ id: h.calendarDate, day: h.calendarDate }),
  bodyBattery: b => ({ id: b.date, day: b.date }),
  weight: w => ({ id: w.samplePk != null ? String(w.samplePk) : `${w.timestampGMT ?? w.date}-${w.weight}`, day: w.calendarDate || (typeof w.date === 'string' ? w.date : null), start: typeof w.date === 'number' ? w.date : null }),
};

export async function save(env, type, list, fileFn = FILE[type]) {
  const now = Date.now();
  const stmts = [];
  for (const item of list || []) {
    if (!item || typeof item !== 'object') continue;
    const f = fileFn(item);
    if (!f.id || f.id === 'undefined' || !f.day) continue;
    stmts.push(env.DB.prepare(`INSERT INTO summaries (user_id, type, id, day, start, ref, data, received) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)
      ON CONFLICT (user_id, type, id) DO UPDATE SET day = ?4, start = ?5, data = ?6, received = ?7`).bind(OWNER, type, f.id, f.day, f.start ?? null, JSON.stringify(slim(item)), now));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

// Fetches one kind for a date range from Garmin and stores it.
export async function pull(env, kind, from, to, g = garmin(env)) {
  const list = await {
    activities: () => g.activities(from, to),
    dailies: () => g.dailies(from, to),
    sleep: () => g.sleep(from, to),
    hrv: () => g.hrv(from, to),
    bodyBattery: () => g.bodyBattery(from, to),
    weight: () => g.weight(from, to > iso(Date.now()) ? iso(Date.now()) : to), // no dates past today in UTC
  }[kind]();
  return save(env, kind, list);
}

// Recent data: the last few days of everything, plus HR zones and fitness age once a day.
// Called by the cron every 30 min, and before a tool answers if the last sync is old.
export async function syncRecent(env) {
  const g = garmin(env);
  if (!(await getMeta(env, 'time_zone'))) await saveTimeZone(env, g); // first sync: know "today" before fetching
  const to = await today(env), counts = {}, errors = [];
  const plan = [['activities', 3], ['dailies', 3], ['sleep', 3], ['hrv', 3], ['bodyBattery', 2], ['weight', 14]];
  for (const [kind, days] of plan) {
    try { counts[kind] = await pull(env, kind, addDays(to, -(days - 1)), to, g); } catch (e) { errors.push(`${kind}: ${e.message}${e.body ? ` ${String(e.body).slice(0, 150)}` : ''}`); if (/API key|token request/.test(e.message)) break; }
  }
  if (!errors.length && (await getMeta(env, 'profile_day')) !== to) {
    try {
      const zones = await g.hrZones();
      await save(env, 'hrZones', [zones].map(z => ({ list: z })), () => ({ id: 'current', day: to }));
      if (Array.isArray(zones) && zones.length) await save(env, 'hrZonesHistory', [{ list: zones, date: to }], x => ({ id: x.date, day: x.date })); // LTHR / max HR history
      await saveTimeZone(env, g);
      const fa = await g.fitnessAge(addDays(to, -1)).catch(() => null);
      if (fa) await save(env, 'fitnessAge', [{ value: fa, date: addDays(to, -1) }], x => ({ id: x.date, day: x.date }));
      await setMeta(env, 'profile_day', to);
    } catch (e) { errors.push(`profile: ${e.message}`); }
  }
  await setMeta(env, 'last_sync', Date.now());
  await setMeta(env, 'last_sync_result', errors.length ? `errors: ${errors.join(' | ')}` : 'ok');
  if (errors.length) await log(env, 'sync-error', errors.join(' | '));
  return { counts, errors };
}
export async function syncIfStale(env, maxAgeMin = 15) {
  const last = +(await getMeta(env, 'last_sync')) || 0;
  if (Date.now() - last < maxAgeMin * 60000) return null;
  return syncRecent(env);
}

// Detail for one activity (splits, planned workout), fetched once on first request and kept.
export async function activityDetail(env, id) {
  const row = await env.DB.prepare("SELECT data FROM summaries WHERE user_id = ?1 AND type = 'activityDetail' AND id = ?2").bind(OWNER, id).first();
  if (row) return JSON.parse(row.data);
  const g = garmin(env);
  const detail = await g.activity(id);
  const workouts = await g.get(GARMIN.paths.activityWorkouts(id)).catch(() => []);
  const data = { detail: slim(detail || {}), workouts };
  const day = detail?.summaryDTO?.startTimeLocal?.slice(0, 10) || await today(env);
  await save(env, 'activityDetail', [data], () => ({ id: String(id), day }));
  return data;
}

// ---------- history ----------
export async function queueHistory(env, days) {
  const to = await today(env), first = addDays(to, -(days - 1));
  await env.DB.prepare("DELETE FROM jobs WHERE status IN ('queued', 'retry')").run();
  const stmts = [];
  for (const [kind, chunk] of Object.entries(GARMIN.chunkDays)) {
    for (let end = to; end >= first; end = addDays(end, -chunk)) {
      const start = addDays(end, -(chunk - 1)) < first ? first : addDays(end, -(chunk - 1));
      stmts.push(env.DB.prepare('INSERT INTO jobs (kind, from_day, to_day, updated) VALUES (?1, ?2, ?3, ?4)').bind(kind, start, end, Date.now()));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await log(env, 'history', `queued ${stmts.length} requests for ${days} days`);
  return stmts.length;
}

export async function runJobs(env, max = 6) {
  const rows = (await env.DB.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'retry') AND updated <= ?1 ORDER BY id LIMIT ?2").bind(Date.now(), max).all()).results;
  if (!rows.length) return 0;
  const g = garmin(env);
  for (const row of rows) {
    let status = 'done', msg = null, updated = Date.now();
    try { msg = `${await pull(env, row.kind, row.from_day, row.to_day, g)} rows`; } catch (e) {
      msg = `${e.status || ''} ${e.message}${e.body ? `: ${e.body}` : ''}`.trim().slice(0, 200);
      const temporary = e.status === 429 || e.status >= 500 || !(e instanceof GarminError);
      if (temporary && row.tries < 5 && !/API key|token request/.test(e.message)) { status = 'retry'; updated = Date.now() + (e.status === 429 ? 15 : 5) * 60000; } else status = 'failed';
    }
    await env.DB.prepare('UPDATE jobs SET status = ?2, msg = ?3, tries = tries + 1, updated = ?4 WHERE id = ?1').bind(row.id, status, msg, updated).run();
    if (status === 'failed') await log(env, 'history-error', `${row.kind} ${row.from_day}..${row.to_day}: ${msg}`);
    if (status !== 'done') break; // Garmin is unhappy: stop for this round
  }
  const left = (await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'retry')").first()).n;
  if (!left) await log(env, 'history', 'history loading finished');
  return rows.length;
}
