// Garmin Connect API client. Knows nothing about D1, MCP or the owner: it gets an access token from
// the caller (`getToken`), so the same client works for a personal key now and per-user tokens later.
import { GARMIN } from './config.js';

export class GarminError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

// Trades a Personal API key for an access token. The response format isn't in Garmin's docs, so we
// accept the usual OAuth names and fall back to 24 h (Garmin's stated lifetime).
export async function exchangeKey(apiKey, base = GARMIN.base) {
  const r = await fetch(base + GARMIN.tokenPath, { method: 'POST', headers: { Authorization: `ApiKey ${apiKey}`, Accept: '*/*' } }); // asking for JSON here gets a 406
  const text = await r.text();
  if (!r.ok) throw new GarminError(`Garmin token request failed (${r.status})`, r.status, text.slice(0, 200));
  let j;
  try { j = JSON.parse(text); } catch { j = { access_token: text.trim() }; }
  if (typeof j === 'string') j = { access_token: j };
  const token = j.access_token || j.accessToken || j.token || j.data?.access_token || j.data?.accessToken;
  if (!token || typeof token !== 'string') throw new GarminError(`Garmin token response had no token (fields: ${Object.keys(j).join(', ')})`, 502);
  const now = Math.floor(Date.now() / 1000);
  const ttl = +(j.expires_in ?? j.expiresIn ?? 0);
  const at = j.expires_at ?? j.expiresAt ?? j.expiry ?? j.expiration;
  const exp = ttl > 0 ? now + ttl : at ? Math.floor((typeof at === 'number' ? (at > 1e12 ? at / 1000 : at) : Date.parse(at) / 1000)) : now + 86400;
  return { token, exp: isFinite(exp) && exp > now ? exp : now + 3600 };
}

export class GarminClient {
  // getToken(force): an access token; force = the last one was refused, get a new one.
  constructor(getToken, base = GARMIN.base) { this.getToken = getToken; this.base = base; }

  async get(path, params, retried = false) {
    const u = new URL(path, this.base);
    for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, String(v));
    const r = await fetch(u, { headers: { Authorization: `Bearer ${await this.getToken(retried)}`, Accept: 'application/json' } });
    if (r.status === 401 && !retried) return this.get(path, params, true);
    const text = await r.text();
    if (!r.ok) throw new GarminError(`Garmin ${u.pathname} ${r.status}`, r.status, text.slice(0, 200));
    try { return text ? JSON.parse(text) : null; } catch { throw new GarminError(`Garmin ${u.pathname}: not JSON`, 502, text.slice(0, 200)); }
  }

  // Activities whose local start date is in [from, to], all pages.
  async activities(from, to) {
    const out = [];
    for (let start = 0; start < 2000; start += 99) {
      const page = await this.get(GARMIN.paths.activities, { startDate: from, endDate: to, start, limit: 99, sortOrder: 'asc' });
      if (!Array.isArray(page)) break;
      out.push(...page);
      if (page.length < 99) break;
    }
    return out;
  }
  activity(id) { return this.get(GARMIN.paths.activity(id)); }
  async dailies(from, to) { const r = await this.get(GARMIN.paths.dailies, { startDate: from, endDate: to }); return r?.data || []; }
  async sleep(from, to) { const r = await this.get(GARMIN.paths.sleep, { startDate: from, endDate: to }); return Array.isArray(r) ? r : []; }
  async hrv(from, to) { const r = await this.get(GARMIN.paths.hrv(from, to)); return r?.hrvSummaries || []; }
  async bodyBattery(from, to) { const r = await this.get(GARMIN.paths.bodyBattery, { startDate: from, endDate: to }); return Array.isArray(r) ? r : []; }
  // Weight: the "range" endpoint (the "all" one answers most ranges with an empty 400), "all" as a fallback.
  async weight(from, to) {
    try {
      const r = await this.get(GARMIN.paths.weightRange(from, to), { includeAll: true });
      return (r?.dailyWeightSummaries || []).flatMap(d => d.allWeightMetrics?.length ? d.allWeightMetrics : d.latestWeight ? [d.latestWeight] : []);
    } catch (e) {
      if (e.status !== 400 && e.status !== 404) throw e;
      const r = await this.get(GARMIN.paths.weight(from, to)); return Array.isArray(r) ? r : [];
    }
  }
  // The original activity file (a zip) as bytes.
  async download(id, retried = false) {
    const r = await fetch(new URL(GARMIN.paths.download(id), this.base), { headers: { Authorization: `Bearer ${await this.getToken(retried)}` } });
    if (r.status === 401 && !retried) return this.download(id, true);
    if (!r.ok) throw new GarminError(`Garmin activity file ${r.status}`, r.status, (await r.text()).slice(0, 200));
    return r.arrayBuffer();
  }
  details(id, points = 2000) { return this.get(GARMIN.paths.details(id), { maxChartSize: points, maxPolylineSize: 0 }); }
  dailyHeartRate(date) { return this.get(GARMIN.paths.dailyHeartRate, { date }); }
  hrvDay(date) { return this.get(GARMIN.paths.hrvDay(date)); }
  sleepDay(date) { return this.get(GARMIN.paths.sleepDay, { date }); }
  userSummary(date) { return this.get(GARMIN.paths.userSummary, { calendarDate: date }); }
  spo2(date) { return this.get(GARMIN.paths.spo2(date)); }
  hrZones() { return this.get(GARMIN.paths.hrZones); }
  fitnessAge(date) { return this.get(GARMIN.paths.fitnessAge(date)); }
}
