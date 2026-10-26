// Read-only MCP tools over the owner's Garmin data. Answers come from D1 (synced from Garmin);
// recent days are refreshed from Garmin first when the last sync is older than 15 minutes.
import * as N from './garmin/normalize.js';
import { OWNER, iso, addDays, syncIfStale, activityDetail, getMeta } from './store.js';

const DAY = 864e5;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
function range(args, defDays = 7, maxDays = 400) {
  const to = isDate(args?.to) ? args.to : iso(Date.now() + DAY / 2);
  let from = isDate(args?.from) ? args.from : addDays(to, -(defDays - 1));
  if (from > to) throw new Error('"from" is after "to"');
  if ((Date.parse(to) - Date.parse(from)) / DAY > maxDays) from = addDays(to, -maxDays);
  return { from, to };
}
async function rows(env, type, from, to, limit = 2000) {
  const r = await env.DB.prepare('SELECT id, day, data FROM summaries WHERE user_id = ?1 AND type = ?2 AND day >= ?3 AND day <= ?4 ORDER BY day, start, id LIMIT ?5').bind(OWNER, type, from, to, limit).all();
  return r.results.map(x => JSON.parse(x.data));
}
const mean = a => { const v = a.filter(x => typeof x === 'number' && isFinite(x)); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 10) / 10 : undefined; };
const sum = a => Math.round(a.filter(x => typeof x === 'number').reduce((s, x) => s + x, 0) * 10) / 10;
const dateArgs = { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD, default 7 days ago' }, to: { type: 'string', description: 'YYYY-MM-DD, default today' } } };

export const TOOLS = [
  {
    name: 'get_activities',
    description: 'Workouts between two dates (runs, rides, walks, strength…): km, minutes, pace (min/km), heart rate (bpm), cadence, climb, Garmin training load and training effect, VO2 max, minutes in each HR zone.',
    inputSchema: { ...dateArgs, properties: { ...dateArgs.properties, type: { type: 'string', description: 'Optional filter, e.g. "running"' } } },
    async run(env, a) {
      const { from, to } = range(a, 7);
      let list = (await rows(env, 'activities', from, to)).map(N.activity);
      if (a?.type) list = list.filter(x => (x.type || '').includes(String(a.type).toLowerCase()));
      return { from, to, count: list.length, total_km: sum(list.map(x => x.km)), total_min: sum(list.map(x => x.min)), activities: list };
    },
  },
  {
    name: 'get_activity',
    description: 'One workout in detail: everything from get_activities plus interval/run/walk splits, recovery HR, grade-adjusted pace, RPE, stamina, Body Battery change, and the planned workout steps if it was a structured workout.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Activity id from get_activities' } }, required: ['id'] },
    async run(env, a) {
      const id = String(a?.id || '').replace(/\D/g, '');
      if (!id) return { error: 'Give an activity id from get_activities.' };
      const row = await env.DB.prepare("SELECT data FROM summaries WHERE user_id = ?1 AND type = 'activities' AND id = ?2").bind(OWNER, id).first();
      const d = await activityDetail(env, id);
      const base = row ? N.activity(JSON.parse(row.data)) : N.clean({ id, name: d.detail?.activityName, type: d.detail?.activityTypeDTO?.typeKey, date: d.detail?.summaryDTO?.startTimeLocal?.slice(0, 10) });
      return { ...base, ...N.activityDetail(d.detail, d.workouts) };
    },
  },
  {
    name: 'get_daily',
    description: 'Daily totals per day: steps, km, calories, resting/min/max heart rate, intensity minutes, floors, stress, Body Battery high/low, respiration, SpO2.',
    inputSchema: dateArgs,
    async run(env, a) { const { from, to } = range(a, 7); return { from, to, days: (await rows(env, 'dailies', from, to)).map(N.daily) }; },
  },
  {
    name: 'get_sleep',
    description: 'Sleep per night: total, deep, light, REM and awake minutes, sleep score and quality, bed and wake time (local), sleeping HR, stress, respiration, SpO2.',
    inputSchema: dateArgs,
    async run(env, a) {
      const { from, to } = range(a, 7);
      const nights = (await rows(env, 'sleep', from, to)).map(N.sleep).filter(n => n.total_min);
      return { from, to, avg_total_min: mean(nights.map(n => n.total_min)), avg_score: mean(nights.map(n => n.score)), nights };
    },
  },
  {
    name: 'get_hrv',
    description: 'Overnight heart-rate variability per night (ms): last-night average, 5-minute high, 7-day average, Garmin HRV status and your balanced baseline range.',
    inputSchema: dateArgs,
    async run(env, a) { const { from, to } = range(a, 7); const nights = (await rows(env, 'hrv', from, to)).map(N.hrv); return { from, to, avg_ms: mean(nights.map(n => n.last_night_avg_ms)), nights }; },
  },
  {
    name: 'get_body_battery_stress',
    description: 'Stress (0-100) and Body Battery (0-100) per day: average/max stress, minutes at rest/low/medium/high stress, Body Battery charged, drained, high, low, start and end, Garmin feedback and what drained or charged it.',
    inputSchema: dateArgs,
    async run(env, a) {
      const { from, to } = range(a, 7);
      const bb = new Map((await rows(env, 'bodyBattery', from, to)).map(b => [b.date, N.bodyBattery(b)]));
      const days = (await rows(env, 'dailies', from, to)).map(N.daily).map(d => N.clean({
        date: d.date, avg_stress: d.avg_stress, max_stress: d.max_stress, stress_qualifier: d.stress_qualifier, rest_min: d.rest_min, low_stress_min: d.low_stress_min, medium_stress_min: d.medium_stress_min, high_stress_min: d.high_stress_min,
        body_battery: N.clean({ ...(bb.get(d.date) || {}), high: d.body_battery_high ?? bb.get(d.date)?.high, low: d.body_battery_low ?? bb.get(d.date)?.low, charged: d.body_battery_charged ?? bb.get(d.date)?.charged, drained: d.body_battery_drained ?? bb.get(d.date)?.drained, end: d.body_battery_end ?? bb.get(d.date)?.end, date: undefined }),
      }));
      for (const [date, b] of bb) if (!days.some(d => d.date === date)) days.push({ date, body_battery: { ...b, date: undefined } });
      return { from, to, days: days.sort((x, y) => x.date.localeCompare(y.date)) };
    },
  },
  {
    name: 'get_training',
    description: 'Fitness and training load: latest VO2 max (from your runs/rides), fitness age, Garmin training load for the last 7 days vs the 4-week average, weekly km/minutes/sessions, training-effect labels, and your HR zones. Training Readiness and Training Status are not in Garmin\'s Personal API.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'Last day, default today' } } },
    async run(env, a) {
      const { to } = range(a, 28);
      const acts = (await rows(env, 'activities', addDays(to, -27), to)).map(N.activity);
      const vo2 = (await rows(env, 'activities', addDays(to, -180), to)).map(N.activity).filter(x => x.vo2max).map(x => ({ date: x.date, type: x.type, vo2max: x.vo2max }));
      const weeks = [0, 1, 2, 3].map(w => {
        const end = addDays(to, -7 * w), start = addDays(end, -6), list = acts.filter(x => x.date >= start && x.date <= end);
        return N.clean({ from: start, to: end, sessions: list.length, km: sum(list.map(x => x.km)), min: Math.round(sum(list.map(x => x.min))), load: Math.round(sum(list.map(x => x.training_load))), hard_sessions: list.filter(x => (x.aerobic_te || 0) >= 3.5 || (x.anaerobic_te || 0) >= 2).length });
      });
      const avg4 = Math.round(sum(weeks.map(w => w.load || 0)) / 4);
      const labels = {};
      for (const x of acts) if (x.te_label) labels[x.te_label] = (labels[x.te_label] || 0) + 1;
      const zones = (await rows(env, 'hrZones', '2000-01-01', '2999-12-31'))[0]?.list;
      const fa = (await rows(env, 'fitnessAge', addDays(to, -30), to)).at(-1);
      return N.clean({
        to,
        vo2max_latest: vo2.at(-1), vo2max_history: vo2.length > 1 ? vo2.filter((v, i) => i === 0 || v.vo2max !== vo2[i - 1].vo2max) : undefined,
        fitness_age: fa ? N.fitnessAge(fa.value) : undefined,
        load_last_7d: weeks[0].load ?? 0, load_4wk_weekly_avg: avg4,
        load_ratio: avg4 ? Math.round((weeks[0].load || 0) / avg4 * 100) / 100 : undefined,
        load_note: 'Garmin activity training load (EPOC). Ratio ~0.8-1.3 = steady; above 1.5 = a big jump.',
        weeks, training_effect_labels_28d: Object.keys(labels).length ? labels : undefined,
        hr_zones: zones ? N.hrZones(zones) : undefined,
        not_available: "Training Readiness and Training Status aren't offered by Garmin's Personal API.",
      });
    },
  },
  {
    name: 'get_body',
    description: 'Weight and body composition: weight kg, BMI, body fat %, body water %, muscle and bone kg.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'Default 90 days ago' }, to: { type: 'string' } } },
    async run(env, a) {
      const { from, to } = range(a, 90);
      const list = (await rows(env, 'weight', from, to)).map(N.weight);
      return { from, to, count: list.length, latest: list.at(-1), measurements: list, ...(list.length ? {} : { note: 'No weight entries in Garmin Connect for this range.' }) };
    },
  },
  {
    name: 'get_summary',
    description: 'Last 7 days at a glance (or any number of days): workouts, km, training load, sleep, HRV, resting HR, stress, Body Battery, VO2 max and weight, compared with the period before. Start here.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', description: 'Default 7' }, to: { type: 'string', description: 'Last day, default today' } } },
    async run(env, a) {
      const n = Math.max(1, Math.min(90, parseInt(a?.days, 10) || 7));
      const to = isDate(a?.to) ? a.to : iso(Date.now() + DAY / 2);
      const period = async (start, end) => {
        const acts = (await rows(env, 'activities', start, end)).map(N.activity);
        const days = (await rows(env, 'dailies', start, end)).map(N.daily);
        const sleep = (await rows(env, 'sleep', start, end)).map(N.sleep).filter(s => s.total_min);
        const hrv = (await rows(env, 'hrv', start, end)).map(N.hrv);
        const runs = acts.filter(x => /run/.test(x.type || ''));
        return N.clean({
          from: start, to: end, workouts: acts.length, workout_min: sum(acts.map(x => x.min)), training_load: Math.round(sum(acts.map(x => x.training_load))),
          runs: runs.length, run_km: sum(runs.map(x => x.km)), longest_run_km: runs.length ? Math.max(...runs.map(x => x.km || 0)) : undefined,
          avg_steps: mean(days.map(d => d.steps)), avg_resting_hr_bpm: mean(days.map(d => d.resting_hr_bpm)), avg_stress: mean(days.map(d => d.avg_stress)),
          avg_body_battery_high: mean(days.map(d => d.body_battery_high)), avg_body_battery_low: mean(days.map(d => d.body_battery_low)),
          avg_sleep_min: mean(sleep.map(s => s.total_min)), avg_sleep_score: mean(sleep.map(s => s.score)),
          avg_hrv_ms: mean(hrv.map(h => h.last_night_avg_ms)), hrv_status_latest: hrv.at(-1)?.status,
          days_with_data: days.length,
        });
      };
      const now = await period(addDays(to, -(n - 1)), to);
      const before = await period(addDays(to, -(2 * n - 1)), addDays(to, -n));
      const vo2 = (await rows(env, 'activities', addDays(to, -180), to)).map(N.activity).filter(x => x.vo2max).at(-1);
      const w = (await rows(env, 'weight', addDays(to, -90), to)).map(N.weight).at(-1);
      const recent = (await rows(env, 'activities', addDays(to, -(n - 1)), to)).map(N.activity).slice(-12)
        .map(x => N.clean({ id: x.id, date: x.date, type: x.type, name: x.name, km: x.km, min: x.min, pace_min_km: x.pace_min_km, avg_hr_bpm: x.avg_hr_bpm, te_label: x.te_label }));
      return N.clean({ period: now, previous_period: before, latest_vo2max: vo2 ? { date: vo2.date, vo2max: vo2.vo2max } : undefined, latest_weight: w, workouts: recent });
    },
  },
  {
    name: 'get_status',
    description: 'Whether the Garmin key works, when data was last synced, and which dates are stored. Use it when data seems missing.',
    inputSchema: { type: 'object', properties: {} },
    async run(env) {
      const types = (await env.DB.prepare('SELECT type, COUNT(*) AS n, MIN(day) AS first, MAX(day) AS last FROM summaries WHERE user_id = ?1 GROUP BY type').bind(OWNER).all()).results;
      const last = +(await getMeta(env, 'last_sync')) || 0;
      return N.clean({ key_error: await getMeta(env, 'key_error'), last_sync: last ? new Date(last).toISOString() : 'never', last_sync_result: await getMeta(env, 'last_sync_result'), stored: types });
    },
  },
];

// Runs a tool, refreshing recent data first if it's stale (a sync failure doesn't block the answer).
export async function runTool(env, tool, args) {
  let note;
  if (tool.name !== 'get_status') {
    try { const r = await syncIfStale(env); if (r?.errors.length) note = `Couldn't refresh from Garmin just now (${r.errors[0]}); showing stored data.`; } catch (e) { note = `Couldn't refresh from Garmin just now (${e.message}); showing stored data.`; }
  }
  const out = await tool.run(env, args || {});
  return note ? { ...out, note } : out;
}
