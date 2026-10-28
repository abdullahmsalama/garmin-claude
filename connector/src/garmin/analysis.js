// Turns a decoded FIT file (+ optional Garmin chart extras) into what Claude needs from inside a workout:
// a time series at a fixed resolution, per-km splits, laps, legs (multisport), strength sets, pauses,
// best efforts and an analysis (HR drift / decoupling, efficiency factor, zones, variability).
// Everything is computed once on the server and stored; raw files are not kept.
import { SPORT, EXERCISE } from './fit.js';

export const ANALYSIS_VERSION = 1;
const r = (v, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
export const paceStr = s => { if (s == null || !isFinite(s) || s <= 0 || s > 3600) return null; const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const paceOf = speed => (speed > 0.3 ? 1000 / speed : null); // s per km
const isFootSport = s => ['running', 'walking', 'hiking', 'generic', 'training'].includes(s);
const STOP_TYPES = new Set([1, 4, 8, 9]);

// Garmin chart metrics we add on top of the file (names from /activity-service/activity/{id}/details).
export const EXTRA_KEYS = { directGradeAdjustedSpeed: 'gap', directAvailableStamina: 'stamina', directPotentialStamina: 'stamina_potential', directBodyBattery: 'body_battery', directPerformanceCondition: 'performance_condition', directVerticalSpeed: 'vertical_speed', directRespirationRate: 'respiration' };
export function chartExtras(details) {
  const keys = (details?.metricDescriptors || []).map(d => d.key);
  const ti = keys.indexOf('directTimestamp');
  if (ti < 0) return null;
  const rows = (details.activityDetailMetrics || []).map(m => m.metrics).filter(m => Array.isArray(m) && m[ti] != null).sort((a, b) => a[ti] - b[ti]);
  const cols = Object.entries(EXTRA_KEYS).map(([k, name]) => [name, keys.indexOf(k)]).filter(([, i]) => i >= 0);
  if (!rows.length || !cols.length) return null;
  return { ts: rows.map(m => m[ti]), cols: Object.fromEntries(cols.map(([name, i]) => [name, rows.map(m => (m[i] == null ? null : m[i]))])) };
}
function nearest(ts, arr) { let lo = 0, hi = arr.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < ts) lo = mid + 1; else hi = mid; } return lo > 0 && Math.abs(arr[lo - 1] - ts) < Math.abs(arr[lo] - ts) ? lo - 1 : lo; }

// ---------- points ----------
// One point per record: absolute time, elapsed s, moving s, distance m, and the channels (null when missing).
function points(fit, sport) {
  const recs = fit.records.filter(x => x.timestamp != null).sort((a, b) => a.timestamp - b.timestamp);
  if (!recs.length) return { pts: [], pauses: [] };
  const start = fit.sessions[0]?.start_time ?? recs[0].timestamp;
  // Timer stop..start intervals from events; if there are none, gaps over 10 s count as pauses.
  const timer = fit.events.filter(e => e.event === 0 && e.timestamp != null).sort((a, b) => a.timestamp - b.timestamp);
  const paused = [];
  let stopAt = null;
  for (const e of timer) {
    if (STOP_TYPES.has(e.event_type)) { if (stopAt == null) stopAt = e.timestamp; } else if (e.event_type === 0 && stopAt != null) { if (e.timestamp - stopAt >= 1000) paused.push([stopAt, e.timestamp]); stopAt = null; }
  }
  // Seconds of [t0, t1] that fall inside a pause.
  const fromEvents = paused.length > 0; // no timer events: every gap over 10 s is a pause (not just the first)
  const pausedIn = (t0, t1) => paused.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, t1) - Math.max(a, t0)), 0) / 1000;
  const foot = isFootSport(sport);
  const pts = [];
  let mt = 0, dist = 0, prev = null;
  for (const x of recs) {
    const dt = prev ? (x.timestamp - prev.timestamp) / 1000 : 0;
    const gap = dt > 10 && !fromEvents;
    if (prev && dt > 0 && !gap) mt += Math.max(0, dt - pausedIn(prev.timestamp, x.timestamp));
    if (gap) paused.push([prev.timestamp, x.timestamp]);
    const speed = x.enhanced_speed ?? x.speed;
    if (x.distance != null) dist = x.distance; else if (speed != null && prev && !gap) dist += speed * dt;
    const cad = x.cadence == null ? null : foot ? (x.cadence + (x.fractional_cadence || 0)) * 2 : x.cadence + (x.fractional_cadence || 0);
    pts.push({
      ts: x.timestamp, el: (x.timestamp - start) / 1000, mt, d: dist, speed: speed ?? null, hr: x.heart_rate ?? null, cad, pwr: x.power ?? null,
      alt: x.enhanced_altitude ?? x.altitude ?? null, vo: x.vertical_oscillation != null ? x.vertical_oscillation / 10 : null, gct: x.stance_time ?? null,
      gct_bal: x.stance_time_balance ?? null, vr: x.vertical_ratio ?? null, stride: x.step_length != null ? x.step_length / 1000 : null,
      temp: x.temperature ?? null, resp: x.enhanced_respiration_rate ?? null, perf: x.performance_condition ?? null,
    });
    prev = x;
  }
  return { pts, pauses: paused.sort((a, b) => a[0] - b[0]) };
}

const CH = ['speed', 'hr', 'cad', 'pwr', 'alt', 'vo', 'gct', 'gct_bal', 'vr', 'stride', 'temp', 'resp', 'perf'];
// Time-weighted averages over points [i0, i1] (by moving-time steps), plus max HR/power and climb.
function agg(pts, i0, i1) {
  const s = {}, w = {};
  let maxHr = null, maxPwr = null, up = 0, down = 0, lastAlt = null;
  for (let i = Math.max(i0, 1); i <= i1; i++) {
    const dt = pts[i].mt - pts[i - 1].mt;
    for (const c of CH) { const v = pts[i][c]; if (v != null && dt > 0) { s[c] = (s[c] || 0) + v * dt; w[c] = (w[c] || 0) + dt; } }
    if (pts[i].hr != null) maxHr = Math.max(maxHr ?? 0, pts[i].hr);
    if (pts[i].pwr != null) maxPwr = Math.max(maxPwr ?? 0, pts[i].pwr);
    const a = pts[i].alt;
    if (a != null) { if (lastAlt != null) { const dd = a - lastAlt; if (Math.abs(dd) >= 1) { if (dd > 0) up += dd; else down -= dd; lastAlt = a; } } else lastAlt = a; }
  }
  const avg = c => (w[c] ? s[c] / w[c] : null);
  return { avg, maxHr, maxPwr, up, down };
}
// Moving time at an exact distance (linear between the two records around it).
function timeAtDistance(pts, D) {
  const i = idxAtDistance(pts, D);
  if (i <= 0) return i === 0 ? pts[0].mt : null;
  const a = pts[i - 1], b = pts[i];
  return b.d === a.d ? b.mt : a.mt + (D - a.d) / (b.d - a.d) * (b.mt - a.mt);
}
const segment = (pts, i0, i1, foot, exact = null) => {
  const a = agg(pts, i0, i1);
  const dist = exact ? exact.dist : pts[i1].d - pts[i0].d, time = exact ? exact.time : pts[i1].mt - pts[i0].mt;
  const sp = time > 0 ? dist / time : null;
  return {
    distance_m: r(dist, 0), time_s: r(time, 0), pace_min_km: foot ? paceStr(paceOf(sp)) : null, speed_kmh: !foot ? r(sp * 3.6) : null,
    avg_hr: r(a.avg('hr'), 0), max_hr: a.maxHr, avg_cadence: r(a.avg('cad'), 0), avg_power: r(a.avg('pwr'), 0), max_power: a.maxPwr,
    elev_gain_m: r(a.up, 0), elev_loss_m: r(a.down, 0),
    vertical_oscillation_cm: r(a.avg('vo')), ground_contact_ms: r(a.avg('gct'), 0), gct_balance_left_pct: r(a.avg('gct_bal')), vertical_ratio_pct: r(a.avg('vr')), stride_m: r(a.avg('stride'), 2),
  };
};

// Index where distance first reaches `target` (linear search from `from`).
function idxAtDistance(pts, target, from = 0) { for (let i = from; i < pts.length; i++) if (pts[i].d >= target) return i; return -1; }

// Fastest time over each distance, using moving time (pauses don't count).
const RUN_DISTANCES = [[400, '400m'], [1000, '1k'], [1609.34, '1mile'], [3000, '3k'], [5000, '5k'], [10000, '10k'], [15000, '15k'], [21097.5, 'half_marathon'], [42195, 'marathon']];
const RIDE_DISTANCES = [[5000, '5k'], [10000, '10k'], [20000, '20k'], [40000, '40k'], [100000, '100k']];
function bestEfforts(pts, foot) {
  const out = {};
  for (const [D, name] of foot ? RUN_DISTANCES : RIDE_DISTANCES) {
    if (!pts.length || pts.at(-1).d - pts[0].d < D) continue;
    let j = 0, best = null;
    for (let i = 1; i < pts.length; i++) {
      while (j + 1 < i && pts[i].d - pts[j + 1].d >= D) j++;
      const dd = pts[i].d - pts[j].d;
      if (dd >= D && dd > 0) { const t = (pts[i].mt - pts[j].mt) * D / dd; if (t > 0 && (!best || t < best.t)) best = { t, at: pts[j].d }; }
    }
    if (best) out[name] = { time_s: r(best.t, 0), time: fmtTime(best.t), pace_min_km: foot ? paceStr(best.t / (D / 1000)) : null, starts_at_km: r(best.at / 1000, 2) };
  }
  return out;
}
// Best average power for each duration (moving time).
function bestPower(pts) {
  if (!pts.some(p => p.pwr != null)) return null;
  const out = {};
  for (const [S, name] of [[5, '5s'], [15, '15s'], [30, '30s'], [60, '1min'], [300, '5min'], [600, '10min'], [1200, '20min'], [3600, '60min']]) {
    let j = 0, sum = 0, best = null;
    const e = pts.map((p, i) => (i ? (p.pwr ?? 0) * Math.max(0, p.mt - pts[i - 1].mt) : 0));
    for (let i = 1; i < pts.length; i++) {
      sum += e[i];
      while (j + 1 < i && pts[i].mt - pts[j + 1].mt >= S) { j++; sum -= e[j]; }
      const span = pts[i].mt - pts[j].mt;
      if (span >= S && span > 0) { const v = sum / span; if (best == null || v > best) best = v; }
    }
    if (best != null) out[name] = r(best, 0);
  }
  return Object.keys(out).length ? out : null;
}
export const fmtTime = s => { if (s == null) return null; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };

// Normalized power (30 s rolling average, 4th power mean).
function normalizedPower(pts) {
  const p = pts.filter(x => x.pwr != null);
  if (p.length < 60) return null;
  const roll = [];
  let q = [], sum = 0;
  for (const x of p) { q.push(x.pwr); sum += x.pwr; if (q.length > 30) sum -= q.shift(); if (q.length === 30) roll.push(sum / 30); }
  return roll.length ? r(Math.pow(roll.reduce((s, v) => s + v ** 4, 0) / roll.length, 0.25), 0) : null;
}

// ---------- the whole thing ----------
// fit: decodeFit() output; extras: chartExtras() or null; zones: [z1..z5 floors] or null.
export function analyze(fit, { extras = null, zones = null } = {}) {
  const s0 = fit.sessions[0] || {};
  const legsRaw = fit.sessions.length > 1 ? fit.sessions : null;
  const sport = SPORT[s0.sport] || (s0.sport != null ? `sport_${s0.sport}` : 'unknown');
  const { pts, pauses } = points(fit, sport);
  const foot = isFootSport(sport);
  const res = { v: ANALYSIS_VERSION, sport, points: pts.length };
  if (extras) for (const p of pts) { const k = nearest(p.ts, extras.ts); if (Math.abs(extras.ts[k] - p.ts) <= 30000) for (const [name, col] of Object.entries(extras.cols)) p[name] = col[k]; }

  // Series at a fixed moving-time resolution (max ~1500 points), averages per bucket.
  const moving = pts.length ? pts.at(-1).mt : 0;
  const step = Math.max(1, Math.ceil(moving / 1500));
  const chans = [...CH, ...(extras ? Object.keys(extras.cols) : [])];
  const series = { step_s: step, t_s: [], elapsed_s: [], km: [] };
  for (const c of chans) series[c] = [];
  let b = 0;
  for (let i = 0; i < pts.length;) {
    const end = (b + 1) * step;
    const group = [];
    while (i < pts.length && pts[i].mt < end) group.push(pts[i++]);
    if (!group.length) { b = Math.floor(pts[i]?.mt / step) || b + 1; continue; }
    const last = group.at(-1);
    series.t_s.push(b * step); series.elapsed_s.push(r(last.el, 0)); series.km.push(r(last.d / 1000, 3));
    for (const c of chans) { const v = group.map(g => g[c]).filter(x => x != null); series[c].push(v.length ? r(v.reduce((a, x) => a + x, 0) / v.length, 2) : null); }
    b++;
  }
  for (const c of chans) if (series[c].every(v => v == null)) delete series[c];
  res.series = series;

  // Per-km splits (computed from distance, so a one-lap run still gets them).
  const splits = [];
  if (pts.length > 1 && pts.at(-1).d >= 200) {
    let i0 = 0;
    for (let k = 1; ; k++) {
      const i1 = idxAtDistance(pts, k * 1000, i0);
      const tStart = timeAtDistance(pts, (k - 1) * 1000) ?? 0;
      if (i1 < 0) { const rest = pts.at(-1).d - (k - 1) * 1000; if (pts.length - 1 > i0 && rest >= 50) splits.push({ km: k, partial: true, ...segment(pts, i0, pts.length - 1, foot, { dist: rest, time: pts.at(-1).mt - tStart }) }); break; }
      splits.push({ km: k, partial: false, ...segment(pts, i0, i1, foot, { dist: 1000, time: timeAtDistance(pts, k * 1000) - tStart }) });
      i0 = i1;
    }
    if (extras?.cols.gap) for (const sp of splits) { const from = (sp.km - 1) * 1000, to = from + sp.distance_m; const g = pts.filter(p => p.d > from && p.d <= to && p.gap != null).map(p => p.gap); sp.grade_adjusted_pace_min_km = g.length && foot ? paceStr(paceOf(g.reduce((a, x) => a + x, 0) / g.length)) : null; }
  }
  res.splits_km = splits;

  // Laps as recorded by the watch.
  res.laps = fit.laps.map((l, i) => ({
    lap: i + 1, distance_m: r(l.total_distance, 0), time_s: r(l.total_timer_time, 0), elapsed_s: r(l.total_elapsed_time, 0),
    pace_min_km: foot ? paceStr(paceOf(l.enhanced_avg_speed ?? l.avg_speed)) : null, speed_kmh: !foot ? r((l.enhanced_avg_speed ?? l.avg_speed) * 3.6) : null,
    avg_hr: l.avg_heart_rate ?? null, max_hr: l.max_heart_rate ?? null, avg_cadence: l.avg_cadence != null ? r(foot ? (l.avg_cadence + (l.avg_fractional_cadence || 0)) * 2 : l.avg_cadence, 0) : null,
    avg_power: l.avg_power ?? null, elev_gain_m: l.total_ascent ?? null, elev_loss_m: l.total_descent ?? null,
  }));

  // Multisport legs (one session each).
  res.legs = legsRaw ? legsRaw.map((x, i) => {
    const sp = SPORT[x.sport] || `sport_${x.sport}`, f = isFootSport(sp), v = x.enhanced_avg_speed ?? x.avg_speed;
    return { leg: i + 1, sport: sp, distance_km: r((x.total_distance || 0) / 1000, 2), time_s: r(x.total_timer_time, 0), elapsed_s: r(x.total_elapsed_time, 0), pace_min_km: f ? paceStr(paceOf(v)) : null, speed_kmh: !f && v ? r(v * 3.6) : null, avg_hr: x.avg_heart_rate ?? null, max_hr: x.max_heart_rate ?? null, avg_power: x.avg_power ?? null, elev_gain_m: x.total_ascent ?? null };
  }) : null;

  // Strength sets (active sets and rests).
  res.sets = fit.sets.length ? fit.sets.map((x, i) => ({
    set: i + 1, type: x.set_type === 0 ? 'rest' : 'active', exercise: x.category?.length ? (x.category[0] === 65534 ? 'unidentified' : EXERCISE[x.category[0]] || `category_${x.category[0]}`) : null, exercise_subtype: x.category_subtype?.[0] ?? null,
    reps: x.repetitions ?? null, weight_kg: x.weight != null ? r(x.weight, 1) : null, duration_s: r(x.duration, 0),
  })) : null;

  // Pauses (timer stopped) and standing still with the timer running.
  res.pauses = pauses.map(([a, b2]) => { const k = pts.findIndex(p => p.ts >= a); return { at_elapsed_min: r((a - (pts[0]?.ts ?? a)) / 60000, 1), at_km: k >= 0 ? r(pts[k].d / 1000, 2) : null, duration_s: r((b2 - a) / 1000, 0) }; });
  const still = [];
  if (foot) { let s = null; for (let i = 1; i < pts.length; i++) { const slow = pts[i].speed != null && pts[i].speed < 0.5; if (slow && s == null) s = i; if ((!slow || i === pts.length - 1) && s != null) { const dur = pts[i].mt - pts[s].mt; if (dur >= 15) still.push({ at_km: r(pts[s].d / 1000, 2), duration_s: r(dur, 0) }); s = null; } } }
  res.standing_still = still;

  res.best_efforts = bestEfforts(pts, foot);
  res.best_power_w = bestPower(pts);

  // Analysis: totals, HR drift / decoupling (after a 5-min warm-up), efficiency factor, zones, variability.
  const all = pts.length > 1 ? agg(pts, 0, pts.length - 1) : null;
  const dist = pts.length ? pts.at(-1).d - pts[0].d : 0;
  const avgSpeed = moving > 0 ? dist / moving : null;
  const warm = Math.min(300, moving * 0.1);
  const steady = pts.filter(p => p.mt >= warm);
  let decoupling = null, drift = null, ef1 = null, ef2 = null;
  if (steady.length > 60 && moving - warm >= 600) {
    const mid = (steady[0].mt + steady.at(-1).mt) / 2;
    const half = h => { const g = steady.filter(p => (h ? p.mt >= mid : p.mt < mid)); const hr = mean(g.map(p => p.hr)); const out = mean(g.map(p => (sport === 'cycling' ? p.pwr : p.gap ?? p.speed))); return { hr, out }; };
    const a = half(0), b2 = half(1);
    if (a.hr && b2.hr && a.out && b2.out) { ef1 = a.out / a.hr; ef2 = b2.out / b2.hr; decoupling = r((ef1 - ef2) / ef1 * 100); drift = r(b2.hr - a.hr, 0); }
  }
  const hrAvg = all?.avg('hr');
  const gapAvg = mean(pts.map(p => p.gap));
  const zoneTime = zones && zones.length === 5 ? (() => {
    const z = [0, 0, 0, 0, 0, 0];
    for (let i = 1; i < pts.length; i++) { const hr = pts[i].hr, dt = pts[i].mt - pts[i - 1].mt; if (hr == null || dt <= 0) continue; let k = 0; while (k < 5 && hr >= zones[k]) k++; z[k] += dt; }
    return { below_z1_min: r(z[0] / 60), z1_min: r(z[1] / 60), z2_min: r(z[2] / 60), z3_min: r(z[3] / 60), z4_min: r(z[4] / 60), z5_min: r(z[5] / 60), floors_bpm: zones };
  })() : null;
  const fullSplits = splits.filter(x => !x.partial && x.time_s);
  const paces = fullSplits.map(x => x.time_s);
  const firstHalf = fullSplits.slice(0, Math.floor(fullSplits.length / 2)), secondHalf = fullSplits.slice(Math.ceil(fullSplits.length / 2));
  res.analysis = {
    sport, distance_km: r(dist / 1000, 2), moving_time: fmtTime(moving), elapsed_time: pts.length ? fmtTime(pts.at(-1).el) : null, paused_s: r(pauses.reduce((s, [a, b2]) => s + (b2 - a) / 1000, 0), 0),
    avg_pace_min_km: foot ? paceStr(paceOf(avgSpeed)) : null, avg_speed_kmh: !foot && avgSpeed ? r(avgSpeed * 3.6) : null, grade_adjusted_pace_min_km: foot && gapAvg ? paceStr(paceOf(gapAvg)) : null,
    avg_hr: r(hrAvg, 0), max_hr: all?.maxHr ?? null, avg_power: r(all?.avg('pwr'), 0), normalized_power: normalizedPower(pts),
    efficiency_factor: hrAvg && avgSpeed ? (sport === 'cycling' && all?.avg('pwr') ? r(all.avg('pwr') / hrAvg, 2) : r(avgSpeed * 60 / hrAvg, 2)) : null,
    efficiency_factor_note: sport === 'cycling' ? 'watts per beat' : 'metres per minute per beat (higher = fitter at the same effort)',
    efficiency_factor_grade_adjusted: foot && hrAvg && gapAvg ? r(gapAvg * 60 / hrAvg, 2) : null,
    decoupling_pct: decoupling, hr_drift_bpm: drift,
    decoupling_note: decoupling == null ? 'Needs at least 10 minutes after a 5-minute warm-up.' : `${sport === 'cycling' ? 'Power' : 'Pace'}:HR change, second half vs first half (after warm-up). Under 5% on a steady effort = good aerobic fitness; only meaningful if the effort was steady.`,
    negative_split_s_per_km: firstHalf.length && secondHalf.length ? r(mean(secondHalf.map(x => x.time_s)) - mean(firstHalf.map(x => x.time_s)), 0) : null,
    km_pace_variability_pct: paces.length >= 3 ? r(stdev(paces) / mean(paces) * 100) : null,
    avg_cadence: r(all?.avg('cad'), 0), cadence_sd: r(stdev(pts.map(p => p.cad).filter(v => v != null && v > 0)), 1),
    avg_stride_m: r(all?.avg('stride'), 2), avg_vertical_oscillation_cm: r(all?.avg('vo')), avg_vertical_ratio_pct: r(all?.avg('vr')), avg_ground_contact_ms: r(all?.avg('gct'), 0), avg_gct_balance_left_pct: r(all?.avg('gct_bal')),
    elev_gain_m: r(all?.up, 0), elev_loss_m: r(all?.down, 0), avg_temperature_c: r(all?.avg('temp')),
    stamina_start_pct: extras?.cols.stamina ? firstNum(pts.map(p => p.stamina)) : null, stamina_end_pct: extras?.cols.stamina ? firstNum(pts.map(p => p.stamina).reverse()) : null,
    body_battery_start: extras?.cols.body_battery ? firstNum(pts.map(p => p.body_battery)) : null, body_battery_end: extras?.cols.body_battery ? firstNum(pts.map(p => p.body_battery).reverse()) : null,
    hr_zones: zoneTime,
    pauses: res.pauses.length, standing_still_stops: still.length,
  };
  return res;
}
const mean = a => { const v = a.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const stdev = a => { const m = mean(a); return m == null || a.length < 2 ? null : Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const firstNum = a => a.find(v => v != null) ?? null;

// Downsamples a stored series to about n points (averages per bucket), as rows for Claude.
export function downsample(series, n = 120, channels = null, foot = true) {
  const len = series.t_s.length;
  if (!len) return { rows: [], columns: [] };
  const keep = Object.keys(series).filter(k => !['step_s', 't_s', 'elapsed_s', 'km'].includes(k) && (!channels || channels.includes(k)));
  const per = Math.max(1, Math.ceil(len / Math.max(10, Math.min(2000, n))));
  const LABEL = { speed: 'pace_min_km', hr: 'hr_bpm', cad: 'cadence', pwr: 'power_w', alt: 'altitude_m', vo: 'vertical_oscillation_cm', gct: 'ground_contact_ms', gct_bal: 'gct_balance_left_pct', vr: 'vertical_ratio_pct', stride: 'stride_m', temp: 'temperature_c', resp: 'respiration_brpm', perf: 'performance_condition', gap: 'grade_adjusted_pace_min_km', stamina: 'stamina_pct', stamina_potential: 'stamina_potential_pct', body_battery: 'body_battery', performance_condition: 'performance_condition_garmin', vertical_speed: 'vertical_speed_m_s', respiration: 'respiration_brpm_garmin' };
  const columns = ['min', 'km', ...keep.map(k => (k === 'speed' && !foot ? 'speed_kmh' : LABEL[k] || k))];
  const rows = [];
  for (let i = 0; i < len; i += per) {
    const j = Math.min(len, i + per);
    const avg = k => { const v = series[k].slice(i, j).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    rows.push([r(series.t_s[i] / 60, 1), series.km[j - 1], ...keep.map(k => { const v = avg(k); return k === 'gap' || (k === 'speed' && foot) ? paceStr(paceOf(v)) : k === 'speed' ? r(v * 3.6, 1) : r(v, k === 'stride' ? 2 : 1); })]);
  }
  return { columns, rows, every_s: per * series.step_s, note: 'min = moving minutes; pace columns are min:sec per km; null = not recorded' };
}
